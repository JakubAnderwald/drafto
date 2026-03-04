# Drafto UI Redesign — Implementation Plan (Ralph Loop Edition)

## Context

Drafto's current UI is functional but visually minimal — plain gray/blue Tailwind defaults, no design system, no dark mode, basic loading/empty states, and no visual polish. This plan redesigns the entire UI to be modern, colorful, and intuitive while establishing a unified design system for consistency and maintainability.

**What changes:** Every visual surface gets redesigned. New color palette (indigo/amber), design tokens as CSS variables, reusable UI primitives, dark mode, loading skeletons, transitions, and improved empty states.

**What stays the same:** All existing functionality, responsive breakpoints, component architecture, data flow, API routes, and test coverage.

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

### Phase 0: Test Resilience

- [x] 0.1 — Decouple integration tests from Tailwind class names (add data-testid, fix 3 assertions)
- [x] 0-CP — **Checkpoint**: full suite green
- [x] 0-PUSH — **Push**: `/push` to PR

### Phase 1: Design System Foundation

- [x] 1.1 — Define color palette, typography, spacing, shadow, and animation tokens in globals.css
- [x] 1.2 — Create ADR-0004 (design system with CSS variables)
- [x] 1-CP — **Checkpoint**: full suite green, `pnpm build` passes
- [x] 1-PUSH — **Push**: `/push` to PR

### Phase 2: Reusable UI Primitives

- [x] 2.1 — cn() utility + Button component (variants: primary, secondary, ghost, danger; sizes: sm, md, lg; loading state)
- [x] 2.2 — Input and Label components
- [x] 2.3 — Card component (with header/body/footer slots)
- [x] 2.4 — Badge, IconButton, and Skeleton components
- [x] 2.5 — ConfirmDialog component
- [x] 2.6 — DropdownMenu component
- [x] 2-CP — **Checkpoint**: full suite green
- [x] 2-PUSH — **Push**: `/push` to PR

### Phase 3: Auth Pages Redesign

- [x] 3.1 — Auth layout (gradient background, branded Card container)
- [x] 3.2 — Login page (use Button, Input, Label, Card primitives)
- [x] 3.3 — Signup, forgot-password, reset-password, waiting-for-approval pages
- [x] 3-CP — **Checkpoint**: full suite green
- [x] 3-PUSH — **Push**: `/push` to PR

### Phase 4: App Shell & Sidebar Redesign

- [x] 4.1 — Notebooks sidebar (tokens, Skeleton loading, ConfirmDialog, styled empty state)
- [x] 4.2 — App shell layout (tokens, backdrop blur, Skeleton fallbacks, styled empty states)
- [x] 4-CP — **Checkpoint**: full suite green (including E2E responsive tests)
- [x] 4-PUSH — **Push**: `/push` to PR

### Phase 5: Note List & Editor Panel Redesign

- [x] 5.1 — Note list (tokens, DropdownMenu, styled selection/hover, empty state)
- [x] 5.2 — Note editor panel (title styling, Badge save status, timestamp icons)
- [x] 5.3 — BlockNote editor theme synchronization
- [x] 5-CP — **Checkpoint**: full suite green
- [ ] 5-PUSH — **Push**: `/push` to PR

### Phase 6: Trash & Admin Redesign

- [ ] 6.1 — Trash list (tokens, Button primitives, styled empty state)
- [ ] 6.2 — Admin page (Card, Button primitives, styled list)
- [ ] 6-CP — **Checkpoint**: full suite green
- [ ] 6-PUSH — **Push**: `/push` to PR

### Phase 7: Dark Mode

- [ ] 7.1 — Dark mode token overrides in globals.css (.dark class)
- [ ] 7.2 — useTheme hook + ThemeToggle component + flash-prevention script
- [ ] 7.3 — Integrate toggle into app shell sidebar and auth layout
- [ ] 7.4 — BlockNote dynamic theme prop (light/dark)
- [ ] 7.5 — Create ADR-0005 (dark mode implementation)
- [ ] 7-CP — **Checkpoint**: full suite green, `pnpm build` passes
- [ ] 7-PUSH — **Push**: `/push` to PR

### Phase 8: Animations & Micro-interactions

- [ ] 8.1 — CSS transitions on interactive elements (buttons, inputs, sidebar items, note items)
- [ ] 8.2 — Loading skeletons in component Suspense fallbacks (replace "Loading..." text)
- [ ] 8.3 — Improved empty states with SVG icons and descriptive text
- [ ] 8-CP — **Checkpoint**: full suite green
- [ ] 8-PUSH — **Push**: `/push` to PR

### Phase 9: Polish & Verification

- [ ] 9.1 — Consistency audit (all raw gray/blue classes replaced, all borders/rings use tokens)
- [ ] 9.2 — Update README.md with design system docs
- [ ] 9.3 — Full test sweep and fix any failures
- [ ] 9.4 — Design compliance checklist
- [ ] 9-PUSH — **Push**: `/push` to PR — UI REDESIGN COMPLETE

---

## Key Architectural Decisions

### Custom primitives over shadcn/ui

Build lightweight custom UI primitives using Tailwind CSS v4 + CSS custom properties rather than adopting shadcn/ui.

**Why:** The app has only 6 main components and 5 auth pages — too small for a full component library. shadcn/ui would add Radix dependencies alongside the existing Mantine dependency (required by BlockNote). Custom primitives using CSS variables give full dark mode control with zero new dependency trees.

### CSS custom properties for design tokens

Define the design system as CSS variables in `globals.css`, exposed to Tailwind via `@theme inline`.

**Why:** CSS variables are the native mechanism for dark mode toggling — change values under `.dark` and everything updates. Tailwind v4 consumes them directly. No build tooling needed.

### Color palette: Indigo primary + Amber accent

- **Indigo** — professional yet distinctive (differentiates from generic blue apps)
- **Amber** — warmth and energy for interactive highlights
- **Stone (warm gray)** — more inviting than pure gray for a note-taking app
- **Semantic colors** — green/amber/red/blue for success/warning/error/info

### data-testid migration (Phase 0)

Fix 3 test assertions that reference Tailwind classes before any styling changes, preventing cascading test breakage.

---

## Phase Details

### Phase 0: Test Resilience

**Goal:** Decouple tests from Tailwind classes so all subsequent styling changes are safe.

#### 0.1 — Add data-testid and fix class-based assertions

**Files to modify:**

- `src/components/notebooks/notebooks-sidebar.tsx` — add `data-testid="notebook-item-active"` to selected notebook
- `src/components/notes/note-list.tsx` — add `data-testid="note-item-active"` to selected note
- `src/components/editor/note-editor.tsx` — add `data-testid="editor-scroll-container"` to wrapper
- `__tests__/integration/notebooks-sidebar.test.tsx` — line 129: replace `toHaveClass("bg-blue-100")` with `toHaveAttribute("data-testid", "notebook-item-active")`
- `__tests__/integration/note-list.test.tsx` — line 196: replace `toHaveClass("bg-blue-100")` with `toHaveAttribute("data-testid", "note-item-active")`
- `__tests__/integration/note-editor.test.tsx` — line 88: replace `toHaveClass("flex-1", "overflow-y-auto")` with `toHaveAttribute("data-testid", "editor-scroll-container")`

---

### Phase 1: Design System Foundation

**Goal:** Establish all design tokens. No component changes yet.

#### 1.1 — Define tokens in globals.css

**File:** `src/app/globals.css`

Replace the minimal `:root` block with comprehensive tokens:

**Colors (light mode):**

```
Primary (Indigo): 50→900 scale
Accent (Amber): 50→600 scale
Neutral (Stone): 50→900 scale
Semantic: success (#22c55e), warning (#f59e0b), error (#ef4444), info (#3b82f6)
```

**Semantic surface tokens:**

```
--color-bg, --color-bg-subtle, --color-bg-muted
--color-fg, --color-fg-muted, --color-fg-subtle
--color-border, --color-border-strong, --color-ring
--color-sidebar-bg, --color-sidebar-hover, --color-sidebar-active, --color-sidebar-active-text
```

**Non-color tokens:**

```
--shadow-xs/sm/md/lg
--radius-sm/md/lg/xl/full
--transition-fast (150ms) / --transition-normal (200ms) / --transition-slow (300ms)
```

Wire into Tailwind via `@theme inline` so they're usable as `bg-primary`, `text-muted`, etc.

#### 1.2 — ADR-0004

**Create:** `docs/adr/0004-design-system-css-variables.md`
**Update:** `docs/adr/README.md` — add entry

---

### Phase 2: Reusable UI Primitives

**Goal:** Build `src/components/ui/` primitive library that encodes the design tokens.

#### 2.1 — cn() utility + Button

**Create:**

- `src/lib/cn.ts` — class name merge utility (use `clsx` — 228B gzipped)
- `src/components/ui/button.tsx` — variants: `primary` (indigo), `secondary` (neutral), `ghost` (transparent), `danger` (red); sizes: `sm`, `md`, `lg`; `loading` and `disabled` states
- `__tests__/integration/ui/button.test.tsx`

**Install:** `clsx` (if not already present)

#### 2.2 — Input + Label

**Create:**

- `src/components/ui/input.tsx` — styled with focus ring (`ring-primary`), error state (red border), sizes
- `src/components/ui/label.tsx` — styled label with `text-fg-muted`
- `__tests__/integration/ui/input.test.tsx`

#### 2.3 — Card

**Create:**

- `src/components/ui/card.tsx` — Card, CardHeader, CardBody, CardFooter; shadow variants (`sm`, `md`, `lg`)
- `__tests__/integration/ui/card.test.tsx`

#### 2.4 — Badge, IconButton, Skeleton

**Create:**

- `src/components/ui/badge.tsx` — small pill; variants: `default`, `success`, `warning`, `error`
- `src/components/ui/icon-button.tsx` — square button for icon-only actions; variants: `ghost`, `danger`
- `src/components/ui/skeleton.tsx` — pulsing placeholder rectangle (configurable height/width/rounded)
- Tests for each

#### 2.5 — ConfirmDialog

**Create:**

- `src/components/ui/confirm-dialog.tsx` — inline confirmation panel with title, message, confirm/cancel buttons (replaces the yellow-50 panel in notebooks-sidebar)
- `__tests__/integration/ui/confirm-dialog.test.tsx`

#### 2.6 — DropdownMenu

**Create:**

- `src/components/ui/dropdown-menu.tsx` — positioned dropdown with menu items (replaces custom menu in note-list)
- `__tests__/integration/ui/dropdown-menu.test.tsx`

---

### Phase 3: Auth Pages Redesign

**Goal:** Apply design system to auth pages (self-contained, low-risk).

#### 3.1 — Auth layout

**File:** `src/app/(auth)/layout.tsx`

- Background: subtle gradient `primary-50` → `accent-50`
- Centered Card with `shadow-lg`, `rounded-xl`
- Drafto wordmark/heading at top

#### 3.2 — Login page

**File:** `src/app/(auth)/login/page.tsx`

- Replace raw classes with Button, Input, Label, Card primitives
- Error alert uses semantic error tokens
- Links use primary color

#### 3.3 — Remaining auth pages

**Files:** `signup/page.tsx`, `forgot-password/page.tsx`, `reset-password/page.tsx`, `waiting-for-approval/page.tsx`

- Same primitive adoption as login

**Test impact:** Auth tests use role/label selectors — should pass without changes.

---

### Phase 4: App Shell & Sidebar Redesign

**Goal:** Highest-impact visual change — modernize the 3-panel layout and sidebar.

#### 4.1 — Notebooks sidebar

**File:** `src/components/notebooks/notebooks-sidebar.tsx`

- Background: `sidebar-bg` token
- Selected notebook: `sidebar-active` bg + left 3px `primary` accent border
- Hover: `sidebar-hover` with transition
- Section header: uppercase, tracking-wide, small muted text
- Loading: Skeleton component (replaces `Loading...` text)
- Empty state: book icon + styled message
- Delete confirm: ConfirmDialog primitive
- "New notebook" and trash buttons: IconButton primitive

**Tests to update:** `notebooks-sidebar.test.tsx` line 50 — `getByText("Loading...")` must change if loading text is replaced with Skeleton. Use `getByTestId("sidebar-skeleton")` or `getByRole("status")`.

#### 4.2 — App shell layout

**File:** `src/components/layout/app-shell.tsx`

- Panel borders: `border-color` token
- Backdrop: `bg-black/30` with `backdrop-blur-sm`
- Mobile back buttons: IconButton primitive
- Mobile/tablet headers: `bg-surface`, `text-fg`
- Suspense fallbacks: Skeleton components (replace "Loading notes...", "Loading trash...", "Loading...")
- Empty states ("Select a notebook", "Select a note"): styled with muted icon + descriptive text

**Tests to update:** `app-shell.test.tsx` line 443 — `getByText("Loading...")` must change.

---

### Phase 5: Note List & Editor Panel Redesign

**Goal:** Modernize the core note-taking surfaces.

#### 5.1 — Note list

**File:** `src/components/notes/note-list.tsx`

- Selected note: `primary-50` bg + left accent border
- Hover: subtle `shadow-xs`, `bg-surface`
- Timestamps: muted text with clock icon
- Actions: DropdownMenu primitive (replaces custom 3-dot menu)
- "New note" button: IconButton
- Empty state: document icon + "Create your first note"

#### 5.2 — Note editor panel

**File:** `src/components/notes/note-editor-panel.tsx`

- Title: larger, bolder, border-only-on-focus style
- Save status: Badge primitive (`success` = "Saved", `warning` = "Saving...", `error` = "Error")
- Timestamps: muted text with calendar/clock icons

#### 5.3 — BlockNote theme sync

**File:** `src/components/editor/note-editor.tsx`

- Pass custom Mantine theme that maps to CSS variable colors
- Add CSS overrides in `globals.css` for BlockNote variables (`.bn-container` custom properties)

---

### Phase 6: Trash & Admin Redesign

#### 6.1 — Trash list

**File:** `src/components/notes/trash-list.tsx`

- Items: `bg-surface-muted`, rounded
- Restore: Button `secondary`; Delete forever: Button `danger`
- Notebook origin: Badge component
- Empty: trash icon + "Trash is empty"

#### 6.2 — Admin page

**Files:** `src/app/(app)/admin/page.tsx`, `admin-user-list.tsx`

- User items: Card component
- Approve: Button `primary` (green-tinted)
- Empty: styled "No pending users"

---

### Phase 7: Dark Mode

**Goal:** Full dark mode with toggle, system preference detection, and persistence.

#### 7.1 — Dark token overrides

**File:** `src/app/globals.css`

Add `.dark` class that overrides all semantic surface tokens:

```
--color-bg: #0f0f0f → dark surfaces
--color-fg: #ededed → light text
--color-sidebar-bg: #141414
...etc
```

Remove existing `@media (prefers-color-scheme: dark)` block.

#### 7.2 — useTheme hook + ThemeToggle

**Create:**

- `src/hooks/use-theme.ts` — reads/writes `localStorage("theme")`, listens to `prefers-color-scheme`, toggles `.dark` on `<html>`
- `src/components/ui/theme-toggle.tsx` — sun/moon icon button
- `__tests__/unit/use-theme.test.ts`
- `__tests__/integration/ui/theme-toggle.test.tsx`

**Modify:** `src/app/layout.tsx` — add inline `<script>` in `<head>` for flash prevention (reads localStorage before paint), add `suppressHydrationWarning` to `<html>`

#### 7.3 — Integrate toggle

- `src/components/layout/app-shell.tsx` — ThemeToggle in sidebar footer
- `src/app/(auth)/layout.tsx` — ThemeToggle in corner

#### 7.4 — BlockNote dynamic theme

**File:** `src/components/editor/note-editor.tsx` — read current theme, pass `theme="dark"` or `theme="light"` to BlockNoteView

#### 7.5 — ADR-0005

**Create:** `docs/adr/0005-dark-mode-implementation.md`
**Update:** `docs/adr/README.md`

---

### Phase 8: Animations & Micro-interactions

#### 8.1 — CSS transitions

Add `transition-colors` / `transition-all` with duration tokens to: buttons, inputs, sidebar items, note list items, icon buttons.

#### 8.2 — Loading skeletons

Replace remaining "Loading..." plain text in component Suspense fallbacks with Skeleton components. Update test assertions that check for "Loading..." text.

#### 8.3 — Empty states

Add inline SVG icons to empty states in sidebar ("no notebooks"), note list ("no notes"), trash ("empty"), and app shell ("select a notebook/note").

---

### Phase 9: Polish & Verification

#### 9.1 — Consistency audit

Grep for any remaining raw `gray-`, `blue-600`, `red-500` etc. Tailwind classes. Replace with design system tokens.

#### 9.2 — Update README.md

Document: design system location, color palette, UI primitives, dark mode, how to add new tokens.

#### 9.3 — Full test sweep

Run: `pnpm lint && pnpm format:check && pnpm exec tsc --noEmit && pnpm test && pnpm test:e2e`

#### 9.4 — Design compliance checklist

- [ ] Indigo/amber palette applied across all surfaces
- [ ] All components use design tokens (no raw Tailwind color classes)
- [ ] Dark mode toggles correctly, persists, respects system preference
- [ ] Loading states use Skeleton components
- [ ] Empty states have icons and descriptive text
- [ ] Transitions on all interactive elements
- [ ] Accessibility: focus rings visible, ARIA patterns maintained
- [ ] BlockNote editor matches app theme in both modes
- [ ] Responsive layout unchanged (mobile/tablet/desktop)
- [ ] All tests green

---

## New Files Summary

```
src/lib/cn.ts
src/components/ui/button.tsx
src/components/ui/input.tsx
src/components/ui/label.tsx
src/components/ui/card.tsx
src/components/ui/badge.tsx
src/components/ui/icon-button.tsx
src/components/ui/skeleton.tsx
src/components/ui/confirm-dialog.tsx
src/components/ui/dropdown-menu.tsx
src/components/ui/theme-toggle.tsx
src/hooks/use-theme.ts
docs/adr/0004-design-system-css-variables.md
docs/adr/0005-dark-mode-implementation.md
__tests__/integration/ui/button.test.tsx
__tests__/integration/ui/input.test.tsx
__tests__/integration/ui/card.test.tsx
__tests__/integration/ui/badge.test.tsx
__tests__/integration/ui/icon-button.test.tsx
__tests__/integration/ui/skeleton.test.tsx
__tests__/integration/ui/confirm-dialog.test.tsx
__tests__/integration/ui/dropdown-menu.test.tsx
__tests__/integration/ui/theme-toggle.test.tsx
__tests__/unit/use-theme.test.ts
```

## Test Breakage Risk

**Low risk.** The test suite is well-designed:

- **Integration tests** (13 files): Use `getByRole`, `getByLabelText`, `getByText` selectors. Only 3 assertions reference CSS classes — fixed in Phase 0.
- **E2E tests** (5 files): Zero CSS class references. Will not break from styling changes.
- **Unit tests** (17 files): Test API routes and pure logic. Zero risk.

**Tests that will need updating:**

1. 3 `toHaveClass` assertions → Phase 0
2. 3 `getByText("Loading...")` assertions → Phase 4 and 8.2 (when Skeletons replace loading text)

## Parallelization

| Phase | Parallelizable Tasks                 | Why                                                        |
| ----- | ------------------------------------ | ---------------------------------------------------------- |
| 2     | 2.2–2.6 (after 2.1)                  | Independent UI primitives; 2.1 provides cn() needed by all |
| 3     | 3.2 + 3.3                            | Independent auth pages                                     |
| 5     | 5.1 + 5.2                            | Note list and editor panel are independent components      |
| 6     | 6.1 + 6.2                            | Trash and admin are independent views                      |
| 7     | 7.1 can run parallel with Phases 3-6 | Token definitions are independent of component restyling   |
