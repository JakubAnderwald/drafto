# Evernote Import

**Status:** shipped **Updated:** 2026-11-09

## What it is

Lets a signed-in user import an Evernote `.enex` export into Drafto as a notebook of notes with attachments preserved. Accessed via the sidebar app menu -> "Import from Evernote".

## Current state

Shipped on the web app. The flow:

1. User picks a `.enex` file from a modal dialog.
2. The browser stream-parses the XML locally (`parseEnexStream`), one note at a time, so very large exports never sit in memory whole.
3. For each note, `POST /api/import/evernote/note` creates an empty note with the original title and timestamps. The first call also creates the target notebook, named by the user (default: filename without `.enex`), and later calls reuse its id.
4. Each of the note's resources is uploaded straight to the `attachments` bucket, as a regular attachment: `upload-url`, a signed upload, then `confirm`, which inserts the `attachments` row. The browser computes each resource's MD5 for the next step.
5. `POST /api/import/evernote/finalize` converts the note's ENML to BlockNote blocks (via `linkedom`), maps each `<en-media hash>` to its `attachment://` URL and writes the content.
6. The dialog shows progress and per-note failures. A failed attachment is recorded and skipped without losing the note's text; a failed note goes on a "Retry failed" list that resumes the same note row. The retry reuses the attachments that attempt already confirmed and uploads only the rest. On completion the imported notebook is selected in the sidebar.

Uploading bytes from the browser straight to Storage keeps every API request small: Vercel caps request bodies at 4.5 MB.

**Storage quota** (issue #794, [ADR-0069](../adr/0069-per-user-attachment-storage-quota.md)). Imported attachments count against the user's attachment storage quota like any other (see [editor](./editor.md), "Storage quota"). The import stops at the first quota refusal, a 413 from `upload-url` or `confirm` whose body carries `code: "storage_quota_exceeded"` (`isStorageQuotaError`):

- Notes already imported stay, with their attachments.
- The current note keeps its text: its remaining attachments are not tried, and it is finalized with the ones already uploaded.
- The remaining notes are not imported. They are not added to the "Retry failed" list, and the import doesn't retry anything, since every further upload would be refused too. When the stop comes during "Retry failed", the retry items after it stay on the list: they failed once already and may have a note row to resume.
- The dialog shows the "Storage full" message (`storageFullMessage`) followed by "The remaining notes weren't imported." It waits for the user to close it before selecting the notebook.

The per-file 50 MB limit is different: an oversized resource is skipped and recorded, and the import goes on.

Platform coverage:

- **Web:** implemented.
- **iOS / Android / macOS:** not available. The dialog, parser, and API route all live in `apps/web`. Mobile and desktop users must import via the web app, after which the notes sync down through the normal Supabase pipeline.

## Code paths

| Concern                                 | Path                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Note-creation API route                 | `apps/web/src/app/api/import/evernote/note/route.ts`                                               |
| Content (finalize) API route            | `apps/web/src/app/api/import/evernote/finalize/route.ts`                                           |
| Attachment upload routes (quota 413s)   | `apps/web/src/app/api/notes/[id]/attachments/upload-url/`, `confirm/`                              |
| Shared types (`EnexNote`, req/res)      | `apps/web/src/lib/import/types.ts`                                                                 |
| Client `.enex` stream parser            | `apps/web/src/lib/import/enex-stream-parser.ts`                                                    |
| Client `.enex` XML parser (`DOMParser`) | `apps/web/src/lib/import/enex-parser.ts`                                                           |
| Server ENML -> BlockNote converter      | `apps/web/src/lib/import/enml-to-blocknote.ts`                                                     |
| Import dialog UI                        | `apps/web/src/components/import/import-evernote-dialog.tsx`                                        |
| App menu entry (triggers dialog)        | `apps/web/src/components/layout/app-menu.tsx`                                                      |
| Parser unit tests                       | `apps/web/__tests__/unit/enex-parser.test.ts`                                                      |
| ENML converter unit tests               | `apps/web/__tests__/unit/enml-to-blocknote.test.ts`                                                |
| API route unit tests                    | `apps/web/__tests__/unit/import-evernote-note-api.test.ts`, `import-evernote-finalize-api.test.ts` |
| Dialog integration tests                | `apps/web/__tests__/integration/import-evernote-dialog.test.tsx`                                   |

## Related ADRs

- [0007 — Evernote Import](../adr/0007-evernote-import.md)
- [0069 — Per-User Attachment Storage Quota in the Database](../adr/0069-per-user-attachment-storage-quota.md)

## Cross-platform notes

Importer code is web-only. Shared pieces:

- The `attachments` Storage bucket and the `notebooks` / `notes` / `attachments` tables are the same surface every platform reads from — imports show up on mobile and desktop after the next sync.
- Block shape is shared via `@drafto/shared` (same types the web, mobile, and desktop editors render). The converter emits BlockNote blocks that must stay compatible with that shared shape.

## Modifying safely

**Invariants:**

- A storage quota refusal stops the whole import at once and keeps what was imported, including the current note's text. Never retry it, and never put the notes a first run didn't reach on the "Retry failed" list. A retry the quota stops keeps its untried items on that list. Tell it apart from the per-file 413 by its `code` (`isStorageQuotaError`), not by the status.
- Parser uses the browser `DOMParser` (client-only). The converter uses `linkedom` (server-side). Do not swap either without re-testing bundle size — `jsdom` was rejected in ADR 0007 for being too heavy.
- Any other failed note must not abort the import; it goes on the "Retry failed" list with its note id, so a retry resumes the same row. The entry also carries the attachments already confirmed on that row (keyed by resource index), and the retry reuses them instead of uploading them again. Their `attachments` rows stay on the note, so a second upload would add duplicate rows that count against the storage quota twice. A finalize request that fails outright (a network error) keeps the note id and the uploads too.
- The first note creates the notebook (when `notebookId` is absent). Every later note must pass the returned `notebookId`, or a fresh notebook is created per note.
- Attachment upload goes through the same `upload-url` / `confirm` routes, bucket and path conventions as regular note attachments, so it meets the same per-file limit and storage quota. Changing the bucket or path shape requires updating the importer in lockstep.
- ENML conversion is best-effort. New BlockNote block types require a matching branch in `convertEnmlToBlocks` or content will be dropped silently.

**Tests that catch regressions:**

- `apps/web/__tests__/unit/enex-parser.test.ts` — .enex XML parsing (notes, resources, tasks, timestamps).
- `apps/web/__tests__/unit/enml-to-blocknote.test.ts` — ENML tag mapping to BlockNote blocks, inline styles, `en-media`, `en-todo`, tables.
- `apps/web/__tests__/unit/import-evernote-note-api.test.ts`, `import-evernote-finalize-api.test.ts` — auth, notebook creation, ENML conversion and attachment mapping.
- `apps/web/__tests__/integration/import-evernote-dialog.test.tsx` — dialog progress states, error aggregation, retry, and the stop on a storage quota refusal.

**Files that must change together:**

- Changing `EnexNote` / `ImportNoteRequest` / `ImportFinalizeRequest` in `types.ts` requires touching the parser and the routes, plus the dialog that consumes them.
- Changing the BlockNote block shape in `packages/shared` requires a matching update to `enml-to-blocknote.ts`.
- Adding a new menu entry alongside "Import from Evernote" means editing `app-menu.tsx` and (if it surfaces a dialog) the app shell state that owns the dialog visibility.

## Verify

```bash
# Unit + integration tests for every piece of the importer.
cd apps/web && pnpm test

# Type + lint.
pnpm lint && pnpm typecheck

# Manual smoke test: export a few notes from Evernote (including one with
# images and one with a checklist), import via the dialog, then open the
# imported notebook and check that titles, inline styles, checklists, and
# images render.
```
