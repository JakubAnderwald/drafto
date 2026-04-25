# 0022 — Note Content History Table

- **Status**: Accepted
- **Date**: 2026-04-25
- **Authors**: Jakub Anderwald

## Context

On 2026-04-24, a race-condition bug in a dev build (PR #323) running against production overwrote a single `notes.content` row with an empty BlockNote document. Recovery was only possible because a snapshot of the WatermelonDB WAL file existed locally on a developer's Mac, and a one-off Python script could extract pre-corruption page versions out of it.

The production Supabase project is on the **Free** tier. Free tier provides:

- **No** scheduled database backups.
- **No** Point-in-Time Recovery (PITR).

That makes the standard Postgres recovery story (PITR + side-restore for individual rows, as written for paid tiers in [`docs/operations/migrations.md`](../operations/migrations.md)) unavailable. Today the only first-party defense against an accidental `UPDATE`-style write is the soft delete on `notes` (which only covers row deletion, not content overwrites). For content overwrites we have nothing — we got lucky once.

Two related choices were raised but not pursued in this ADR:

- Upgrading to Supabase Pro to gain daily backups and PITR. Cost-driven decision; tracked separately. Even with PITR, the per-row recovery flow (restore into a side project, dump, re-insert) is heavier than checking a history table.
- A "soft-delete-on-update" pattern using a parallel `notes_archive` table with full row snapshots and client attribution. Considered, then unified into the history table below to avoid two parallel mechanisms with the same payload.

## Decision

Add a `public.note_content_history` table that captures the prior `content` jsonb every time `notes.content` changes, retained for 30 days.

Implementation (one migration, `supabase/migrations/20260425000001_note_content_history.sql`):

1. **Table** — `note_content_history(id, note_id, user_id, content, content_updated_at, archived_at, archived_by)`. `note_id` cascades from `notes`. `archived_by` is a best-effort client tag from `current_setting('app.client', true)`; clients are not required to set it.
2. **Trigger** — `BEFORE UPDATE ON public.notes` calls `archive_note_content()` (`SECURITY DEFINER`, `plpgsql`). Inserts a row only when `OLD.content IS DISTINCT FROM NEW.content`, so plain title or trash-flag updates don't write history.
3. **RLS** — `SELECT` allowed only for the row's owner (mirrors the `notes` policy). No `INSERT`/`UPDATE`/`DELETE` policies; all writes go through the `SECURITY DEFINER` trigger and the cleanup function.
4. **Retention** — `cleanup_note_content_history()` deletes rows where `archived_at < now() - interval '30 days'`. `pg_cron` runs it daily at 03:15 UTC, mirroring the existing `cleanup-trashed-notes` job at 03:00 UTC.

Also commit `scripts/recover-from-wal.py` — a stdlib-only Python utility that reproduces the 2026-04-24 manual recovery: it parses the WatermelonDB WAL, walks every commit group, and prints each pre-corruption version of a target row. Used only when both server-side defenses fail.

No client schema changes. The trigger fires on the existing `supabase.from('notes').update(...)` path; mobile, desktop, and web don't need to know history exists.

## Consequences

**Positive**

- Single-row content overwrites are recoverable in a 30-day window with one SQL query, on the Free tier, without third-party support involvement.
- The recovery path is the same regardless of whether the overwriter was a buggy client, a misfired migration, or a manual SQL editor mistake — every overwrite goes through the trigger.
- Documenting the WAL script removes the "one developer with shell history" failure mode that would have lost the data on 2026-04-24 if the right Mac wasn't around.

**Negative**

- ~2× storage on the `notes` content footprint at steady state (every changed version retained for 30 days). Acceptable: notes are small (most are a few KB of BlockNote JSON), and storage on Supabase Free has plenty of headroom for a personal-scale app.
- Every `notes.content` UPDATE writes an extra row in `note_content_history`. Editor autosaves are already debounced to ~500 ms; in practice this is one history insert per pause-in-typing, not per keystroke.
- `archived_by` requires clients to opt in via `SET app.client = 'mobile-ios'` to be useful. Until the clients do this, the column is `NULL` for all rows and provides no attribution.

**Neutral**

- Adds a new public table that shows up in any schema-introspection (PostgREST, Supabase dashboard). Users with approved profiles can read their own history rows but not other users'.
- The 30-day retention is asymmetric with PR #323's recovery window: PITR on Pro is 7 days. We're choosing 30 days because storage is cheap and longer windows make UI-driven self-recovery more useful if/when it's built.

## Alternatives Considered

- **Upgrade to Supabase Pro for daily backups + PITR.** A real option, but it changes the cost profile and still doesn't give per-row recovery without a side-restore. The history table is complementary regardless of plan tier; we can adopt it now and revisit Pro on its own merits.
- **Separate `notes_archive` table for soft-delete-on-update with client attribution.** Same payload as the history table, doubled migration/maintenance overhead. Folded the client attribution into `note_content_history.archived_by` instead.
- **Store history rows as a JSON array on `notes` itself.** Simpler to query but harder to retain with TTL semantics; also makes `notes` read paths bigger for no reason. Rejected.
- **Client-side undo only.** Doesn't protect against server-side corruption (the actual 2026-04-24 failure mode was a client _writing_ corruption to the server). Rejected.
- **Capture `archived_by` from `auth.uid()` only.** Already implicit via `user_id`; we want the _client_, not the user. Best-effort session variable is the right place for that.

## Related

- [ADR 0008 — Production Data Safety Guardrails](./0008-production-data-safety-guardrails.md)
- [ADR 0010 — Offline Sync Strategy with WatermelonDB](./0010-offline-sync-strategy.md)
- [`docs/operations/migrations.md`](../operations/migrations.md) — recovery runbook
- [`supabase/migrations/20260425000001_note_content_history.sql`](../../supabase/migrations/20260425000001_note_content_history.sql)
- [`scripts/recover-from-wal.py`](../../scripts/recover-from-wal.py)
- GitHub issue #324, PR #323 (race-condition bug that triggered this work)
