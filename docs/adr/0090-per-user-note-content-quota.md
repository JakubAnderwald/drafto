# 0090 — Per-User Note Content Quota in the Database

- **Status**: Accepted
- **Date**: 2026-11-21
- **Authors**: Jakub Anderwald

## Context

Every signup waits for an admin to approve it ([ADR-0019](./0019-email-infrastructure-and-approval-flow.md)). [ADR-0072](./0072-per-user-attachment-storage-quota.md) capped attachment storage per user, which removed the main reason for that gate. Approval still capped one thing nothing else did: note text. Drafto runs on the Supabase free plan, whose 500 MB database is shared by every account. Note content had no per-user limit, and every content edit copies the old content into `note_content_history` for 30 days ([ADR-0022](./0022-note-content-history.md)). An account scripted through PostgREST, an API key or MCP could fill the database by writing large notes, or by rewriting one in a loop.

Notes reach the database the same two ways attachments do. The web app and MCP go through API routes. Mobile and desktop push WatermelonDB changes straight to PostgREST with the user's JWT, in one `upsert` per table. So the limit has to live in the database.

On 2026-11-21 production held 39 profiles. The heaviest account had 1.5 MB of note content (notes plus history), the median 5 KB, and the largest single note 29.5 KB; the whole database was 21.5 MB.

This is the guardrail that lets signup drop manual approval; that change is a separate decision.

## Decision

Enforce a per-user note content quota in the database (`supabase/migrations/20261121000001_per_user_content_quota.sql`):

- **The quota is a column**: `profiles.content_quota_bytes bigint`, default 26,214,400 (25 MB, `DEFAULT_CONTENT_QUOTA_BYTES`). `NULL` means unlimited. The migration sets every admin to `NULL`. 25 MB is about 16 times the heaviest current account: an abuse ceiling, not a product limit. Admins raise it per user on the admin page.
- **Usage is `sum(pg_column_size(notes.content))`** for the user, trashed notes included, until a note is deleted permanently or the trash cron purges it.
- **A `BEFORE INSERT OR UPDATE OF content` trigger on `notes`** (`enforce_note_content_quota`) refuses a write that grows a note past the quota. It raises `P0001` with the message `content_quota_exceeded` (`CONTENT_QUOTA_EXCEEDED_CODE`) and puts `used_bytes=… quota_bytes=…` in `detail`.
  - A write that doesn't grow the note always passes, so a user over the quota can still edit down, trash and delete. An update whose content is unchanged returns at once: mobile and desktop send content with every update, including trash, rename and move. Whether a note grows is judged on its text length, old against new, because the stored old value may be compressed while `NEW` isn't.
  - A create that mobile or desktop re-send after a lost response (an `INSERT … ON CONFLICT DO UPDATE` of a row the server has) is skipped on the INSERT path and checked on the UPDATE path, so the note isn't counted twice.
  - It takes a per-user advisory lock, like the storage trigger.
  - It returns early for a row filed under another user's id, so RLS refuses that row without the trigger revealing the other user's usage.
  - Triggers on the same event fire in name order, so it runs before `on_notes_content_archive` and a refused update archives nothing.
- **History is capped, not counted.** Users can't delete their history, so counting it would refuse a heavy editor who has no way to free space. Instead, `archive_note_content()` now deletes the user's oldest versions once their history exceeds their content quota. It sums the user's history on every archived save and prunes, newest first along a new `(user_id, archived_at desc, id desc)` index, only when the sum is over the cap. Unlimited users keep 30 days of all of it, as before. So one account's notes plus history are bounded at twice its quota.
- **The privilege guard grows a column.** `guard_profile_privilege_columns()` now also rejects a non-admin change to `content_quota_bytes`.
- **The read RPCs mirror the storage ones** and return rows of the same shape: `get_my_content_usage()` (the caller only) and `admin_content_usage()` (admins only, `42501` otherwise). The per-user helper `content_usage_bytes(uid)` is revoked from the API roles.
- **The clients explain a refusal.**
  - The web API answers a refusal with a 413 carrying `code: "content_quota_exceeded"`. MCP returns a tool error.
  - Mobile and desktop retry a refused notes batch one row at a time. Every note that fits still syncs, the refused ones stay local and unsynced, and the user sees the "Notes full" message.
  - Every platform shows a "Notes: X MB of Y MB used" line next to the storage line.
  - Messages live in `packages/shared/src/storage/content-quota.ts`.
- **ADR-0072's signed-URL gap is now watched.** `storage_quota_overruns()` (service role only) lists users whose stored attachment objects exceed their storage quota plus 50 MB. The daily `/api/cron/cleanup-trash` reports them to Sentry, so an admin can act. The gap itself stays accepted.

## Consequences

- **Positive**:
  - No single account can fill the shared database with note text or history, whichever route it writes by.
  - Admins can change any account's limit without a migration.
  - Together with ADR-0072 this covers the two shared resources an account can grow without bound, so manual approval is no longer what protects them.
- **Negative**:
  - Every write that grows a note sums the user's note sizes, and every content save by a capped user sums their history. Each is one index scan over that user's rows: a few milliseconds at today's sizes, inside the save's transaction. A running counter would remove it (see Alternatives).
  - `pg_column_size` of `NEW` in a BEFORE trigger is the uncompressed size, because the row isn't stored yet, while the stored notes count at their on-disk (possibly compressed) size. So a large note being written is slightly overcounted. This only matters within a few KB of the quota.
  - Older mobile and desktop builds don't know the refusal. Their whole notes push fails and keeps retrying, so their other notes stop syncing too, until the user frees space or updates. Only an account at its quota is affected, and the quota is far above real use.
  - A capped heavy editor can lose versions sooner than 30 days. The privacy policy says so.
  - Someone made an admin later keeps the 25 MB default until an admin picks Unlimited for them.
- **Neutral**: Note titles, notebooks and attachment rows aren't counted. They are bounded by their own length limits and by the attachment quota.

## Alternatives Considered

- **Count history in the quota.** Rejected: users can't delete history, so a refusal would be one they can't fix. Capping history at the quota bounds it just as well.
- **A per-note size limit only.** Rejected: it doesn't bound an account that writes many notes.
- **Enforce in the web API only.** Rejected for the same reason as in ADR-0072: mobile and desktop write straight to PostgREST.
- **A running byte counter on `profiles`, maintained by triggers.** It would make each check O(1). Rejected for now: it needs triggers on insert, update and delete plus every cascade, and it can drift. Today's per-user note counts make the sum cheap.
- **Turnstile captcha on signup instead.** Supabase's captcha is project-wide: it would also require a token on password sign-in and reset, locking out every shipped mobile and desktop build. It also doesn't stop an approved or scripted account from writing.
