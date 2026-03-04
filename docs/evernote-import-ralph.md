# Evernote Import Feature — Implementation Plan (Ralph Loop Edition)

## Context

Users migrating from Evernote need a way to import their existing notes into Drafto. Evernote exports notes as `.enex` files (XML format containing notes with ENML content, metadata, and base64-encoded attachments). This feature adds an import flow that converts `.enex` files into Drafto notebooks and notes with full attachment support.

Additionally, the app currently lacks a central app menu — there's no logout button, settings access, etc. This feature also introduces an **app menu** (hamburger dropdown) in the sidebar footer that houses "Import from Evernote", "Log out", and can be extended with future settings.

**Architecture:** Client-side XML parsing (browser `DOMParser`) + batched API calls (≤5 notes per batch) to avoid Vercel's 4.5MB body limit and enable progress feedback. Server converts ENML→BlockNote blocks using `linkedom`, uploads attachments to Supabase Storage.

---

**RALPH LOOP RULES (STRICT):**
You are running in an autonomous, unattended loop. On every single execution, you MUST follow these exact steps in order:

1. **Identify:** Scan the Progress Tracker below and find the _first_ unchecked task `[ ]`.
2. **Scope:** DO NOT attempt multiple tasks. Focus ONLY on that single task.
3. **Implement:** Write the code to satisfy the task's requirements.
4. **Test**: Run the full test suite strictly in CI mode to prevent interactive prompts or watch-mode hangs. Execute exactly this chain: CI=true pnpm test -- --run && CI=true pnpm test:e2e && pnpm lint && pnpm exec tsc --noEmit.
5. **Fix:** If _any_ test or check fails, you must debug, fix the code, and re-run the suite until it is 100% green. Do not proceed until all tests pass.
6. **Record:** Check off the task in this file by changing `[ ]` to `[x]`.
7. **Commit:** Commit and push your changes to git with a descriptive message using the /push protocol. Merge changes to main if CI checks are all resolved and comments replied to.
8. **Exit:** EXIT immediately so the loop can restart with a fresh context window. DO NOT start the next task.

---

## Progress Tracker

### Phase 1: Foundation (Types, Dependency, Parser)

- [ ] 1.1 — Add `linkedom` dependency + shared import types
- [ ] 1.2 — Client-side `.enex` parser + unit tests
- [ ] 1.3 — Server-side ENML→BlockNote converter + unit tests
- [ ] 1-CP — **Checkpoint**: full suite green
- [ ] 1-PUSH — **Push**: `/push` to PR

### Phase 2: API Route

- [ ] 2.1 — Import API route (`POST /api/import/evernote`) + unit tests
- [ ] 2-CP — **Checkpoint**: full suite green
- [ ] 2-PUSH — **Push**: `/push` to PR

### Phase 3: UI Components

- [ ] 3.1 — App menu component + integration tests
- [ ] 3.2 — Import dialog component + integration tests
- [ ] 3.3 — Wire into app-shell (replace ThemeToggle footer, add import dialog state)
- [ ] 3-CP — **Checkpoint**: full suite green
- [ ] 3-PUSH — **Push**: `/push` to PR

### Phase 4: E2E, ADR & Docs

- [ ] 4.1 — E2E test with fixture `.enex` file
- [ ] 4.2 — ADR `0006-evernote-import.md` + update ADR index
- [ ] 4.3 — Update README.md with import feature documentation
- [ ] 4-CP — **Checkpoint**: full suite green
- [ ] 4-PUSH — **Push**: `/push` to PR

---

## Key Architectural Decisions

- **Client-side XML parsing + batched API calls**: Avoids Vercel's 4.5MB body limit, enables progress feedback
- **`linkedom` over `jsdom`**: ~40KB vs heavy `jsdom` — lightweight enough for production serverless functions
- **Server-side ENML conversion**: Keeps conversion logic secure and consistent; client only parses XML structure
- **Batch size of 5 notes**: Balance between progress granularity and request overhead

---

## Phase 1: Foundation (Types, Dependency, Parser)

**Goal:** Set up the data layer — shared types, dependency, and the client-side parser.

### 1.1 — Add `linkedom` dependency + shared import types

**Files:** `src/lib/import/types.ts`

1. Run `pnpm add linkedom` and `pnpm add -D @types/linkedom` (if types exist, otherwise add inline types)
2. Create `src/lib/import/types.ts` with:

```ts
EnexNote { title, content (ENML string), created, updated, resources[] }
EnexResource { data (base64), mime, hash, fileName }
ImportBatchRequest { notebookName?, notebookId?, notes: EnexNote[] }
ImportBatchResult { notebookId, notesImported, notesFailed, errors[] }
```

**Tests:** Type check only (`tsc --noEmit`).

### 1.2 — Client-side `.enex` parser + unit tests

**Files:** `src/lib/import/enex-parser.ts`, `__tests__/unit/enex-parser.test.ts`

- `parseEnexFile(xmlString: string): EnexNote[]`
- Uses browser `DOMParser` to parse XML
- Extracts `<note>` elements: title, content, created/updated timestamps, `<resource>` elements (base64 data, mime, recognition hash, filename)
- Handles missing fields gracefully (defaults)

**Tests:**

- Unit: Parse valid `.enex` XML string → correct `EnexNote[]` output. Parse empty/malformed XML → empty array or graceful defaults. Parse notes with multiple resources. Parse notes with missing optional fields.

### 1.3 — Server-side ENML→BlockNote converter + unit tests

**Files:** `src/lib/import/enml-to-blocknote.ts`, `__tests__/unit/enml-to-blocknote.test.ts`

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

**Tests:**

- Unit: Convert paragraphs, headings, lists, checkboxes, inline styles, links, images (with URL map), tables. Empty/malformed ENML → fallback paragraph block.

---

## Phase 2: API Route

**Goal:** Build the server-side import endpoint.

### 2.1 — Import API route + unit tests

**Files:** `src/app/api/import/evernote/route.ts`, `__tests__/unit/import-evernote-api.test.ts`

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

**Reuse:** Follow attachment upload pattern from `src/app/api/notes/[id]/attachments/route.ts`.

**Tests:**

- Unit: Mock Supabase — test notebook creation, note insertion, attachment upload, partial failure handling, auth error responses.

---

## Phase 3: UI Components

**Goal:** Build the user-facing import UI and app menu.

### 3.1 — App menu component + integration tests

**Files:** `src/components/layout/app-menu.tsx`, `__tests__/integration/app-menu.test.tsx`

- Replaces the bare `ThemeToggle` in the sidebar footer
- Uses existing `DropdownMenu`, `DropdownMenuItem`, `DropdownMenuSeparator` components
- Menu items: **Import from Evernote**, **Theme toggle** (inline), **Log out** (danger variant)
- Logout calls `supabase.auth.signOut()` then redirects to `/login`

**Reuse:** `src/components/ui/dropdown-menu.tsx`, `src/components/ui/icon-button.tsx`, `src/lib/supabase/client.ts`, `src/lib/handle-auth-error.ts`

**Tests:**

- Integration: Render menu, verify items present. Click "Log out" → calls `signOut`. Click "Import from Evernote" → fires callback.

### 3.2 — Import dialog component + integration tests

**Files:** `src/components/import/import-evernote-dialog.tsx`, `__tests__/integration/import-evernote-dialog.test.tsx`

- Modal dialog (similar pattern to `ConfirmDialog`)
- File picker accepting `.enex`
- Input for notebook name (defaults to filename without `.enex`)
- Progress state: "Parsing file..." → "Importing note X of Y" → "Done" / "Completed with N errors"
- Client logic: read file as text → `parseEnexFile()` → batch into groups of 5 → POST each batch sequentially → aggregate results

**Reuse:** `Button` (with loading), `Input`, `Badge` components.

**Tests:**

- Integration: Render dialog, select file, mock API calls, verify progress states, verify completion message. Test error state display.

### 3.3 — Wire into app-shell

**Files:** `src/components/layout/app-shell.tsx`, `src/components/notebooks/notebooks-sidebar.tsx`

- Replace the sidebar footer `ThemeToggle` with `AppMenu`
- Add state for `showImportDialog`
- Pass `onImportComplete` callback to refresh notebooks and select the imported one
- Add `onImportComplete` prop to `notebooks-sidebar.tsx` to refresh notebook list after import

**Tests:** Existing integration tests should still pass. Verify in checkpoint.

---

## Phase 4: E2E, ADR & Docs

**Goal:** End-to-end testing, documentation, and architecture decision record.

### 4.1 — E2E test with fixture `.enex` file

**Files:** `e2e/import.spec.ts`, `e2e/fixtures/sample.enex`

- Create a small sample `.enex` fixture file with 2-3 notes (paragraphs, a heading, a checklist, an image resource)
- E2E test: log in → open app menu → click "Import from Evernote" → upload fixture → verify progress → verify imported notebook appears → verify note content

**Tests:**

- E2E: Full import flow with fixture file.

### 4.2 — ADR `0006-evernote-import.md` + update ADR index

**Files:** `docs/adr/0006-evernote-import.md`, `docs/adr/README.md`

- Copy from `docs/adr/0000-adr-template.md`
- Document: client-side parsing + batched API approach, ENML conversion strategy, `linkedom` choice
- Add to ADR index in `docs/adr/README.md`

### 4.3 — Update README.md

**Files:** `README.md`

- Add import feature to feature list
- Document how to use the import feature

---

## Existing Code to Reuse

| File                                          | What to reuse                                                    |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `src/lib/api/utils.ts`                        | `getAuthenticatedUser()`, `errorResponse()`, `successResponse()` |
| `src/components/ui/dropdown-menu.tsx`         | `DropdownMenu`, `DropdownMenuItem`, `DropdownMenuSeparator`      |
| `src/components/ui/button.tsx`                | `Button` with loading state                                      |
| `src/components/ui/input.tsx`                 | Form input                                                       |
| `src/components/ui/badge.tsx`                 | Status indicators                                                |
| `src/components/ui/icon-button.tsx`           | Menu trigger                                                     |
| `src/lib/supabase/server.ts`                  | Server Supabase client                                           |
| `src/lib/supabase/client.ts`                  | Client Supabase client (for logout)                              |
| `src/lib/handle-auth-error.ts`                | Auth error redirect                                              |
| `src/app/api/notes/[id]/attachments/route.ts` | Attachment upload pattern                                        |

## New Files Summary

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
