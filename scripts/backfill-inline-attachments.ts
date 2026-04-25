/**
 * One-shot backfill for attachments that exist as DB rows but are not
 * referenced anywhere inside their parent note's `content`.
 *
 * Context: before this refactor, the mobile + desktop file picker inserted a
 * row into `public.attachments` but never wrote an inline block into the
 * note's content. After the refactor the per-platform "Attachments" section is
 * removed — so without a backfill those pre-existing attachments become
 * invisible in every client.
 *
 * This script scans every note, collects the `attachment://<file_path>` URLs
 * that already appear inline (image blocks + file blocks + link marks), then
 * appends a block for each attachment row whose `file_path` is missing. It is
 * idempotent — running twice reports 0 inserts.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   pnpm backfill:attachments [--dry-run]
 *
 * The package.json script wires `tsx --tsconfig scripts/tsconfig.json` so the
 * `@drafto/shared` path alias resolves correctly at runtime.
 *
 * Dev project ref:  huhzactreblzcogqkbsd
 * Prod project ref: tbmjbxxseonkciqovnpl
 */

import { createClient } from "@supabase/supabase-js";
import { toAttachmentUrl, isAttachmentUrl } from "@drafto/shared";
import type { BlockNoteBlock, BlockNoteInlineContent } from "@drafto/shared";

interface AttachmentRow {
  id: string;
  note_id: string;
  file_path: string;
  file_name: string;
  mime_type: string;
}

interface NoteRow {
  id: string;
  content: unknown;
  updated_at: string;
}

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function collectInlineAttachmentUrls(content: unknown): Set<string> {
  const found = new Set<string>();
  if (!Array.isArray(content)) return found;

  const visit = (blocks: BlockNoteBlock[]): void => {
    for (const block of blocks) {
      const url = block.props?.url;
      if (typeof url === "string" && isAttachmentUrl(url)) found.add(url);
      if (Array.isArray(block.content)) visitInline(block.content as BlockNoteInlineContent[]);
      if (block.children) visit(block.children);
    }
  };

  const visitInline = (inline: BlockNoteInlineContent[]): void => {
    for (const item of inline) {
      if (item.type === "link" && typeof item.href === "string" && isAttachmentUrl(item.href)) {
        found.add(item.href);
      }
      if (item.type === "link" && item.content) visitInline(item.content);
    }
  };

  visit(content as BlockNoteBlock[]);
  return found;
}

function buildBlockForAttachment(a: AttachmentRow): BlockNoteBlock {
  const url = toAttachmentUrl(a.file_path);
  if (isImageMimeType(a.mime_type)) {
    return {
      type: "image",
      props: { url, name: a.file_name },
      children: [],
    };
  }
  return {
    type: "file",
    props: { url, name: a.file_name },
    children: [],
  };
}

async function main() {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const dryRun = process.argv.includes("--dry-run");

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  console.log(`[backfill] target=${supabaseUrl} dry-run=${dryRun}`);

  // Paginate — supabase-js caps per-request rows at 1000 by default. A single
  // silent-truncated fetch would make the backfill skip attachments without any
  // error, leaving orphans on prod forever.
  const PAGE_SIZE = 1000;
  const attachments: AttachmentRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("attachments")
      .select("id, note_id, file_path, file_name, mime_type")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error(`[backfill] Failed to fetch attachments page from=${from}:`, error);
      process.exit(1);
    }
    const rows = (page ?? []) as AttachmentRow[];
    attachments.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  console.log(`[backfill] attachments scanned=${attachments.length}`);

  const byNoteId = new Map<string, AttachmentRow[]>();
  for (const a of attachments) {
    const arr = byNoteId.get(a.note_id) ?? [];
    arr.push(a);
    byNoteId.set(a.note_id, arr);
  }

  let notesScanned = 0;
  let notesUpdated = 0;
  let blocksInserted = 0;
  let errors = 0;

  for (const [noteId, noteAttachments] of byNoteId) {
    notesScanned += 1;

    const { data: note, error: noteError } = await supabase
      .from("notes")
      .select("id, content, updated_at")
      .eq("id", noteId)
      .maybeSingle();

    if (noteError || !note) {
      // If the note was deleted the attachments row cascaded too, so this
      // usually means a transient fetch error — count it and move on.
      console.warn(`[backfill] note ${noteId} fetch failed:`, noteError?.message);
      errors += 1;
      continue;
    }

    const typedNote = note as NoteRow;
    const referenced = collectInlineAttachmentUrls(typedNote.content);
    const missing = noteAttachments.filter((a) => !referenced.has(toAttachmentUrl(a.file_path)));

    if (missing.length === 0) continue;

    const existingBlocks = Array.isArray(typedNote.content)
      ? (typedNote.content as BlockNoteBlock[])
      : [];
    const appended = missing.map(buildBlockForAttachment);
    const nextBlocks = [...existingBlocks, ...appended];

    blocksInserted += missing.length;
    notesUpdated += 1;

    console.log(
      `[backfill] note ${noteId}: appending ${missing.length} block(s) — ${missing
        .map((a) => a.file_name)
        .join(", ")}`,
    );

    if (dryRun) continue;

    // Optimistic concurrency: only update if updated_at hasn't moved since we
    // read it. The live app keeps writing during the run, so a row read here
    // could be overtaken by a real edit before our update lands. Matching on
    // the original updated_at lets PostgREST return 0 affected rows in that
    // case so we can log + skip rather than overwrite a fresher version.
    // Preserving updated_at on the write also keeps the note's modified-time
    // honest — the backfill is a content repair, not a user edit.
    const { data: updateData, error: updateError } = await supabase
      .from("notes")
      .update({
        content: nextBlocks,
        updated_at: typedNote.updated_at,
      })
      .eq("id", noteId)
      .eq("updated_at", typedNote.updated_at)
      .select("id");

    if (updateError) {
      console.error(`[backfill] failed to update note ${noteId}:`, updateError.message);
      errors += 1;
    } else if (!updateData || updateData.length === 0) {
      console.warn(
        `[backfill] note ${noteId}: skipped — concurrent edit detected (updated_at moved); re-run to retry`,
      );
      notesUpdated -= 1;
      blocksInserted -= missing.length;
    }
  }

  console.log(
    `[backfill] done — notes scanned=${notesScanned} notes updated=${notesUpdated} blocks inserted=${blocksInserted} errors=${errors}${
      dryRun ? " (dry-run)" : ""
    }`,
  );
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
