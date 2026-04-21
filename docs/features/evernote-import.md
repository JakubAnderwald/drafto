# Evernote Import

**Status:** shipped **Updated:** 2026-04-21

## What it is

Lets a signed-in user import an Evernote `.enex` export into Drafto as a notebook of notes with attachments preserved. Accessed via the sidebar app menu -> "Import from Evernote".

## Current state

Shipped on the web app. The flow:

1. User picks a `.enex` file from a modal dialog.
2. The browser parses the XML locally (native `DOMParser`) into note records with base64-encoded resources.
3. Notes are sent to `POST /api/import/evernote` in batches of up to 5 — each batch either joins an existing target notebook or (on the first batch) creates one using the user-supplied name (default: filename without `.enex`).
4. Server-side, each note has its resources uploaded to the `attachments` Storage bucket, its ENML converted to BlockNote blocks via `linkedom`, and a note row inserted; attachment rows are inserted alongside.
5. The dialog shows per-batch progress and per-note failures; partial batches keep going and report an error list at the end. On completion the imported notebook is selected in the sidebar.

Batching rationale: Vercel caps request bodies at 4.5 MB. Client-side parse + batched API calls stays under the limit and enables progress feedback.

Platform coverage:

- **Web:** implemented.
- **iOS / Android / macOS:** not available. The dialog, parser, and API route all live in `apps/web`. Mobile and desktop users must import via the web app, after which the notes sync down through the normal Supabase pipeline.

## Code paths

| Concern                                  | Path                                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Import API route                         | `apps/web/src/app/api/import/evernote/route.ts`                  |
| Shared types (`EnexNote`, batch req/res) | `apps/web/src/lib/import/types.ts`                               |
| Client `.enex` XML parser (`DOMParser`)  | `apps/web/src/lib/import/enex-parser.ts`                         |
| Server ENML -> BlockNote converter       | `apps/web/src/lib/import/enml-to-blocknote.ts`                   |
| Import dialog UI                         | `apps/web/src/components/import/import-evernote-dialog.tsx`      |
| App menu entry (triggers dialog)         | `apps/web/src/components/layout/app-menu.tsx`                    |
| Parser unit tests                        | `apps/web/__tests__/unit/enex-parser.test.ts`                    |
| ENML converter unit tests                | `apps/web/__tests__/unit/enml-to-blocknote.test.ts`              |
| API route unit tests                     | `apps/web/__tests__/unit/import-evernote-api.test.ts`            |
| Dialog integration tests                 | `apps/web/__tests__/integration/import-evernote-dialog.test.tsx` |

## Related ADRs

- [0007 — Evernote Import](../adr/0007-evernote-import.md)

## Cross-platform notes

Importer code is web-only. Shared pieces:

- The `attachments` Storage bucket and the `notebooks` / `notes` / `attachments` tables are the same surface every platform reads from — imports show up on mobile and desktop after the next sync.
- Block shape is shared via `@drafto/shared` (same types the web, mobile, and desktop editors render). The converter emits BlockNote blocks that must stay compatible with that shared shape.

## Modifying safely

**Invariants:**

- Batch size is capped at 5 notes server-side (`route.ts` rejects larger batches with 400). Keep the client chunking in the dialog aligned with this limit.
- Parser uses the browser `DOMParser` (client-only). The converter uses `linkedom` (server-side). Do not swap either without re-testing bundle size — `jsdom` was rejected in ADR 0007 for being too heavy.
- Failed notes within a batch must not abort the batch; they surface as entries in `ImportBatchResult.errors`.
- The first batch is the one that creates the notebook (when `notebookId` is absent). Subsequent batches must pass the returned `notebookId` or a fresh notebook will be created per batch.
- Attachment upload uses the same bucket and path conventions as regular note attachments — changing the bucket or path shape requires updating this route in lockstep.
- ENML conversion is best-effort. New BlockNote block types require a matching branch in `convertEnmlToBlocks` or content will be dropped silently.

**Tests that catch regressions:**

- `apps/web/__tests__/unit/enex-parser.test.ts` — .enex XML parsing (notes, resources, tasks, timestamps).
- `apps/web/__tests__/unit/enml-to-blocknote.test.ts` — ENML tag mapping to BlockNote blocks, inline styles, `en-media`, `en-todo`, tables.
- `apps/web/__tests__/unit/import-evernote-api.test.ts` — auth, batch size cap, notebook creation, partial failure behavior.
- `apps/web/__tests__/integration/import-evernote-dialog.test.tsx` — dialog progress states and error aggregation.

**Files that must change together:**

- Changing `EnexNote` / `ImportBatchRequest` / `ImportBatchResult` in `types.ts` requires touching both the parser and the route, plus the dialog that consumes them.
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
