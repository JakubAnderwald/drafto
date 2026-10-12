# Editor

**Status:** shipped **Updated:** 2026-10-12

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
- **Mobile/desktop layout**:
  - **Stylesheets.** Each app's stylesheet ships through `CoreBridge.configureCSS`, which TenTap injects together with every bridge's own CSS (image max-width, blockquote, task list, placeholder). Never pass `injectedJavaScript` to `<RichText>`: it replaces TenTap's script, and that script is what installs those styles.
  - **Gutter.** The body gets a horizontal-only gutter in line with the title (`EDITOR_LAYOUT_CSS`). TenTap owns `padding-bottom`.
  - **Mobile keyboard.** The `KeyboardAvoidingView` is offset by the header height (`useHeaderHeight`), and TenTap's `avoidIosKeyboard` is off, so the body is lifted once rather than padded twice. Its behaviour is `padding` on iOS and `height` on Android: Android runs edge-to-edge, so the window no longer shrinks for the keyboard.
  - **Mobile toolbar.** The toolbar theme (`src/lib/editor-theme.ts`) pins the formatting toolbar to a fixed 44 pt row on the screen's surface colour. It is rendered last, below the attachment row, so with the keyboard up it sits directly on the keyboard.
  - **Mobile header.** The editor header has no title (the title field is the title), and its back label is fixed to "Notes". The notebook screen's header shows the notebook's name.

## Code paths

| Concern                                        | Path                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Web editor wrapper                             | `apps/web/src/components/editor/note-editor.tsx`                                                       |
| Web editor panel (title + status + fetch)      | `apps/web/src/components/notes/note-editor-panel.tsx`                                                  |
| Web auto-save hook                             | `apps/web/src/hooks/use-auto-save.ts`                                                                  |
| Web attachment URL resolver                    | `apps/web/src/components/editor/use-attachment-url-resolver.ts`                                        |
| Mobile editor screen                           | `apps/mobile/app/notes/[id].tsx`                                                                       |
| Mobile editor component                        | `apps/mobile/src/components/editor/note-editor.tsx`                                                    |
| Mobile attachment picker                       | `apps/mobile/src/components/editor/attachment-picker.tsx`                                              |
| Mobile editor CSS and toolbar theme            | `apps/mobile/src/lib/editor-css.ts`, `apps/mobile/src/lib/editor-theme.ts`                             |
| Desktop editor CSS and bridge extensions       | `apps/desktop/src/lib/editor-css.ts`, `apps/desktop/src/components/editor/editor-bridge-extensions.ts` |
| Mobile auto-save hook                          | `apps/mobile/src/hooks/use-auto-save.ts`                                                               |
| Desktop editor component                       | `apps/desktop/src/components/editor/note-editor.tsx`                                                   |
| Desktop editor panel                           | `apps/desktop/src/components/notes/note-editor-panel.tsx`                                              |
| Desktop auto-save hook                         | `apps/desktop/src/hooks/use-auto-save.ts`                                                              |
| Shared format converter (BlockNote ↔ TipTap)   | `packages/shared/src/editor/format-converter.ts`                                                       |
| Shared Markdown converter (MCP, import paths)  | `packages/shared/src/editor/markdown-converter.ts`                                                     |
| Shared text extractor (search)                 | `packages/shared/src/editor/extract-text.ts`                                                           |
| Shared attachment URL helpers                  | `packages/shared/src/editor/attachment-url.ts`, `resolve-urls.ts`                                      |
| Shared types (`BlockNoteBlock`, `TipTapDoc`)   | `packages/shared/src/editor/types.ts`                                                                  |
| Shared no-op save guard (mobile, desktop)      | `packages/shared/src/editor/content-save-guard.ts`                                                     |
| Shared constants (`DEBOUNCE_MS`, title limits) | `packages/shared/src/constants.ts`                                                                     |
| Note read with content migration               | `apps/web/src/app/api/notes/[id]/route.ts`                                                             |
| Auto-save unit tests                           | `apps/web/__tests__/unit/use-auto-save.test.ts`, `apps/desktop/__tests__/hooks/use-auto-save.test.ts`  |
| Mobile auto-save unit tests                    | `apps/mobile/__tests__/hooks/use-auto-save.test.ts`                                                    |
| Web editor integration tests                   | `apps/web/__tests__/integration/note-editor.test.tsx`, `note-editor-panel.test.tsx`                    |
| Shared editor tests                            | `packages/shared/src/editor/__tests__/markdown-converter.test.ts`, `extract-text.test.ts`              |
| Mobile editor screen test                      | `apps/mobile/__tests__/screens/editor.test.tsx`                                                        |
| Mobile editor layout test (header, keyboard)   | `apps/mobile/__tests__/screens/editor-layout.test.tsx`                                                 |

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
