# Evernote Import Feature

## Context

Users migrating from Evernote need a way to import their existing notes into Drafto. Evernote exports notes as `.enex` files (XML format containing notes with ENML content, metadata, and base64-encoded attachments). This feature adds an import flow that converts `.enex` files into Drafto notebooks and notes with full attachment support.

Additionally, the app currently lacks a central app menu — there's no logout button, settings access, etc. This feature also introduces an **app menu** (hamburger dropdown) in the sidebar footer that houses "Import from Evernote", "Log out", and can be extended with future settings.

---

## Architecture Overview

```
Client (browser)                              Server (API route)
  |                                               |
  1. User picks .enex file                        |
  2. Parse XML with browser DOMParser             |
  3. Extract notes + base64 attachments           |
  4. Send batches (≤5 notes) to server  --------> 5. Auth check
     POST /api/import/evernote                    6. Create notebook (1st batch)
                                                  7. Per note:
                                                     - Convert ENML → BlockNote blocks
                                                     - Insert note row
                                                     - Upload attachments to Storage
                                                     - Insert attachment records
  8. Show progress per batch <----- return counts
  9. Select imported notebook on completion
```

**Batching rationale:** Vercel has a 4.5MB request body limit. Client-side XML parsing + batched API calls avoids this limit and enables progress feedback.

---

## Implementation Plan

### 1. Add `linkedom` dependency

`pnpm add linkedom` — lightweight server-side DOM parser (~40KB) for ENML→BlockNote conversion in the API route. `jsdom` exists as a devDependency but is too heavy for production.

### 2. Create shared types — `src/lib/import/types.ts`

```ts
EnexNote { title, content (ENML string), created, updated, resources[] }
EnexResource { data (base64), mime, hash, fileName }
ImportBatchRequest { notebookName?, notebookId?, notes: EnexNote[] }
ImportBatchResult { notebookId, notesImported, notesFailed, errors[] }
```

### 3. Client-side .enex parser — `src/lib/import/enex-parser.ts`

- `parseEnexFile(xmlString: string): EnexNote[]`
- Uses browser `DOMParser` to parse XML
- Extracts `<note>` elements: title, content, created/updated timestamps, `<resource>` elements (base64 data, mime, recognition hash, filename)
- Handles missing fields gracefully (defaults)

### 4. Server-side ENML→BlockNote converter — `src/lib/import/enml-to-blocknote.ts`

- `convertEnmlToBlocks(enml: string, attachmentUrlMap: Map<string, string>): Block[]`
- Uses `linkedom` to parse ENML into DOM
- Recursive tree walker mapping:
  - `<div>`, `<p>` → paragraph blocks
  - `<h1>`-`<h3>` → heading blocks
  - `<ul>/<ol>/<li>` → list item blocks
  - `<en-todo>` → checkListItem blocks
  - `<b>/<strong>`, `<i>/<em>`, `<u>`, `<s>` → inline styles
  - `<a>` → link inline content
  - `<en-media type="image/*">` → image blocks (URL from attachmentUrlMap)
  - `<en-media>` (non-image) → file block or paragraph placeholder
  - `<table>` → table blocks
- Returns `[{ type: "paragraph", content: [] }]` for empty/unparseable content

### 5. API route — `src/app/api/import/evernote/route.ts`

- POST handler accepting JSON `ImportBatchRequest`
- Uses `getAuthenticatedUser()`, `errorResponse()`, `successResponse()` from `@/lib/api/utils`
- If no `notebookId`: create notebook via Supabase insert
- For each note in batch:
  1. Upload each resource to Supabase Storage (`attachments` bucket, path: `userId/noteId/filename`)
  2. Build hash→signedURL map
  3. Call `convertEnmlToBlocks()` with ENML + URL map
  4. Insert note row with title, converted content, timestamps
  5. Insert attachment records
- Partial failure: skip failed notes, continue, report errors in response
- Returns `ImportBatchResult`

### 6. App menu component — `src/components/layout/app-menu.tsx`

- Replaces the bare `ThemeToggle` in the sidebar footer
- Uses existing `DropdownMenu`, `DropdownMenuItem`, `DropdownMenuSeparator` components
- Menu items: **Import from Evernote**, **Theme toggle** (inline), **Log out** (danger variant)
- Logout calls `supabase.auth.signOut()` then redirects to `/login`

### 7. Import dialog — `src/components/import/import-evernote-dialog.tsx`

- Modal dialog (similar pattern to `ConfirmDialog`)
- File picker accepting `.enex`
- Input for notebook name (defaults to filename without `.enex`)
- Progress state: "Parsing file..." → "Importing note X of Y" → "Done" / "Completed with N errors"
- Client logic: read file as text → `parseEnexFile()` → batch into groups of 5 → POST each batch sequentially → aggregate results
- Uses existing `Button` (with loading), `Input`, `Badge` components

### 8. Wire into app-shell — modify `src/components/layout/app-shell.tsx`

- Replace the sidebar footer `ThemeToggle` with `AppMenu`
- Add state for `showImportDialog`
- Pass `onImportComplete` callback to refresh notebooks and select the imported one

### 9. ADR — `docs/adr/0006-evernote-import.md`

Document: client-side parsing + batched API approach, ENML conversion strategy, `linkedom` choice.

---

## Files to Create

| File                                                    | Purpose                                    |
| ------------------------------------------------------- | ------------------------------------------ |
| `src/lib/import/types.ts`                               | Shared types                               |
| `src/lib/import/enex-parser.ts`                         | Client-side .enex XML parser               |
| `src/lib/import/enml-to-blocknote.ts`                   | Server-side ENML → BlockNote converter     |
| `src/app/api/import/evernote/route.ts`                  | Import API endpoint                        |
| `src/components/layout/app-menu.tsx`                    | App hamburger menu (logout, import, theme) |
| `src/components/import/import-evernote-dialog.tsx`      | Import modal UI                            |
| `docs/adr/0006-evernote-import.md`                      | Architecture decision record               |
| `__tests__/unit/enml-to-blocknote.test.ts`              | Converter unit tests                       |
| `__tests__/unit/enex-parser.test.ts`                    | Parser unit tests                          |
| `__tests__/unit/import-evernote-api.test.ts`            | API route unit tests                       |
| `__tests__/integration/import-evernote-dialog.test.tsx` | Dialog integration tests                   |
| `__tests__/integration/app-menu.test.tsx`               | App menu integration tests                 |
| `e2e/import.spec.ts`                                    | E2E test with fixture .enex file           |
| `e2e/fixtures/sample.enex`                              | Small test fixture                         |

## Files to Modify

| File                                             | Change                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `src/components/layout/app-shell.tsx`            | Replace ThemeToggle footer with AppMenu, add import dialog state  |
| `src/components/notebooks/notebooks-sidebar.tsx` | Add `onImportComplete` prop to refresh notebook list after import |
| `README.md`                                      | Document import feature                                           |
| `docs/adr/README.md`                             | Add ADR 0006 to index                                             |

## Existing Code to Reuse

- `src/lib/api/utils.ts` — `getAuthenticatedUser()`, `errorResponse()`, `successResponse()`
- `src/components/ui/dropdown-menu.tsx` — `DropdownMenu`, `DropdownMenuItem`, `DropdownMenuSeparator`
- `src/components/ui/button.tsx` — `Button` with loading state
- `src/components/ui/input.tsx` — form input
- `src/components/ui/badge.tsx` — status indicators
- `src/components/ui/icon-button.tsx` — menu trigger
- `src/lib/supabase/server.ts` — server Supabase client
- `src/lib/supabase/client.ts` — client Supabase client (for logout)
- `src/lib/handle-auth-error.ts` — auth error redirect
- Attachment upload pattern from `src/app/api/notes/[id]/attachments/route.ts`

---

## Verification

1. **Unit tests:** `pnpm test -- enml-to-blocknote enex-parser import-evernote-api`
2. **Integration tests:** `pnpm test -- import-evernote-dialog app-menu`
3. **Type check:** `pnpm exec tsc --noEmit`
4. **Lint/format:** `pnpm lint && pnpm format:check`
5. **Manual test:** Export a few notes from Evernote as .enex, import via the UI, verify content and attachments render correctly in the editor
6. **E2E:** `pnpm test:e2e -- import`
