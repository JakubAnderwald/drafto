# 0069 — Per-User Attachment Storage Quota in the Database

- **Status**: Accepted
- **Date**: 2026-11-08
- **Authors**: Drafto dark factory (issue [#794](https://github.com/JakubAnderwald/drafto/issues/794))

## Context

Drafto stores attachments in one Supabase Storage bucket, `attachments`, on the free plan, which allows 1 GB of storage for the whole project. Until now the only limit was per file: the bucket's 50 MB `file_size_limit` (`MAX_FILE_SIZE`). Nothing capped an account's total, so one account could fill the project's storage, and then every user's uploads would fail.

Uploads reach storage by two routes:

- **Web**: the browser asks `POST /api/notes/[id]/attachments/upload-url` for a signed upload URL, uploads to it, then calls `.../confirm`, which inserts the `attachments` row. The Evernote importer uses the same three steps, also from the browser.
- **Mobile and desktop**: the apps are offline-first. A picked file is queued locally, then uploaded with supabase-js straight to Storage under the user's own JWT. The app then upserts the `attachments` row itself (`upsert(rows, { onConflict: "id", ignoreDuplicates: true })`), and retries both steps from its queue. No Drafto server sits in this path.

A rule enforced only in the web API would not cover the second route. The place both routes meet is the database: the `attachments` table and the `storage.objects` policies of the bucket.

## Decision

Enforce a per-user quota in the database (`supabase/migrations/20261108000001_per_user_storage_quota.sql`):

- **The quota is a column**, `profiles.storage_quota_bytes bigint`, default 52,428,800 (50 MB, `DEFAULT_STORAGE_QUOTA_BYTES` in `packages/shared/src/constants.ts`). `NULL` means unlimited. The migration sets every current admin to `NULL`. The column is the only source of truth: being an admin doesn't lift the quota by itself.
- **Usage is `sum(attachments.file_size)`** for the user. Rows on trashed notes count until the note is deleted permanently or the trash cron purges it, either of which cascades its rows.
- **A `BEFORE INSERT` trigger on `public.attachments`** (`enforce_attachment_storage_quota`) refuses a row that would take usage over the quota, raising `P0001` with the message `storage_quota_exceeded` (`STORAGE_QUOTA_EXCEEDED_CODE`). Landing exactly on the quota is allowed. The trigger takes a per-user advisory lock, so two concurrent inserts can't both pass a check that only one of them fits. A row whose `id` already exists is let through untouched: that is the mobile/desktop upsert retry, whose `ON CONFLICT DO NOTHING` inserts nothing, and the trigger fires before the conflict is resolved.
- **The bucket's `INSERT` and `UPDATE` policies** on `storage.objects` also require `public.can_store_attachment()`. It is false once the caller's rows reach the quota, or once their objects under notes they still have reach the quota plus one maximum-size file (50 MB). The object term stops a client that uploads objects and skips the row insert. The one-file slack lets the retry after a partial success (object stored, row insert failed) through: the RLS check runs before Storage's duplicate-object check. The Storage API answers a refusal with "new row violates row-level security policy".
- **The helpers are `SECURITY DEFINER`, and the per-user ones are out of the API roles' reach.** `storage_usage_bytes(uid)` and `storage_object_bytes(uid)` take a user id, so `EXECUTE` on them is revoked from `public`, `anon` and `authenticated`: granted, they would let any user read anyone's usage. The API roles call only no-argument wrappers: `can_store_attachment()`, `get_my_storage_usage()` (the caller's own `{used_bytes, quota_bytes}`) and `admin_storage_usage()` (every profile's usage, raising `42501` unless `public.is_admin()`).
- **The privilege guard is extended.** `guard_profile_privilege_columns()` ([ADR-0055](./0055-profile-privilege-column-guard.md)) now rejects a non-admin change to `storage_quota_bytes` as well as `is_admin` / `is_approved`, so a user can't `PATCH` their own quota to `NULL` with the anon key.
- **Admins edit quotas on the admin page.** `POST /api/admin/storage-quota` (`{userId, quotaMb}`, a positive whole number of MB or `null` for unlimited) updates the column through the admin's own session, under the "Admins can update all profiles" policy.
- **The clients explain a refusal and stop.** The web API answers a quota refusal with a 413 carrying `code: "storage_quota_exceeded"` and the usage numbers. Mobile and desktop put the attachment in a terminal `quota_exceeded` state instead of retrying. Every platform shows the user's usage in its settings. Messages and formatting live in `packages/shared/src/storage/storage-quota.ts`.

## Consequences

- **Positive**: One account can no longer fill the project's storage, whichever route it uploads by. Admins can raise, lower or lift any account's quota without a migration. The clients need no secret and no new server: the database refuses, and they show why.
- **Negative**:
  - `file_size` is supplied by the client. The trigger raises it to the stored object's real size (`storage.objects.metadata->>'size'` for the row's `file_path`, read only from the user's own `{user_id}/` folder, so a row can't name another user's object) when that is larger, and a `NOT VALID` check constraint refuses a negative `file_size`. That leaves only rows whose object isn't there yet, and the object term of `can_store_attachment()` caps such a client at its quota plus 50 MB of objects.
  - BEFORE triggers run before an insert policy's `WITH CHECK`, so the trigger returns early for a row an API user files under someone else's `user_id` (RLS then refuses it). Otherwise the refusal would reveal the other user's usage.
  - The object term counts only objects under notes the user still has. Deleting a note cascades its rows but leaves its objects behind, and SQL can't delete Storage objects. So a client that uploads objects, skips the rows, and then deletes the note escapes the object term. Those orphans are also the reason the term ignores deleted notes, below.
  - Older app builds don't know the `quota_exceeded` state. They keep retrying a refused upload until the user updates, but once at the quota they can't add objects either.
  - Someone made an admin later keeps the 50 MB default until an admin picks Unlimited for them on the admin page.
  - The storage `UPDATE` policy checks the quota too, so an overwrite of an existing object is refused once the user is at the quota. No Drafto client overwrites objects (every upload passes `upsert: false`), so this refuses nothing they do; without it, a client could insert tiny objects and then overwrite each with a 50 MB one.
- **Neutral**: Attachments on trashed notes count until the note is deleted permanently or the trash cron purges it. Either one cascades the note's rows, so emptying the trash frees the space at once. Removing an attachment from a note does not free its bytes, because its row stays until the note is deleted, and no client deletes a single attachment. So the storage-full message tells users to delete notes with attachments and empty the trash.

## Alternatives Considered

- **Enforce the quota only in the web API.** Rejected: mobile and desktop write straight to Supabase Storage and PostgREST under the user's JWT, so a web-only check would not see their uploads.
- **Column privileges instead of the guard trigger.** Revoking `UPDATE (storage_quota_bytes)` from `authenticated` would also stop admins, who change quotas through their own session. ADR-0055 chose the trigger for the same reason.
- **A separate `storage_quotas` table.** It would need its own RLS, grants and a row per user created at signup, for one number per profile. A column on `profiles` gets the default for free and is guarded by the trigger that already guards the other privilege columns.
- **Count every object in the user's folder as usage.** Rejected: the trash cron's purge and the apps' permanent deletes leave the deleted notes' objects behind, and SQL can't remove them. Counting them would refuse uploads from a user who had just emptied the trash to make room.
