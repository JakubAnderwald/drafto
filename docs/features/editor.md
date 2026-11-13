# Editor

**Status:** shipped **Updated:** 2026-11-08

## What it is

The per-note editor where users write rich-text content. Titles and body are saved separately, debounced. Content is persisted as JSON (BlockNote on web, TipTap on mobile/desktop) and round-tripped through a shared converter so every platform can read any note.

## Current state

Shipped on all four platforms.

- **Web**: BlockNote (`@blocknote/react` + `@blocknote/mantine`). Document stored as BlockNote blocks in `notes.content` JSONB.
- **Mobile and desktop**: `@10play/tentap-editor` (TipTap inside a WebView). Documents stored as TipTap JSON strings in the local WatermelonDB `notes.content` column.
- **Auto-save**: title and body each flow through `useAutoSave` with a 500 ms debounce (`DEBOUNCE_MS` from shared). Web PATCHes `/api/notes/:id`; mobile/desktop writes to WatermelonDB and the sync loop propagates ([ADR-0048](../adr/0048-local-writes-trigger-debounced-sync.md)).
- **No-op saves** (mobile and desktop, issue #654): loading a note into TenTap makes it answer with a content-update of its own. The save handlers compare each payload with the stored content and with the note's load baseline (`packages/shared/src/editor/content-save-guard.ts`) and skip a write that would change nothing. A skipped save resolves `false`, so `useAutoSave` stays `"idle"` instead of showing "Saved".
- **Cross-format migration**: `GET /api/notes/:id` defensively converts TipTap → BlockNote on read and persists the repaired shape. Mobile/desktop convert BlockNote → TipTap on read.
- **Markdown conversion** (`packages/shared/src/editor/markdown-converter.ts`) is used by the MCP server for tool I/O and by the Evernote importer's downstream paths.
- **Attachments**: images are uploaded to Supabase Storage via signed URLs and embedded as `attachment://<path>` URIs; the API resolves these to signed URLs on read. On mobile, a picked file is saved locally, then uploaded on its own (`uploadAttachment`), then inserted, and only then is a sync started without waiting for it. "Attachment uploaded" shows only when that upload succeeded.
- **Storage quota** (issue #794, [ADR-0072](../adr/0072-per-user-attachment-storage-quota.md)). Besides the 50 MB per-file limit, each account has a total attachment quota, enforced in the database so that every upload route meets it:
  - **The quota** is `profiles.storage_quota_bytes`: 50 MB by default (`DEFAULT_STORAGE_QUOTA_BYTES`), `NULL` for unlimited. Admins are set to unlimited; someone made an admin later keeps 50 MB until an admin picks Unlimited on the admin page. Only admins can change it (the profile privilege guard rejects anyone else's change with `42501`).
  - **Usage** is `sum(attachments.file_size)` for the user. Attachments on trashed notes still count until the note is deleted permanently (emptying the trash) or the trash cron purges it; both cascade the note's rows. Removing an image or file from a note does not free its bytes: the `attachments` row stays until its note is deleted, and no client deletes a single attachment. To free space, delete notes with attachments and empty the trash.
  - **Enforcement.** A `BEFORE INSERT` trigger on `attachments` refuses a row that would take usage over the quota, with the message `storage_quota_exceeded` (`STORAGE_QUOTA_EXCEEDED_CODE`); landing exactly on the quota is allowed, and an upsert of a row that already exists (the mobile/desktop retry) is let through without counting twice. The bucket's `INSERT` and `UPDATE` policies also require `can_store_attachment()`, so Storage refuses an upload with "new row violates row-level security policy" once the rows reach the quota. Its object term counts only objects under notes the user still has and allows one file (50 MB) of slack, so a client that skips the row insert is stopped at quota + 50 MB. Deleted notes' files don't count; the web app removes them after a web or MCP delete, and daily for the trash purge and mobile/desktop deletes (see [notes-and-notebooks.md](./notes-and-notebooks.md)).
  - **Web.** `upload-url` pre-checks the quota and `confirm` maps the trigger's refusal: both answer `413 {error: STORAGE_QUOTA_EXCEEDED_MESSAGE, code: STORAGE_QUOTA_EXCEEDED_CODE, usedBytes, quotaBytes}`. The per-file 413 has no `code`. The editor and the Evernote import read the 413 with `storageQuotaErrorFromResponse`, and the editor shows the "Storage full" message (`storageFullMessage`) in its banner. On that refusal the editor also takes back the empty image or file block BlockNote made for the upload (`discardRefusedUploadBlock`), so BlockNote's own upload panel doesn't add a generic "Upload failed" beside the banner, and a dropped or pasted file doesn't leave an empty block in the note. It only touches an unfilled placeholder. **Replace** on an image already in the note hands over that image's block, which keeps its file; BlockNote's panel may then show its own "Upload failed" next to the banner. BlockNote converts an empty block in place, keeping its nested children, so such a placeholder turns back into an empty paragraph instead of being removed with them. Other upload failures keep the block, so the user can pick another file.
  - **Mobile and desktop.** A refused upload (the pre-check against `fetchStorageUsage()`, a Storage RLS refusal that a fresh usage reading confirms, or the trigger's error, recognised by `isStorageQuotaError`) puts the attachment in the terminal `quota_exceeded` upload status (`isStorageFull`). It is not retried: the client tries to remove any object it already uploaded and the user sees the "Storage full" message. A failed removal (Storage usually reports it in the result rather than throwing) is logged and doesn't change the outcome: the object stays under its note, counted in the bucket policy's object term but not in usage, until the note is deleted and the orphan sweep removes it. A usage read that hasn't answered within `STORAGE_USAGE_TIMEOUT_MS` (5 s) counts as unknown, so a stalled request never holds up saving a picked file or the upload queue; the database still decides. The local copy is kept, because it is the file's only copy. Desktop's `cleanupOrphanedFiles` keeps every file an attachment record points at, and nothing removes a `quota_exceeded` record early. Sync's server-deletion detection skips attachments that haven't uploaded. Deleting the note from the trash doesn't remove its attachment records on desktop, though deleting its notebook does. So on desktop the copy stays until the notebook is deleted or the user signs out, which deletes every local attachment file. The unsynced-changes count shown before sign-out leaves `quota_exceeded` out, because it can never sync. When the picker's own upload is the one refused, the attachment isn't inserted into the note, so no `attachment://` reference points at a file that never reaches the server. A queued upload refused later (e.g. one picked offline) leaves its reference in the note. They re-attach the file after freeing space.
  - **Usage line.** Every platform shows "Storage: X MB of Y MB used" (`formatStorageUsage`), warning above 90% (`STORAGE_WARNING_RATIO`) and danger at 100%: the web settings page, mobile Settings → Account, and the desktop sidebar footer. Admins see and edit every user's quota on the web admin page (`POST /api/admin/storage-quota`).
- **Mobile/desktop layout**:
  - **Stylesheets.** Each app's stylesheet ships through `CoreBridge.configureCSS`, which TenTap injects together with every bridge's own CSS (image max-width, blockquote, task list, placeholder). Never pass `injectedJavaScript` to `<RichText>`: it replaces TenTap's script, and that script is what installs those styles.
  - **Gutter.** The body gets a horizontal-only gutter in line with the title (`EDITOR_LAYOUT_CSS`). TenTap owns `padding-bottom`.
  - **Mobile keyboard.** The `KeyboardAvoidingView` is offset by the header height (`useHeaderHeight`), and TenTap's `avoidIosKeyboard` is off, so the body is lifted once rather than padded twice. Its behaviour is `padding` on iOS and `height` on Android: Android runs edge-to-edge, so the window no longer shrinks for the keyboard.
  - **Mobile toolbar.** The toolbar theme (`src/lib/editor-theme.ts`) pins the formatting toolbar to a fixed 44 pt row on the screen's surface colour. It is rendered last, below the attachment row, so with the keyboard up it sits directly on the keyboard.
  - **Mobile header.** The editor header has no title (the title field is the title), and its back label is fixed to "Notes". The notebook screen's header shows the notebook's name.

## Code paths

| Concern                                                    | Path                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web editor wrapper                                         | `apps/web/src/components/editor/note-editor.tsx`                                                                                                                                                                                     |
| Web editor panel (title + status + fetch)                  | `apps/web/src/components/notes/note-editor-panel.tsx`                                                                                                                                                                                |
| Web auto-save hook                                         | `apps/web/src/hooks/use-auto-save.ts`                                                                                                                                                                                                |
| Web attachment URL resolver                                | `apps/web/src/components/editor/use-attachment-url-resolver.ts`                                                                                                                                                                      |
| Mobile editor screen                                       | `apps/mobile/app/notes/[id].tsx`                                                                                                                                                                                                     |
| Mobile editor component                                    | `apps/mobile/src/components/editor/note-editor.tsx`                                                                                                                                                                                  |
| Mobile attachment picker                                   | `apps/mobile/src/components/editor/attachment-picker.tsx`                                                                                                                                                                            |
| Mobile editor CSS and toolbar theme                        | `apps/mobile/src/lib/editor-css.ts`, `apps/mobile/src/lib/editor-theme.ts`                                                                                                                                                           |
| Desktop editor CSS and bridge extensions                   | `apps/desktop/src/lib/editor-css.ts`, `apps/desktop/src/components/editor/editor-bridge-extensions.ts`                                                                                                                               |
| Mobile auto-save hook                                      | `apps/mobile/src/hooks/use-auto-save.ts`                                                                                                                                                                                             |
| Desktop editor component                                   | `apps/desktop/src/components/editor/note-editor.tsx`                                                                                                                                                                                 |
| Desktop editor panel                                       | `apps/desktop/src/components/notes/note-editor-panel.tsx`                                                                                                                                                                            |
| Desktop auto-save hook                                     | `apps/desktop/src/hooks/use-auto-save.ts`                                                                                                                                                                                            |
| Shared format converter (BlockNote ↔ TipTap)               | `packages/shared/src/editor/format-converter.ts`                                                                                                                                                                                     |
| Shared Markdown converter (MCP, import paths)              | `packages/shared/src/editor/markdown-converter.ts`                                                                                                                                                                                   |
| Shared text extractor (search)                             | `packages/shared/src/editor/extract-text.ts`                                                                                                                                                                                         |
| Shared attachment URL helpers                              | `packages/shared/src/editor/attachment-url.ts`, `resolve-urls.ts`                                                                                                                                                                    |
| Shared types (`BlockNoteBlock`, `TipTapDoc`)               | `packages/shared/src/editor/types.ts`                                                                                                                                                                                                |
| Shared no-op save guard (mobile, desktop)                  | `packages/shared/src/editor/content-save-guard.ts`                                                                                                                                                                                   |
| Shared constants (`DEBOUNCE_MS`, title limits)             | `packages/shared/src/constants.ts`                                                                                                                                                                                                   |
| Storage quota: migration (column, trigger, policies, RPCs) | `supabase/migrations/20261113000001_per_user_storage_quota.sql`                                                                                                                                                                      |
| Storage quota: shared helpers and messages                 | `packages/shared/src/storage/storage-quota.ts`                                                                                                                                                                                       |
| Storage quota: web API (usage, admin editor, 413s)         | `apps/web/src/app/api/storage-usage/`, `apps/web/src/app/api/admin/storage-quota/`, `apps/web/src/lib/api/storage-quota.ts`, `apps/web/src/app/api/notes/[id]/attachments/upload-url/route.ts`, `.../confirm/route.ts`               |
| Storage quota: web settings and admin page                 | `apps/web/src/components/settings/storage-usage-section.tsx`, `apps/web/src/lib/storage/fetch-storage-usage.ts`, `apps/web/src/app/(app)/admin/admin-storage-list.tsx`                                                               |
| Storage quota: mobile and desktop                          | `apps/{mobile,desktop}/src/lib/data/storage-usage.ts`, `src/lib/data/attachment-queue.ts`, `src/hooks/use-storage-usage.ts`; `apps/mobile/src/components/storage-usage.tsx`, `apps/desktop/src/components/sidebar/storage-usage.tsx` |
| Storage quota: dev live test                               | `scripts/__tests__/storage-quota.live.test.mjs`                                                                                                                                                                                      |
| Note read with content migration                           | `apps/web/src/app/api/notes/[id]/route.ts`                                                                                                                                                                                           |
| Auto-save unit tests                                       | `apps/web/__tests__/unit/use-auto-save.test.ts`, `apps/desktop/__tests__/hooks/use-auto-save.test.ts`                                                                                                                                |
| Mobile auto-save unit tests                                | `apps/mobile/__tests__/hooks/use-auto-save.test.ts`                                                                                                                                                                                  |
| Web editor integration tests                               | `apps/web/__tests__/integration/note-editor.test.tsx`, `note-editor-panel.test.tsx`                                                                                                                                                  |
| Shared editor tests                                        | `packages/shared/src/editor/__tests__/markdown-converter.test.ts`, `extract-text.test.ts`                                                                                                                                            |
| Native editor schema tests (headless)                      | `packages/shared/__tests__/native-editor-schema.test.ts`, `format-converter.test.ts`                                                                                                                                                 |
| Nested-lists device check (local-only)                     | `apps/mobile/e2e/run-nested-lists-e2e.sh`, `08-nested-lists.yaml`                                                                                                                                                                    |
| Mobile editor screen test                                  | `apps/mobile/__tests__/screens/editor.test.tsx`                                                                                                                                                                                      |
| Mobile editor layout test (header, keyboard)               | `apps/mobile/__tests__/screens/editor-layout.test.tsx`                                                                                                                                                                               |

## Related ADRs

- [0003 — BlockNote Editor Configuration](../adr/0003-blocknote-editor-configuration.md)
- [0009 — Mobile App Technology Choices](../adr/0009-mobile-app-technology-choices.md)
- [0015 — Desktop App Technology Choice](../adr/0015-desktop-app-technology-choice.md)
- [0017 — MCP Server for Claude Cowork](../adr/0017-mcp-server-for-claude-cowork.md)
- [0072 — Per-User Attachment Storage Quota in the Database](../adr/0072-per-user-attachment-storage-quota.md)

## Cross-platform notes

- **Two document formats in the wild**: `notes.content` may be BlockNote (from web) or TipTap (from mobile/desktop). The server converts TipTap → BlockNote on `GET /api/notes/:id` and persists the result, so over time notes trend toward BlockNote. Any new reader must handle both.
- **Auto-save hooks diverge** by signature. Web's hook is coupled to `fetch('/api/notes/:id')`; mobile/desktop's hook takes a generic `onSave` callback (WatermelonDB write). Both debounce with `DEBOUNCE_MS = 500`.
- **Attachments** use the `attachment://<path>` scheme everywhere. Web resolves to signed URLs server-side on read and via `useAttachmentUrlResolver` in the editor; mobile uses `resolveTipTapImageUrls`.
- **Attachment storage keys** (`<userId>/<noteId>/<fileName>`) are built by `buildAttachmentStoragePath` in `packages/shared/src/storage/storage-key.ts` on every platform: a storage-safe name plus a `-<timestamp>-<random>` suffix, so two files never share a key. supabase-js puts the key in the request URL unencoded, so a `#` used to cut the stored key short (the row kept the full name, and `remove()` then missed the file), and `%`, `~`, `[`, `{`, `^` failed the upload with a 400. `toStorageSafeFileName` keeps only characters checked to work end to end; widen it only after testing a new character against Storage upload, sign and signed download. The web confirm route rejects a file name that helper would change (`isStorageSafeFileName`).
- **Markdown converter** is the single path for MCP tools, Evernote import output, and any future Markdown-based integration. It does not round-trip losslessly — underline has no Markdown equivalent and is dropped.
- **Nesting between BlockNote and TipTap** (`format-converter.ts`). In TipTap only list items hold nested blocks (`listItem` and `taskItem` are `paragraph block*`). A list item's children stay nested and keep their own type and `checked` state. The children of any other block (paragraph, heading, code block, table, image, file) follow it as siblings, so a native edit flattens that one level without losing content. A code block reached through `children` becomes a paragraph holding its text, and a nested table becomes an empty paragraph, so a native save drops its cells.
- **The native editor has no code block or table node.** Mobile and desktop load tentap's prebuilt WebView bundle, whose schema has no `codeBlock`, `table`, `tableRow` or `tableCell`. Given content with a node it doesn't know, TipTap logs `[tiptap warn]: Invalid content.` and loads an empty document. That is why nested code blocks and tables become paragraphs. Top-level ones are still emitted as their own nodes, so a note that has one opens empty on mobile and desktop: a known, separate bug. `native-editor-schema.test.ts` builds the bundle's schema headlessly and checks the converter's output loads into it, survives an edit, and reads back nested.

## Modifying safely

- Invariants:
  - Titles are capped at `MAX_TITLE_LENGTH = 255` (enforced in `PATCH /api/notes/:id`).
  - Auto-save must be debounced; do not call `save()` directly from `onChange` — use `debouncedSave` / `trigger`.
  - Never write `process.env`; never instantiate Supabase clients inside editor components — use `createClient` from `@/lib/supabase/client`.
  - Content writes go through `migrateSignedUrlsToAttachmentUrls` on the server to avoid stale signed URLs being persisted.
  - `GET /api/notes/:id` persists converted content back to the DB; any new reader that rewrites content must be idempotent with this conversion.
  - The storage quota lives in the database, not in a client. Never hard-code 50 MB, the `storage_quota_exceeded` code or the quota messages: import them from `@drafto/shared`, and keep `DEFAULT_STORAGE_QUOTA_BYTES` in step with the column default. A new upload path must insert its `attachments` row (so the trigger sees it) and recognise the refusal with `isStorageQuotaError`.
  - `quota_exceeded` is terminal on mobile and desktop: the upload queue must never retry it.
- Tests that catch regressions:
  - `apps/web/__tests__/unit/use-auto-save.test.ts` — debounce, concurrent save queuing, unmount flush.
  - `apps/web/__tests__/integration/note-editor.test.tsx`, `note-editor-panel.test.tsx`.
  - `packages/shared/src/editor/__tests__/markdown-converter.test.ts` — BlockNote ↔ Markdown round-trip.
  - `packages/shared/__tests__/format-converter.test.ts`, `native-editor-schema.test.ts` — BlockNote ↔ TipTap, nesting, and what the native editor's schema accepts.
  - `apps/desktop/__tests__/hooks/use-auto-save.test.ts`, `apps/mobile/__tests__/screens/editor.test.tsx`.
  - Storage quota: `packages/shared/__tests__/storage-quota.test.ts`, `apps/web/__tests__/unit/attachments-upload-api.test.ts`, `storage-usage-api.test.ts`, `admin-storage-quota.test.ts`, `apps/{mobile,desktop}/__tests__/lib/attachment-queue.test.ts`, and `scripts/__tests__/storage-quota.live.test.mjs`, which checks the trigger (including the stored object's size replacing a smaller claimed `file_size`), the upsert retry, the storage policies and their object byte count, and the RPC privileges on the **dev** project (`pnpm test:live:supabase -- --only storage-quota`, interactive sessions only; [testing](../architecture/testing.md#dev-live-tests-pnpm-testlivesupabase)).
- Files that must change together:
  - Changing BlockNote block shape → update `packages/shared/src/editor/types.ts`, `format-converter.ts`, `markdown-converter.ts`, `extract-text.ts`, and `apps/web/src/app/api/notes/[id]/route.ts` (defensive conversion).
  - Adding a new attachment type → update `attachment-url.ts`, `resolve-urls.ts`, plus both editor wrappers (web + mobile/desktop).
  - Changing auto-save timing → update `DEBOUNCE_MS` in `packages/shared/src/constants.ts` once; the web hook currently has its own `500` default that should match.

## Verify

```bash
# Shared converters (fast, catches format drift)
cd packages/shared && pnpm test

# Web editor + auto-save
cd apps/web && pnpm test -- use-auto-save note-editor

# E2E edit + sync flows
set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e -- notes.spec.ts cross-platform-sync.spec.ts

# Mobile and desktop
cd apps/mobile && pnpm test
cd apps/desktop && pnpm test

# Storage quota against the dev project (interactive sessions only; creates and deletes users)
pnpm test:live:supabase -- --only storage-quota

# Nested lists on a device (local-only: iOS Simulator with the app installed and signed in)
bash apps/mobile/e2e/run-nested-lists-e2e.sh
```
