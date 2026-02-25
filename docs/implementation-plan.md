# Drafto — Implementation Plan

**Based on:** PRD v1.0 (2026-02-24)
**Approach:** Vertical slicing — each phase delivers a working, testable feature end-to-end.
**Rule:** After each phase, run the full test suite (`pnpm test`, `pnpm test:e2e`, `pnpm lint`, `tsc --noEmit`) and fix all failures before moving to the next phase.

---

## Progress Tracker

Check off each item as it is completed. Update this section at the end of every work session.

### Phase 0: Foundation & Infrastructure

- [x] 0.1 — Tighten environment validation (required vars, skipValidation for CI)
- [x] 0.2 — Supabase schema & migrations (profiles, notebooks, notes, attachments, RLS, trigger)
- [x] 0.3 — Auth middleware guard (redirect unauthenticated/unapproved users)
- [x] 0.4 — API route conventions (auth helper, error format, ADR)
- [x] 0.5a — CI: add `pnpm audit` step
- [x] 0.5b — CI: add mobile viewports to Playwright config
- [x] 0-CP — **Checkpoint**: full suite green

### Phase 1: Authentication

- [x] 1.1a — Signup page + tests
- [x] 1.1b — Login page + tests
- [x] 1.2 — Waiting for approval screen + tests
- [x] 1.3 — Password reset (forgot + reset pages, auth callback) + tests
- [x] 1.4 — Admin approval page + API + tests
- [x] 1.5 — Default notebook creation on first login + tests
- [x] 1-CP — **Checkpoint**: full suite green, signup→approve→login flow verified

### Phase 2: App Shell & Notebooks

- [x] 2.1 — Three-panel layout shell + tests
- [x] 2.2a — Notebook API routes (CRUD) + unit tests
- [x] 2.2b — Notebooks sidebar UI + integration tests
- [ ] 2.3 — E2E: notebook management lifecycle
- [x] 2-CP — **Checkpoint**: full suite green

### Phase 3: Notes — Editor & Auto-save

- [ ] 3.1 — Install & configure BlockNote + wrapper component + tests + ADR
- [ ] 3.2 — Notes API routes (list, create, get, update, soft-delete) + unit tests
- [ ] 3.3 — Note list component + integration tests
- [ ] 3.4 — Auto-save (debounced) + save indicator + tests
- [ ] 3.5 — Note title handling + tests
- [ ] 3.6 — E2E: note editing flow (create, edit, save, reload)
- [ ] 3-CP — **Checkpoint**: full suite green

### Phase 4: Notes — Organization & Trash

- [ ] 4.1 — Move notes between notebooks + tests
- [ ] 4.2 — Trash: soft delete, restore, permanent delete + tests
- [ ] 4.3 — Trash auto-cleanup (30-day cron) + tests
- [ ] 4-CP — **Checkpoint**: full suite green

### Phase 5: File Attachments

- [ ] 5.1 — Supabase Storage bucket + policies
- [ ] 5.2a — Upload API route (25MB limit, auth) + unit tests
- [ ] 5.2b — Editor file integration (inline images, download links) + tests
- [ ] 5.3 — Attachment management (list, delete, cascade) + tests
- [ ] 5-CP — **Checkpoint**: full suite green

### Phase 6: Responsive Design

- [ ] 6.1 — Desktop layout refinement
- [ ] 6.2 — Tablet layout (collapsible sidebar) + tests
- [ ] 6.3 — Mobile layout (single-panel navigation) + tests
- [ ] 6.4 — E2E: responsive flows (mobile + tablet viewports)
- [ ] 6-CP — **Checkpoint**: full suite green (including mobile E2E)

### Phase 7: Polish & Hardening

- [ ] 7.1 — Security audit (RLS, uploads, unapproved users) + tests
- [ ] 7.2 — Edge cases (empty states, long titles, session expiry, etc.)
- [ ] 7.3 — PRD compliance checklist — all items verified
- [ ] 7-FIN — **Final checkpoint**: complete suite green, v1 ready

---

## Phase 0: Foundation & Infrastructure

**Goal:** Establish the security, database, and API foundations that every feature depends on. Nothing user-facing yet, but everything is wired and tested.

### 0.1 Tighten Environment Validation

**File:** `src/env.ts`

- Make `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` required (`z.string().url()` and `z.string().min(1)`)
- Add `skipValidation` flag (controlled by `SKIP_ENV_VALIDATION` env var) so CI builds without secrets still pass
- Update `.env.local.example` to reflect which vars are required vs optional
- **Test:** Unit test that env validation rejects missing required vars

### 0.2 Supabase Schema & Migrations

**Files:** `supabase/migrations/`, type generation

- Initialize Supabase CLI project (`supabase init`)
- Create migration for the full PRD data model (§5.4):
  - `profiles` table (extends `auth.users` — stores `is_approved`, `is_admin`, `display_name`)
  - `notebooks` table (id, user_id, name, created_at, updated_at)
  - `notes` table (id, notebook_id, user_id, title, content as jsonb, is_trashed, trashed_at, created_at, updated_at)
  - `attachments` table (id, note_id, user_id, file_name, file_path, file_size, mime_type, created_at)
- Add RLS policies for every table:
  - Users can only SELECT/INSERT/UPDATE/DELETE their own rows
  - Unapproved users (`is_approved = false`) are blocked from all data tables
  - Admin can read all profiles (for approval flow)
- Create a trigger: on `auth.users` insert → auto-create a `profiles` row with `is_approved = false`
- Generate TypeScript types from schema (`supabase gen types typescript`)
- **Test:** Unit tests for RLS policies (test that user A cannot read user B's data)
- **ADR:** Record the data model and RLS strategy

### 0.3 Auth Middleware Guard

**File:** `src/lib/supabase/middleware.ts`, `middleware.ts`

- Define public routes: `/login`, `/signup`, `/auth/callback`, `/forgot-password`, `/api/health`
- For all other routes: check `supabase.auth.getUser()`
  - No user → redirect to `/login`
  - User exists but `is_approved = false` → redirect to `/waiting-for-approval`
  - Approved user → proceed
- **Test:** Unit test middleware logic with mocked Supabase client

### 0.4 API Route Conventions

**Files:** `src/app/api/`, shared utilities

- Establish the pattern for API routes (per PRD §5.2 — "clean API layer"):
  - All data access via `/api/` routes, never direct Supabase calls from components
  - Consistent error response format: `{ error: string, status: number }`
  - Consistent success response format: resource data directly
  - Auth check helper: shared function to get authenticated user or return 401
- Create `src/lib/api/utils.ts` with `getAuthenticatedUser()` and error response helpers
- **ADR:** Record the API layer pattern and rationale (PRD §5.2 — offline-first path)

### 0.5 CI Improvements

**File:** `.github/workflows/ci.yml`, `playwright.config.ts`

> **Parallelizable:** 0.5a and 0.5b can run as separate tasks simultaneously.

- **(0.5a)** Add `pnpm audit --audit-level=high` step to the lint-and-typecheck job
- **(0.5b)** Add mobile viewport to Playwright config:
  - `Mobile Chrome` project using `devices["Pixel 5"]`
  - `Mobile Safari` project using `devices["iPhone 13"]`
  - These enforce PRD §4.5 responsive requirements in E2E

### Checkpoint

Run full suite: `pnpm lint && pnpm exec tsc --noEmit && pnpm test && pnpm test:e2e`. Fix all failures.

---

## Phase 1: Authentication

**Goal:** Users can sign up, log in, reset their password, and see a waiting-for-approval screen. Admin can approve users. Unauthenticated/unapproved users are blocked from the app.

### 1.1 Auth Pages — Signup & Login

> **Parallelizable:** Signup page (1.1a) and Login page (1.1b) can be built simultaneously by separate agents — they share the same Supabase auth patterns but are independent UI components.

- **(1.1a) Signup page** — `src/app/(auth)/signup/page.tsx`
  - Email + password form
  - Calls Supabase Auth `signUp()`
  - On success → redirect to `/waiting-for-approval`
  - Validation: email format, password min length
  - Link to login page
  - **Tests:** Integration test (form renders, validation works), E2E (full signup flow)

- **(1.1b) Login page** — `src/app/(auth)/login/page.tsx`
  - Email + password form
  - Calls Supabase Auth `signInWithPassword()`
  - On success → redirect to `/` (app)
  - On error → show error message
  - Links to signup and forgot-password pages
  - **Tests:** Integration test (form renders, error states), E2E (login flow)

### 1.2 Waiting for Approval Screen

**File:** `src/app/(auth)/waiting-for-approval/page.tsx`

- Simple screen: "Your account is pending approval. You'll be able to access Drafto once an admin approves your account."
- Logout button
- Middleware redirects here if user is authenticated but not approved
- **Test:** Integration test (renders message), E2E (unapproved user lands here)

### 1.3 Password Reset

**Files:** `src/app/(auth)/forgot-password/page.tsx`, `src/app/(auth)/reset-password/page.tsx`

- Forgot password page: email input → calls `supabase.auth.resetPasswordForEmail()`
- Reset password page: new password form → called from the email link callback
- Auth callback route: `src/app/auth/callback/route.ts` — handles Supabase email confirmations and password reset tokens
- **Tests:** Integration tests for both forms, E2E for the email-link flow (as far as testable without real email)

### 1.4 Admin Approval Page

**File:** `src/app/(app)/admin/page.tsx`

- List of users with `is_approved = false`
- "Approve" button per user → updates `profiles.is_approved = true`
- Only accessible to admin users (`is_admin = true`)
- Middleware or page-level guard: non-admin users get redirected
- API route: `POST /api/admin/approve-user`
- **Tests:** Unit test (API route), integration test (renders list), E2E (approve a user)

### 1.5 Default Notebook Creation

- On first login after approval, create a default "Notes" notebook for the user if they have none
- This can be a server-side check in the app layout or a database trigger
- **Test:** E2E — new approved user sees a "Notes" notebook

### Checkpoint

Run full suite. Fix all failures. Verify: signup → waiting → admin approves → login → sees app with default notebook.

---

## Phase 2: App Shell & Notebooks

**Goal:** The three-panel layout is in place. Users see their notebooks in a sidebar and can create, rename, and delete notebooks.

### 2.1 Three-Panel Layout Shell

**Files:** `src/app/(app)/layout.tsx`, shared layout components

- App layout with three panels: sidebar (notebooks), note list (middle), editor (main area)
- Sidebar component: fixed-width left panel
- Middle panel: note list area (empty for now — "Select a notebook")
- Main panel: editor area (empty for now — "Select a note")
- Use CSS Grid or Flexbox for the layout
- **Test:** Integration test (layout renders three panels)

### 2.2 Notebooks Sidebar & API

> **Parallelizable:** API routes (2.2a) and sidebar UI (2.2b) can be built simultaneously. The UI can use mocked data initially, then wire to the real API.

- **(2.2a) Notebook API routes:**
  - `GET /api/notebooks` — list user's notebooks, sorted by name
  - `POST /api/notebooks` — create notebook (name required)
  - `PATCH /api/notebooks/[id]` — rename notebook
  - `DELETE /api/notebooks/[id]` — delete notebook (only if empty, or warn)
  - All routes use the auth helper from Phase 0.4
  - **Tests:** Unit tests for each API route

- **(2.2b) Notebooks sidebar UI:**
  - Fetches notebooks from API on load
  - Displays list of notebooks
  - "New Notebook" button → inline input or modal → POST to API
  - Right-click or menu → Rename, Delete
  - Active notebook highlighted
  - Clicking a notebook sets it as selected (updates URL or state)
  - **Tests:** Integration tests (renders notebooks, create/rename/delete interactions)

### 2.3 E2E: Notebook Management

- Full E2E flow: login → see default notebook → create a new notebook → rename it → delete it
- **Test:** E2E test covering the complete notebook CRUD lifecycle

### Checkpoint

Run full suite. Fix all failures.

---

## Phase 3: Notes — Editor & Auto-save

**Goal:** Users can create notes, edit them with the BlockNote rich-text editor, and see auto-save working. This is the core product experience.

### 3.1 Install & Configure BlockNote

**Files:** `package.json`, BlockNote wrapper component

- Install `@blocknote/core`, `@blocknote/react`, `@blocknote/mantine` (or shadcn theme)
- Create a wrapper component: `src/components/editor/note-editor.tsx`
  - Accepts initial content (BlockNote JSON) and an `onChange` callback
  - Configures slash commands per PRD §4.3: headings (H1-H3), bullet list, numbered list, checkboxes
  - Supports: bold, italic, underline, strikethrough, inline links
  - Outputs BlockNote JSON (not HTML)
- **Test:** Integration test (editor renders, typing produces onChange calls)
- **ADR:** Record BlockNote configuration decisions (which blocks enabled/disabled, why JSON storage)

### 3.2 Notes API Routes

**Files:** `src/app/api/notes/`

- `GET /api/notebooks/[id]/notes` — list notes in a notebook, sorted by `updated_at` desc
- `POST /api/notebooks/[id]/notes` — create a note (auto-generate title "Untitled")
- `GET /api/notes/[id]` — get a single note with content
- `PATCH /api/notes/[id]` — update note (title, content, notebook_id)
- `DELETE /api/notes/[id]` — soft delete (set `is_trashed = true`, `trashed_at = now()`)
- **Tests:** Unit tests for each route

### 3.3 Note List Component

**File:** `src/components/notes/note-list.tsx`

- When a notebook is selected, fetch its notes from the API
- Display: title, last modified timestamp (relative: "2 hours ago")
- Sorted by last modified (most recent first)
- "New Note" button (+ icon) → creates a note and opens it
- Clicking a note selects it and opens the editor
- Active note highlighted
- **Test:** Integration test (renders notes, selection works)

### 3.4 Auto-save

**File:** `src/hooks/use-auto-save.ts` (or within the editor wrapper)

- Debounce editor changes (500ms per PRD §5.1)
- On debounce trigger → `PATCH /api/notes/[id]` with current content
- Visual indicator: "Saving..." / "Saved" / "Error saving"
- Update the note's `updated_at` on save → note list re-sorts
- **Test:** Unit test (debounce logic), integration test (save indicator)

### 3.5 Note Title

- Title is an editable field above the editor (or the first block)
- Auto-extract from first heading if no explicit title
- Updating title triggers auto-save
- **Test:** Integration test (title editing, display in note list)

### 3.6 E2E: Note Editing Flow

- Full E2E: login → select notebook → create note → type content with formatting → verify auto-save → close and reopen → content persists
- **Test:** E2E covering create, edit, save, reload

### Checkpoint

Run full suite. Fix all failures.

---

## Phase 4: Notes — Organization & Trash

**Goal:** Users can move notes between notebooks, delete notes to trash, and manage trash (restore or permanently delete). Trash auto-cleans after 30 days.

### 4.1 Move Notes Between Notebooks

- UI: right-click menu or action menu on a note → "Move to..." → shows list of notebooks
- API: `PATCH /api/notes/[id]` with new `notebook_id`
- After move, note disappears from current list and appears in target notebook
- **Tests:** Unit test (API), integration test (move UI), E2E (move flow)

### 4.2 Trash — Soft Delete & Restore

- Delete action on a note → calls `DELETE /api/notes/[id]` (soft delete)
- Trash view: accessible from sidebar (e.g., "Trash" item at bottom)
- `GET /api/notes/trash` — list all trashed notes for the user
- Trash list shows: note title, original notebook, date trashed
- "Restore" button → `PATCH /api/notes/[id]` with `is_trashed = false`
- "Delete permanently" button → hard delete from database
- API: `DELETE /api/notes/[id]/permanent` — hard delete
- **Tests:** Unit tests (API routes), integration tests (trash UI), E2E (delete → trash → restore)

### 4.3 Trash Auto-Cleanup (30 Days)

- Supabase cron job (pg_cron) or Edge Function: delete notes where `is_trashed = true AND trashed_at < now() - interval '30 days'`
- Add as a Supabase migration
- **Test:** Unit test (verify the SQL logic deletes old trashed notes)

### Checkpoint

Run full suite. Fix all failures.

---

## Phase 5: File Attachments

**Goal:** Users can upload files to notes. Images display inline, other files show as download links. 25MB limit enforced.

### 5.1 Supabase Storage Setup

- Create a Supabase Storage bucket: `attachments`
- Storage policies: authenticated users can upload/read their own files only
- File size limit: 25MB (enforced in bucket config and API route)
- Add bucket setup to migrations/seed

### 5.2 Upload API & UI

> **Parallelizable:** API route (5.2a) and editor integration (5.2b) can be built simultaneously.

- **(5.2a) Upload API route:** `POST /api/notes/[id]/attachments`
  - Accept multipart form data
  - Validate: file size ≤ 25MB, user owns the note
  - Upload to Supabase Storage: `attachments/{user_id}/{note_id}/{filename}`
  - Create `attachments` row in database
  - Return: attachment metadata (id, file_name, url, mime_type)
  - **Tests:** Unit tests (size validation, auth check, success path)

- **(5.2b) Editor file integration:**
  - Add file upload button/drop zone in editor toolbar or via slash command
  - Images (`image/*`): render inline in the editor using BlockNote's image block
  - Other files: render as a styled download link block (file name + size + download icon)
  - **Tests:** Integration test (upload triggers, inline display)

### 5.3 Attachment Management

- `GET /api/notes/[id]/attachments` — list attachments for a note
- `DELETE /api/attachments/[id]` — delete attachment (remove from storage + database)
- When a note is permanently deleted, cascade-delete its attachments from storage
- **Tests:** Unit tests (API), E2E (upload file → see inline → delete)

### Checkpoint

Run full suite. Fix all failures.

---

## Phase 6: Responsive Design

**Goal:** The app works well on desktop, tablet, and mobile per PRD §4.5.

### 6.1 Desktop (Refinement)

- Three-panel layout is already built (Phase 2)
- Verify proportions, scrolling, panel sizing
- Sidebar: ~240px fixed, note list: ~300px, editor: fills remaining space

### 6.2 Tablet Layout

- Breakpoint: `md` (768px)
- Collapsible sidebar: hamburger toggle, slides over or pushes content
- Two panels visible: note list + editor
- **Test:** Integration test with tablet viewport

### 6.3 Mobile Layout

- Breakpoint: `sm` (640px)
- Single-panel view with navigation stack:
  - Notebooks list → tap → Notes list → tap → Editor
  - Back button to navigate up the stack
- Bottom navigation or top header with back arrow
- **Test:** Integration test with mobile viewport

### 6.4 E2E: Responsive Flows

- E2E tests using `Mobile Chrome` and `Mobile Safari` Playwright projects (added in Phase 0.5b)
- Test: navigate notebooks → notes → editor → back on mobile
- Test: collapse/expand sidebar on tablet
- **Tests:** E2E covering mobile and tablet navigation

### Checkpoint

Run full suite (including mobile viewport E2E). Fix all failures.

---

## Phase 7: Polish & Hardening

**Goal:** Security audit, edge cases, and final verification against PRD.

### 7.1 Security Audit

- Verify RLS policies block cross-user access (write targeted tests)
- Verify file upload limits cannot be bypassed
- Verify unapproved users are fully blocked (no API access, no data leaks)
- Run `pnpm audit` and resolve any high/critical vulnerabilities
- **Test:** Dedicated security-focused E2E tests

### 7.2 Edge Cases

- Empty states: no notebooks, no notes, empty notebook, empty trash
- Long note titles (truncation)
- Large note content (performance)
- Concurrent auto-save (rapid typing)
- Session expiry during editing (graceful handling)
- Notebook deletion with notes in it (warn or block)

### 7.3 PRD Compliance Checklist

Walk through every row in PRD §4.1–4.5 and verify each requirement is implemented:

- [ ] Multi-user with isolated data
- [ ] Open signup with admin approval
- [ ] Password reset flow
- [ ] Flat notebook list with CRUD
- [ ] Default "Notes" notebook
- [ ] BlockNote editor with slash commands
- [ ] Rich text: bold, italic, underline, strikethrough
- [ ] Headings: H1, H2, H3
- [ ] Lists: bullet, numbered
- [ ] Checkboxes
- [ ] Inline links
- [ ] File attachments (25MB limit, images inline)
- [ ] Auto-save (debounced)
- [ ] Timestamps (created, modified)
- [ ] Three-panel layout (desktop)
- [ ] Collapsible sidebar (tablet)
- [ ] Single-panel navigation (mobile)
- [ ] Move notes between notebooks
- [ ] Soft delete → trash → restore / permanent delete
- [ ] Trash auto-cleanup (30 days)

### Final Checkpoint

Run complete suite: `pnpm lint && pnpm format:check && pnpm exec tsc --noEmit && pnpm test:coverage && pnpm test:e2e`. All green.

---

## Parallelization Summary

| Phase | Parallelizable Tasks                               | Why                                               |
| ----- | -------------------------------------------------- | ------------------------------------------------- |
| 0     | 0.5a (pnpm audit) + 0.5b (Playwright mobile)       | Independent CI config changes                     |
| 1     | 1.1a (signup page) + 1.1b (login page)             | Independent UI components, same auth patterns     |
| 2     | 2.2a (notebook API) + 2.2b (notebook sidebar UI)   | API and UI are independent; UI can mock initially |
| 3     | 3.1 (BlockNote setup) + 3.2 (notes API routes)     | Editor config and API are independent             |
| 5     | 5.2a (upload API) + 5.2b (editor file integration) | API and UI are independent                        |

All other tasks within each phase are sequential (they depend on earlier steps in the same phase).

---

## ADRs to Create

| Phase | ADR Topic                                                 |
| ----- | --------------------------------------------------------- |
| 0     | Data model, RLS strategy, and user approval mechanism     |
| 0     | API route pattern and data-fetching conventions           |
| 3     | BlockNote editor configuration and content storage format |
