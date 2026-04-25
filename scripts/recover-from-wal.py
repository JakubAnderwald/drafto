#!/usr/bin/env python3
"""Recover a single column value from a SQLite WAL snapshot.

Last-resort tool for the case where production data has been overwritten and
the only surviving copy is in a client-side WatermelonDB write-ahead log
(typically `~/Library/Containers/eu.drafto.mobile/Data/Documents/watermelon.db-wal`
on macOS). Walks every commit group in the WAL and, for each snapshot of the
target row that the WAL still contains, prints one candidate version. Pick the
right one and feed it back to Supabase as an `UPDATE` statement.

Background: 2026-04-24 incident. A race-condition bug (PR #323) overwrote one
`notes.content` row with an empty BlockNote document. Production was on the
Supabase Free tier (no daily backups, no PITR). The only surviving pre-corruption
copy was in a developer's local WatermelonDB WAL file. This script reproduces
the manual extraction we did during the incident.

See `docs/operations/migrations.md` (Recovery runbook) for the wider workflow,
and ADR 0022 for context.

Defaults target the WatermelonDB `notes` table:
  search column: remote_id (the Supabase UUID)
  output column: content (the BlockNote JSON)

Usage:
  python3 scripts/recover-from-wal.py \\
      --wal ~/drafto-recovery/watermelon.db-wal.snapshot \\
      --db  ~/drafto-recovery/read/watermelon.db \\
      --note-id 4261ef83-3431-4a77-9adc-9251d8b0642c \\
      --output-dir ~/drafto-recovery/

Then, after picking the right candidate JSON by index from the listing, generate
the restore SQL (note: the most recent candidate is often the corruption itself,
so always pick by explicit index rather than recency):
  python3 scripts/recover-from-wal.py \\
      --wal ... --db ... --note-id ... \\
      --emit-sql ~/drafto-recovery/restore.sql \\
      --pick 1
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import sys
from collections import ChainMap
from collections.abc import Mapping
from dataclasses import dataclass

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

WAL_HEADER_SIZE = 32
FRAME_HEADER_SIZE = 24
WAL_MAGIC_LE = 0x377F0682
WAL_MAGIC_BE = 0x377F0683
TABLE_LEAF_PAGE_TYPE = 0x0D


# -----------------------------------------------------------------------------
# Varint + record format helpers
# -----------------------------------------------------------------------------


def read_varint(buf: bytes, offset: int) -> tuple[int, int]:
    """Decode a SQLite varint starting at ``offset``. Returns (value, bytes_read)."""
    value = 0
    for i in range(8):
        byte = buf[offset + i]
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, i + 1
    # 9th byte uses all 8 bits.
    value = (value << 8) | buf[offset + 8]
    return value, 9


def decode_serial(buf: bytes, offset: int, serial_type: int) -> tuple[object, int]:
    """Decode one record-format value. Returns (value, bytes_consumed)."""
    if serial_type == 0:
        return None, 0
    if serial_type == 1:
        return int.from_bytes(buf[offset : offset + 1], "big", signed=True), 1
    if serial_type == 2:
        return int.from_bytes(buf[offset : offset + 2], "big", signed=True), 2
    if serial_type == 3:
        return int.from_bytes(buf[offset : offset + 3], "big", signed=True), 3
    if serial_type == 4:
        return int.from_bytes(buf[offset : offset + 4], "big", signed=True), 4
    if serial_type == 5:
        return int.from_bytes(buf[offset : offset + 6], "big", signed=True), 6
    if serial_type == 6:
        return int.from_bytes(buf[offset : offset + 8], "big", signed=True), 8
    if serial_type == 7:
        return struct.unpack(">d", buf[offset : offset + 8])[0], 8
    if serial_type == 8:
        return 0, 0
    if serial_type == 9:
        return 1, 0
    if serial_type >= 12 and serial_type % 2 == 0:
        n = (serial_type - 12) // 2
        return buf[offset : offset + n], n
    if serial_type >= 13 and serial_type % 2 == 1:
        n = (serial_type - 13) // 2
        return buf[offset : offset + n].decode("utf-8", errors="replace"), n
    raise ValueError(f"unknown serial type {serial_type}")


# -----------------------------------------------------------------------------
# Local-payload size calculation
# -----------------------------------------------------------------------------


def local_payload_size(payload_size: int, page_size: int) -> int:
    """Per https://www.sqlite.org/fileformat.html, table b-tree leaf cell.

    Assumes reserved-space byte == 0 (Drafto/WatermelonDB doesn't customize this).
    """
    u = page_size
    x = u - 35
    if payload_size <= x:
        return payload_size
    m = ((u - 12) * 32 // 255) - 23
    k = m + ((payload_size - m) % (u - 4))
    return k if k <= x else m


# -----------------------------------------------------------------------------
# WAL parser
# -----------------------------------------------------------------------------


@dataclass
class WalFrame:
    index: int  # 0-based
    page_number: int
    db_size_after_commit: int  # 0 for non-commit frames
    page_data: bytes


def parse_wal(path: str) -> tuple[int, list[WalFrame]]:
    with open(path, "rb") as f:
        header = f.read(WAL_HEADER_SIZE)
        if len(header) < WAL_HEADER_SIZE:
            raise ValueError("WAL file truncated (no header)")
        magic, _file_format, page_size, _ckpt_seq, _salt1, _salt2, _csum1, _csum2 = (
            struct.unpack(">IIIIIIII", header)
        )
        if magic not in (WAL_MAGIC_LE, WAL_MAGIC_BE):
            raise ValueError(f"bad WAL magic 0x{magic:08x}")

        frames: list[WalFrame] = []
        idx = 0
        while True:
            fh = f.read(FRAME_HEADER_SIZE)
            if len(fh) < FRAME_HEADER_SIZE:
                break
            page_number, db_size_after_commit = struct.unpack(">II", fh[:8])
            page_data = f.read(page_size)
            if len(page_data) < page_size:
                break
            frames.append(
                WalFrame(
                    index=idx,
                    page_number=page_number,
                    db_size_after_commit=db_size_after_commit,
                    page_data=page_data,
                )
            )
            idx += 1
    return page_size, frames


def commit_group_snapshots(frames: list[WalFrame]) -> list[dict[int, bytes]]:
    """Return one snapshot dict per commit group.

    Each snapshot is the cumulative page-state visible *after* that commit.
    Earlier commits in the WAL stay visible because checkpoint-style overwrites
    only happen via newer frames within the same WAL file.
    """
    snapshots: list[dict[int, bytes]] = []
    state: dict[int, bytes] = {}
    has_uncommitted = False
    for frame in frames:
        state[frame.page_number] = frame.page_data
        has_uncommitted = True
        if frame.db_size_after_commit != 0:
            snapshots.append(dict(state))
            has_uncommitted = False
    if has_uncommitted:
        snapshots.append(dict(state))
    return snapshots


# -----------------------------------------------------------------------------
# B-tree leaf cell parser
# -----------------------------------------------------------------------------


@dataclass
class LeafCell:
    payload_size: int
    rowid: int
    local_payload: bytes
    overflow_page: int  # 0 if no overflow
    columns: list[object]  # decoded record columns (may include partial overflow tail)


def page_is_table_leaf(page: bytes, is_first_page: bool) -> bool:
    # On page 1 (the file header page) the b-tree header sits 100 bytes in.
    header_offset = 100 if is_first_page else 0
    if len(page) < header_offset + 8:
        return False
    return page[header_offset] == TABLE_LEAF_PAGE_TYPE


def parse_leaf_page(
    page: bytes,
    page_size: int,
    is_first_page: bool,
) -> list[LeafCell]:
    header_offset = 100 if is_first_page else 0
    page_type = page[header_offset]
    if page_type != TABLE_LEAF_PAGE_TYPE:
        return []
    cell_count = int.from_bytes(page[header_offset + 3 : header_offset + 5], "big")
    cells: list[LeafCell] = []
    for i in range(cell_count):
        ptr_offset = header_offset + 8 + 2 * i
        if ptr_offset + 2 > len(page):
            break
        cell_offset = int.from_bytes(page[ptr_offset : ptr_offset + 2], "big")
        if cell_offset == 0 or cell_offset >= len(page):
            continue
        try:
            payload_size, n1 = read_varint(page, cell_offset)
            rowid, n2 = read_varint(page, cell_offset + n1)
            local_size = local_payload_size(payload_size, page_size)
            payload_start = cell_offset + n1 + n2
            local_payload = page[payload_start : payload_start + local_size]
            overflow_page = 0
            if payload_size > local_size:
                overflow_page = int.from_bytes(
                    page[payload_start + local_size : payload_start + local_size + 4],
                    "big",
                )
            cells.append(
                LeafCell(
                    payload_size=payload_size,
                    rowid=rowid,
                    local_payload=local_payload,
                    overflow_page=overflow_page,
                    columns=[],
                )
            )
        except (IndexError, ValueError):
            continue
    return cells


def follow_overflow_chain(
    first_page: int,
    pages: Mapping[int, bytes],
    page_size: int,
    needed: int,
) -> bytes:
    """Read up to ``needed`` bytes from the overflow chain starting at first_page."""
    out = bytearray()
    page_num = first_page
    while page_num and len(out) < needed:
        page = pages.get(page_num)
        if page is None:
            break
        next_page = int.from_bytes(page[:4], "big")
        chunk = page[4 : 4 + min(page_size - 4, needed - len(out))]
        out.extend(chunk)
        page_num = next_page
    return bytes(out)


def decode_record(payload: bytes) -> list[object] | None:
    """Decode SQLite record-format payload into column values."""
    try:
        header_len, n = read_varint(payload, 0)
        if header_len > len(payload):
            return None
        serial_types: list[int] = []
        offset = n
        while offset < header_len:
            st, m = read_varint(payload, offset)
            serial_types.append(st)
            offset += m
        values: list[object] = []
        data_offset = header_len
        for st in serial_types:
            value, consumed = decode_serial(payload, data_offset, st)
            data_offset += consumed
            values.append(value)
        return values
    except (IndexError, ValueError):
        return None


# -----------------------------------------------------------------------------
# Schema introspection
# -----------------------------------------------------------------------------


def schema_columns(db_path: str, table: str) -> list[str]:
    """Use sqlite3 (stdlib) to read the column order for ``table``."""
    import sqlite3

    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return [row[1] for row in rows]


def db_pages(db_path: str, page_size: int) -> dict[int, bytes]:
    """Return the main DB's pages as a fallback page source (for overflow chains
    that begin in WAL pages but extend onto pages that were never re-written
    in this WAL)."""
    pages: dict[int, bytes] = {}
    with open(db_path, "rb") as f:
        page_num = 1
        while True:
            page = f.read(page_size)
            if len(page) < page_size:
                break
            pages[page_num] = page
            page_num += 1
    return pages


# -----------------------------------------------------------------------------
# Main extraction flow
# -----------------------------------------------------------------------------


@dataclass
class Candidate:
    snapshot_index: int  # commit group index in the WAL (0-based)
    rowid: int
    columns: list[object]
    content: str | None
    content_updated_at: int | None  # raw int from updated_at column (epoch ms)
    digest: str  # sha1 of content for dedup


def extract_candidates(
    wal_path: str,
    db_path: str | None,
    note_id: str,
    table: str,
    id_column: str,
    content_column: str,
    updated_at_column: str | None,
) -> list[Candidate]:
    page_size, frames = parse_wal(wal_path)

    if db_path:
        cols = schema_columns(db_path, table)
    else:
        # Fall back to the documented WatermelonDB notes layout.
        cols = [
            "id",
            "_changed",
            "_status",
            "remote_id",
            "notebook_id",
            "user_id",
            "title",
            "content",
            "is_trashed",
            "trashed_at",
            "created_at",
            "updated_at",
        ]

    if id_column not in cols:
        raise SystemExit(f"id-column {id_column!r} not found in schema {cols}")
    if content_column not in cols:
        raise SystemExit(f"content-column {content_column!r} not found in schema {cols}")

    id_idx = cols.index(id_column)
    content_idx = cols.index(content_column)
    updated_idx = cols.index(updated_at_column) if updated_at_column in cols else None

    # Use the live DB pages as a fallback source for overflow chains.
    fallback_pages: dict[int, bytes] = db_pages(db_path, page_size) if db_path else {}
    # Build the page-lookup map once. ChainMap consults the per-snapshot dict
    # first and only falls back to the (potentially large) DB page map on miss
    # — avoids reallocating the merged dict for every commit group.

    snapshots = commit_group_snapshots(frames)
    print(
        f"WAL {wal_path}: page_size={page_size}, frames={len(frames)}, "
        f"commit_groups={len(snapshots)}",
        file=sys.stderr,
    )

    target_bytes = note_id.encode()
    seen: dict[str, Candidate] = {}

    for snap_idx, snap in enumerate(snapshots):
        # Cheap pre-filter: only consider pages whose bytes contain the note ID.
        candidate_pages = [
            (pn, page) for pn, page in snap.items() if target_bytes in page
        ]
        # Snapshot WAL pages overlay the fallback DB pages without copying.
        merged_pages = ChainMap(snap, fallback_pages)

        for page_num, page in candidate_pages:
            is_first = page_num == 1
            cells = parse_leaf_page(page, page_size, is_first)
            for cell in cells:
                full_payload = cell.local_payload
                if cell.payload_size > len(full_payload) and cell.overflow_page:
                    needed = cell.payload_size - len(full_payload)
                    full_payload = full_payload + follow_overflow_chain(
                        cell.overflow_page, merged_pages, page_size, needed
                    )
                if len(full_payload) < cell.payload_size:
                    continue
                full_payload = full_payload[: cell.payload_size]
                values = decode_record(full_payload)
                if values is None or len(values) <= max(id_idx, content_idx):
                    continue
                row_id_val = values[id_idx]
                if row_id_val != note_id:
                    continue
                content_val = values[content_idx]
                if isinstance(content_val, bytes):
                    content_val = content_val.decode("utf-8", errors="replace")
                if not isinstance(content_val, str):
                    continue
                updated_val = (
                    values[updated_idx]
                    if updated_idx is not None and updated_idx < len(values)
                    else None
                )
                if not isinstance(updated_val, (int, float)):
                    updated_val = None
                digest = hashlib.sha1(
                    content_val.encode(), usedforsecurity=False
                ).hexdigest()
                if digest in seen:
                    continue
                seen[digest] = Candidate(
                    snapshot_index=snap_idx,
                    rowid=cell.rowid,
                    columns=values,
                    content=content_val,
                    content_updated_at=int(updated_val) if updated_val is not None else None,
                    digest=digest,
                )

    candidates = list(seen.values())
    candidates.sort(
        key=lambda c: (c.content_updated_at or 0, c.snapshot_index),
        reverse=True,
    )
    return candidates


# -----------------------------------------------------------------------------
# SQL output
# -----------------------------------------------------------------------------


def make_dollar_tag(content: str) -> str:
    """Pick a dollar-quote tag that doesn't appear in ``content``."""
    base = "drafto_restore"
    candidate = base
    counter = 0
    while f"${candidate}$" in content:
        counter += 1
        candidate = f"{base}_{counter}"
    return candidate


def emit_sql(note_id: str, content: str, table_fqn: str = "public.notes") -> str:
    tag = make_dollar_tag(content)
    return (
        f"-- Restore note {note_id} from WAL recovery (see ADR 0022).\n"
        f"-- Generated by scripts/recover-from-wal.py.\n"
        f"update {table_fqn}\n"
        f"   set content = ${tag}${content}${tag}$::jsonb,\n"
        f"       updated_at = now()\n"
        f" where id = '{note_id}'\n"
        f"returning id, length(content::text) as content_len, updated_at;\n"
    )


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Recover a column value for a single row from a SQLite WAL.",
    )
    parser.add_argument("--wal", required=True, help="Path to the .db-wal snapshot.")
    parser.add_argument(
        "--db",
        help=(
            "Path to the companion .db snapshot (used for schema introspection "
            "and overflow-page fallback). Recommended."
        ),
    )
    parser.add_argument(
        "--note-id", required=True, help="Value of --id-column to search for."
    )
    parser.add_argument("--table", default="notes", help="SQLite table name.")
    parser.add_argument(
        "--id-column",
        default="remote_id",
        help="Column whose value matches --note-id (WatermelonDB stores the "
        "Supabase UUID in remote_id).",
    )
    parser.add_argument(
        "--content-column",
        default="content",
        help="Column to extract.",
    )
    parser.add_argument(
        "--updated-at-column",
        default="updated_at",
        help="Optional column used to sort candidates (latest first).",
    )
    parser.add_argument(
        "--output-dir",
        help="Write each candidate's content as a JSON file in this directory.",
    )
    parser.add_argument(
        "--emit-sql",
        help="Path to write the restore SQL to, using the candidate selected by --pick.",
    )
    parser.add_argument(
        "--pick",
        type=int,
        help=(
            "Index (from the candidate listing above) to use with --emit-sql. "
            "REQUIRED when --emit-sql is set: the most-recent candidate is "
            "often the corruption you're trying to undo, so the human picks."
        ),
    )
    parser.add_argument(
        "--table-fqn",
        default="public.notes",
        help="Fully qualified destination table name in the SQL output.",
    )
    args = parser.parse_args(argv)

    if args.emit_sql and not UUID_RE.match(args.note_id):
        print(
            f"--note-id {args.note_id!r} is not a UUID; refusing to emit SQL.",
            file=sys.stderr,
        )
        return 2

    candidates = extract_candidates(
        wal_path=args.wal,
        db_path=args.db,
        note_id=args.note_id,
        table=args.table,
        id_column=args.id_column,
        content_column=args.content_column,
        updated_at_column=args.updated_at_column,
    )

    if not candidates:
        print(f"No candidate versions of {args.note_id!r} found in WAL.", file=sys.stderr)
        return 1

    print(
        f"Found {len(candidates)} unique pre-corruption versions of {args.note_id}",
        file=sys.stderr,
    )
    for i, c in enumerate(candidates):
        ts = c.content_updated_at
        ts_human = ""
        if ts:
            from datetime import datetime, timezone

            try:
                ts_human = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat()
            except (OSError, OverflowError, ValueError):
                ts_human = ""
        content_len = len(c.content) if c.content else 0
        print(
            f"  [{i}] commit_group={c.snapshot_index} rowid={c.rowid} "
            f"content_len={content_len} updated_at={ts} {ts_human}",
            file=sys.stderr,
        )

    if args.output_dir:
        os.makedirs(args.output_dir, exist_ok=True)
        for i, c in enumerate(candidates):
            out_path = os.path.join(args.output_dir, f"candidate-{i:02d}.json")
            with open(out_path, "w") as f:
                f.write(c.content or "")
            print(f"  wrote {out_path}", file=sys.stderr)

    if args.emit_sql:
        if args.pick is None:
            print(
                "--emit-sql requires --pick <index>. The most-recent candidate "
                "is often the corruption itself; pick by index from the list above.",
                file=sys.stderr,
            )
            return 2
        if not 0 <= args.pick < len(candidates):
            print(
                f"--pick {args.pick} out of range (0..{len(candidates) - 1})",
                file=sys.stderr,
            )
            return 2
        chosen = candidates[args.pick]
        sql = emit_sql(args.note_id, chosen.content or "", args.table_fqn)
        with open(args.emit_sql, "w") as f:
            f.write(sql)
        print(
            f"Wrote restore SQL to {args.emit_sql} "
            f"(candidate [{args.pick}], content_len={len(chosen.content or '')})",
            file=sys.stderr,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
