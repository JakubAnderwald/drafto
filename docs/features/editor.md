# Editor

**Status:** shipped  **Updated:** 2026-04-21

## What it is

The per-note editor where users write rich-text content. Titles and body are saved separately, debounced. Content is persisted as JSON (BlockNote on web, TipTap on mobile/desktop) and round-tripped through a shared converter so every platform can read any note.

## Current state

Shipped on all four platforms.

- **Web**: BlockNote (`@blocknote/react` + `@blocknote/mantine`). Document stored as BlockNote blocks in `notes.content` JSONB.
- **Mobile and desktop**: `@10play/tentap-editor` (TipTap inside a WebView). Documents stored as TipTap JSON strings in the local WatermelonDB `notes.content` column.
- **Auto-save**: title and body each flow through `useAutoSave` with a 500 ms debounce (`DEBOUNCE_MS` from shared). Web PATCHes `/api/notes/:id`; mobile/desktop writes to WatermelonDB and the sync loop propagates.
- **Cross-format migration**: `GET /api/notes/:id` defensively converts TipTap → BlockNote on read and persists the repaired shape. Mobile/desktop convert BlockNote → TipTap on read.
- **Markdown conversion** (`packages/shared/src/editor/markdown-converter.ts`) is used by the MCP server for tool I/O and by the Evernote importer's downstream paths.
- **Attachments**: images are uploaded to Supabase Storage via signed URLs and embedded as `attachment://<path>` URIs; the API resolves these to signed URLs on read.

## Code paths

| Concern                                        | Path                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Web editor wrapper                             | `apps/web/src/components/editor/note-editor.tsx`                                            |
| Web editor panel (title + status + fetch)      | `apps/web/src/components/notes/note-editor-panel.tsx`                                       |
| Web auto-save hook                             | `apps/web/src/hooks/use-auto-save.ts`                                                       |
| Web attachment URL resolver                    | `apps/web/src/components/editor/use-attachment-url-resolver.ts`                             |
| Mobile editor screen                           | `apps/mobile/app/notes/[id].tsx`                                                            |
| Mobile editor component                        | `apps/mobile/src/components/editor/note-editor.tsx`                                         |
| Mobile attachment picker + list                | `apps/mobile/src/components/editor/attachment-picker.tsx`, `attachment-list.tsx`            |
| Mobile auto-save hook                          | `apps/mobile/src/hooks/use-auto-save.ts`                                                    |
| Desktop editor component                       | `apps/desktop/src/components/editor/note-editor.tsx`                                        |
| Desktop editor panel                           | `apps/desktop/src/components/notes/note-editor-panel.tsx`                                   |
| Desktop auto-save hook                         | `apps/desktop/src/hooks/use-auto-save.ts`                                                   |
| Shared format converter (BlockNote ↔ TipTap)   | `packages/shared/src/editor/format-converter.ts`                                            |
| Shared Markdown converter (MCP, import paths)  | `packages/shared/src/editor/markdown-converter.ts`                                          |
| Shared text extractor (search)                 | `packages/shared/src/editor/extract-text.ts`                                                |
| Shared attachment URL helpers                  | `packages/shared/src/editor/attachment-url.ts`, `resolve-urls.ts`                           |
| Shared types (`BlockNoteBlock`, `TipTapDoc`)   | `packages/shared/src/editor/types.ts`                                                       |
| Shared constants (`DEBOUNCE_MS`, title limits) | `packages/shared/src/constants.ts`                                                          |
| Note read with content migration               | `apps/web/src/app/api/notes/[id]/route.ts`                                                  |
| Auto-save unit tests                           | `apps/web/__tests__/unit/use-auto-save.test.ts`, `apps/desktop/__tests__/hooks/use-auto-save.test.ts` |
| Web editor integration tests                   | `apps/web/__tests__/integration/note-editor.test.tsx`, `note-editor-panel.test.tsx`         |
| Shared editor tests                            | `packages/shared/src/editor/__tests__/markdown-converter.test.ts`, `extract-text.test.ts`   |
| Mobile editor screen test                      | `apps/mobile/__tests__/screens/editor.test.tsx`                                             |

## Related ADRs

- [0003 — BlockNote Editor Configuration](../adr/0003-blocknote-editor-configuration.md)
- [0009 — Mobile App Technology Choices](../adr/0009-mobile-app-technology-choices.md)
- [0015 — Desktop App Technology Choice](../adr/0015-desktop-app-technology-choice.md)
- [0017 — MCP Server for Claude Cowork](../adr/0017-mcp-server-for-claude-cowork.md)

## Cross-platform notes

- **Two document formats in the wild**: `notes.content` may be BlockNote (from web) or TipTap (from mobile/desktop). The server converts TipTap → BlockNote on `GET /api/notes/:id` and persists the result, so over time notes trend toward BlockNote. Any new reader must handle both.
- **Auto-save hooks diverge** by signature. Web's hook is coupled to `fetch('/api/notes/:id')`; mobile/desktop's hook takes a generic `onSave` callback (WatermelonDB write). Both debounce with `DEBOUNCE_MS = 500`.
- **Attachments** use the `attachment://<path>` scheme everywhere. Web resolves to signed URLs server-side on read and via `useAttachmentUrlResolver` in the editor; mobile uses `resolveTipTapImageUrls`.
- **Markdown converter** is the single path for MCP tools, Evernote import output, and any future Markdown-based integration. It does not round-trip losslessly — underline has no Markdown equivalent and is dropped.

## Modifying safely

- Invariants:
  - Titles are capped at `MAX_TITLE_LENGTH = 255` (enforced in `PATCH /api/notes/:id`).
  - Auto-save must be debounced; do not call `save()` directly from `onChange` — use `debouncedSave` / `trigger`.
  - Never write `process.env`; never instantiate Supabase clients inside editor components — use `createClient` from `@/lib/supabase/client`.
  - Content writes go through `migrateSignedUrlsToAttachmentUrls` on the server to avoid stale signed URLs being persisted.
  - `GET /api/notes/:id` persists converted content back to the DB; any new reader that rewrites content must be idempotent with this conversion.
- Tests that catch regressions:
  - `apps/web/__tests__/unit/use-auto-save.test.ts` — debounce, concurrent save queuing, unmount flush.
  - `apps/web/__tests__/integration/note-editor.test.tsx`, `note-editor-panel.test.tsx`.
  - `packages/shared/src/editor/__tests__/markdown-converter.test.ts` — BlockNote ↔ Markdown round-trip.
  - `apps/desktop/__tests__/hooks/use-auto-save.test.ts`, `apps/mobile/__tests__/screens/editor.test.tsx`.
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
```
