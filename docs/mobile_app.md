# Drafto Mobile App — Implementation Plan (Ralph Loop Edition)

## Context

Drafto is a note-taking web app (Next.js 16, React 19, TypeScript, Supabase, BlockNote editor) at drafto.eu. It currently has zero offline support and no mobile app. This plan adds a native mobile app for iOS and Android with offline-first capability using WatermelonDB and online sync with Supabase. The app will be published to both Google Play Store and Apple App Store.

**What changes:** The repo becomes a monorepo (Turborepo + pnpm workspaces). A new `apps/mobile` Expo project is created. Shared types are extracted to `packages/shared`. A WatermelonDB sync adapter bridges local SQLite with Supabase.

**What stays the same:** The web app continues as-is (moved to `apps/web/`). Supabase schema, RLS policies, and all web tests remain unchanged. No database migrations needed for core mobile features.

---

**RALPH LOOP RULES (STRICT):**
You are running in an autonomous, unattended loop. On every single execution, you MUST follow these exact steps in order:

1. **Identify:** Scan the Progress Tracker below and find the _first_ unchecked task `[ ]`.
2. **Scope:** DO NOT attempt multiple tasks. Focus ONLY on that single task.
3. **Implement:** Write the code to satisfy the task's requirements.
4. **Test:** Run the test suite for the affected package(s). For web: `cd apps/web && CI=true pnpm test -- --run && CI=true pnpm test:e2e && pnpm lint && pnpm exec tsc --noEmit`. For mobile: `cd apps/mobile && pnpm lint && pnpm exec tsc --noEmit && pnpm test` (unit + integration only; Maestro E2E is manual/local). For shared: `cd packages/shared && pnpm exec tsc --noEmit && pnpm test`.
5. **Fix:** If _any_ test or check fails, debug, fix, and re-run until 100% green.
6. **Record:** Check off the task `[ ]` → `[x]`.
7. **Commit:** Commit and push using `/push`. Merge to main when CI green.
8. **Exit:** EXIT immediately so the loop restarts with a fresh context window.

---

## Key Architectural Decisions

### React Native with Expo (SDK 53+)

Maximum code reuse with existing React/TypeScript codebase. Expo simplifies builds, OTA updates, and app store deployment. Supabase has official React Native support.

### Monorepo with pnpm workspaces + Turborepo

Extract shared types (`Database`, API response types) and constants into `packages/shared/`. Web moves to `apps/web/`, mobile lives in `apps/mobile/`. Turborepo orchestrates builds.

### WatermelonDB for offline-first sync

Open-source, offline-first SQLite database for React Native. Free forever. Mature (5+ years). Built-in sync protocol with push/pull adapter pattern. Custom Supabase sync adapter fetches changes by `updated_at > last_sync` and pushes dirty rows. Conflict resolution: server wins (last-write-wins on `updated_at`).

### 10tap-editor for rich text

React Native TipTap/ProseMirror wrapper with native keyboard handling. Both TipTap and BlockNote are ProseMirror-based, so a format converter maps between BlockNote blocks and TipTap JSON. Best native feel while maintaining format compatibility.

### Core features only (no admin/import on mobile)

Mobile scope: notebooks, notes, editor, trash, attachments, settings/theme. Admin user approval and Evernote import remain web-only.

### Mobile talks directly to Supabase (not web API routes)

The mobile app uses `@supabase/supabase-js` directly instead of going through Next.js `/api/` routes. Same RLS policies protect the data. This is more efficient and works with WatermelonDB's sync adapter.

### Maestro for E2E testing (local-only, free)

Maestro is a YAML-based mobile E2E framework. Tests run locally on iOS Simulator and Android Emulator (both free on macOS). No CI E2E — too expensive (macOS runners for iOS, Android emulator setup). CI runs lint + typecheck + unit/integration tests only. E2E tests are run manually before releases on the developer's machine.

**Local E2E workflow:**

1. Build dev client: `eas build --profile development --platform ios` (or android)
2. Run Maestro: `maestro test apps/mobile/e2e/` (runs all YAML flows on simulator/emulator)
3. Before release: run full Maestro suite on both platforms locally

---

## Progress Tracker

### Phase 0: Monorepo Restructure

- [x] 0.1 — Set up pnpm workspaces and Turborepo config
- [x] 0.2 — Move web app to `apps/web/` (update all paths, tsconfig, CI, Vercel)
- [x] 0.3 — Extract shared package (`packages/shared/` — types, constants)
- [x] 0.4 — Update CI/CD workflows for monorepo
- [x] 0-CP — **Checkpoint**: full web test suite green, `turbo build` passes
- [x] 0-PUSH — **Push**: `/push` to PR

### Phase 1: Expo Project Scaffolding

- [x] 1.1 — Initialize Expo project in `apps/mobile/` with TypeScript
- [x] 1.2 — Configure ESLint, Prettier (matching web conventions)
- [x] 1.3 — Set up Expo Router with tab navigation skeleton (Notebooks, Trash, Settings)
- [x] 1.4 — Create ADR-0009 (mobile app technology choices)
- [x] 1-CP — **Checkpoint**: `apps/mobile` builds for iOS simulator and Android emulator
- [x] 1-PUSH — **Push**: `/push` to PR

### Phase 2: Authentication

- [x] 2.1 — Supabase client for React Native with `expo-secure-store` token storage
- [x] 2.2 — Login screen (email/password)
- [x] 2.3 — Signup screen + waiting-for-approval screen
- [x] 2.4 — Auth provider (session persistence, auto-refresh, approval check)
- [x] 2.5 — Protected route guard (redirect unauthenticated/unapproved users)
- [x] 2-CP — **Checkpoint**: login/signup works on simulator, tokens persist across app restarts
- [x] 2-PUSH — **Push**: `/push` to PR

### Phase 3: Online-Only Core Features

- [x] 3.1 — Supabase data layer (typed query functions for notebooks, notes, trash)
- [x] 3.2 — Notebooks list screen (fetch, create, rename, delete)
- [x] 3.3 — Notes list screen (fetch, create, select, trash)
- [x] 3.4 — Note editor screen with 10tap-editor
- [x] 3.5 — BlockNote <-> TipTap format converter (in `packages/shared`)
- [x] 3.6 — Auto-save with debounce
- [x] 3-CP — **Checkpoint**: full CRUD works online, content round-trips with web app
- [x] 3-PUSH — **Push**: `/push` to PR

### Phase 4: Offline Storage with WatermelonDB

- [x] 4.1 — Install and configure WatermelonDB with schema (notebooks, notes, attachments)
- [x] 4.2 — WatermelonDB model classes with field decorators
- [x] 4.3 — Supabase sync adapter (pullChanges + pushChanges)
- [x] 4.4 — Migrate screens from direct Supabase queries to WatermelonDB observables
- [x] 4.5 — Create ADR-0010 (offline sync strategy with WatermelonDB)
- [x] 4-CP — **Checkpoint**: app works offline (read + write), syncs when online
- [x] 4-PUSH — **Push**: `/push` to PR

### Phase 5: Offline Write Support & Sync UX

- [x] 5.1 — Offline note creation and editing (writes to local SQLite, syncs later)
- [x] 5.2 — Offline notebook creation
- [x] 5.3 — Network status detection + online/offline indicator
- [x] 5.4 — Sync status visualization (pending changes count, last synced time)
- [x] 5.5 — Conflict resolution handling (server-wins with user notification toast)
- [x] 5-CP — **Checkpoint**: full CRUD works offline, syncs correctly when reconnected
- [x] 5-PUSH — **Push**: `/push` to PR

### Phase 6: Trash & Attachments

- [x] 6.1 — Trash screen (list trashed notes, restore, permanent delete)
- [x] 6.2 — Attachment upload (image picker + document picker -> Supabase Storage)
- [x] 6.3 — Attachment display in editor (inline images, file links)
- [ ] 6.4 — Offline attachment queuing (save locally, upload when back online)
- [ ] 6-CP — **Checkpoint**: trash and attachments work, sync verified
- [ ] 6-PUSH — **Push**: `/push` to PR

### Phase 7: UI Polish & Native Features

- [ ] 7.1 — Design system adaptation (map indigo/amber CSS tokens to RN styles)
- [ ] 7.2 — Dark mode (system preference + manual toggle, persisted)
- [ ] 7.3 — Pull-to-refresh on list screens (triggers sync)
- [ ] 7.4 — Swipe gestures (swipe to trash/restore)
- [ ] 7.5 — Loading skeletons and styled empty states
- [ ] 7.6 — Haptic feedback on key interactions
- [ ] 7-CP — **Checkpoint**: app feels polished and native
- [ ] 7-PUSH — **Push**: `/push` to PR

### Phase 8: App Store Preparation

- [ ] 8.1 — App icon and splash screen (Expo config, Drafto branding)
- [ ] 8.2 — EAS Build configuration (dev, preview, production profiles)
- [ ] 8.3 — Deep linking (`drafto://` scheme + universal links for drafto.eu)
- [ ] 8.4 — App Store metadata (screenshots, description, privacy policy)
- [ ] 8.5 — Create ADR-0011 (app store deployment strategy)
- [ ] 8-CP — **Checkpoint**: successful EAS build for both platforms
- [ ] 8-PUSH — **Push**: `/push` to PR

### Phase 9: Testing & Release

- [ ] 9.1 — Unit tests for shared package (format converter round-trip tests)
- [ ] 9.2 — Integration tests for mobile screens (React Native Testing Library)
- [ ] 9.3 — Install Maestro CLI and write E2E test flows (YAML)
- [ ] 9.4 — Maestro E2E flows: login, create notebook, create/edit note, trash/restore
- [ ] 9.5 — Maestro E2E flows: offline mode (airplane mode toggle, verify local data persists)
- [ ] 9.6 — Performance profiling (startup < 2s, sync perf with 1000 notes)
- [ ] 9.7 — Beta testing (TestFlight + Google Play Internal Testing)
- [ ] 9.8 — Final compliance checklist
- [ ] 9-PUSH — **Push**: `/push` to PR — MOBILE APP v1 COMPLETE

---

## Phase Details

### Phase 0: Monorepo Restructure

**Goal:** Convert single-app repo into a monorepo. Web app must remain fully functional.

#### 0.1 — Set up pnpm workspaces and Turborepo

- Modify `pnpm-workspace.yaml` — add `packages: ["apps/*", "packages/*"]`
- Create `turbo.json` — define `build`, `lint`, `test`, `typecheck` pipelines
- Add `turbo` as root devDependency

#### 0.2 — Move web app to `apps/web/`

- Create `apps/web/` and move: `src/`, `__tests__/`, `e2e/`, `middleware.ts`, `next.config.ts`, `tsconfig.json`, `vitest.config.mts`, `vitest.setup.ts`, `playwright.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `instrumentation*.ts`, `sentry.*.config.ts`, `next-env.d.ts`
- Create `apps/web/package.json` with web-specific dependencies
- Keep at root: `supabase/`, `docs/`, `scripts/`, `CLAUDE.md`, `README.md`, `LICENSE`
- Update Vercel root directory to `apps/web`
- Verify `@/` alias still resolves to `apps/web/src/`

#### 0.3 — Extract shared package

- Create `packages/shared/package.json` (name: `@drafto/shared`)
- Move `Database` type from `src/lib/supabase/database.types.ts` -> `packages/shared/src/types/database.ts`
- Extract API response types (Notebook, Note, Attachment row types) -> `packages/shared/src/types/api.ts`
- Add shared constants -> `packages/shared/src/constants.ts` (MAX_TITLE_LENGTH, DEBOUNCE_MS, MAX_FILE_SIZE)
- Update web imports to use `@drafto/shared`

#### 0.4 — Update CI/CD

- Update `.github/workflows/ci.yml` for monorepo (Turborepo caching, run web tests from `apps/web/`)
- Update CLAUDE.md test commands

---

### Phase 1: Expo Project Scaffolding

**Goal:** Minimal Expo app that builds on both platforms with navigation skeleton.

#### 1.1 — Initialize Expo project

- `npx create-expo-app@latest apps/mobile --template blank-typescript`
- Configure `app.config.ts`: bundle ID `eu.drafto.mobile`, SDK 53+
- Add `@drafto/shared` as workspace dependency
- Install: `expo-router`, `react-native-screens`, `react-native-safe-area-context`, `expo-status-bar`

#### 1.3 — Expo Router navigation skeleton

```text
apps/mobile/app/
  _layout.tsx              (root Stack)
  (auth)/
    login.tsx
    signup.tsx
    waiting-for-approval.tsx
  (tabs)/
    _layout.tsx            (Tab navigator: Notebooks, Trash, Settings)
    index.tsx              (notebooks list placeholder)
    trash.tsx
    settings.tsx
  notebooks/[id].tsx       (notes list)
  notes/[id].tsx           (editor)
```

---

### Phase 2: Authentication

**Goal:** Login, signup, session persistence, approval gate.

#### 2.1 — Supabase client

```typescript
// apps/mobile/src/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";

const adapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storage: adapter, autoRefreshToken: true, persistSession: true },
});
```

#### 2.4 — Auth provider

- `apps/mobile/src/providers/auth-provider.tsx`
- Listen to `supabase.auth.onAuthStateChange()`
- Expose: `user`, `session`, `isApproved`, `isLoading`, `signOut`
- Check `profiles.is_approved` after sign-in

---

### Phase 3: Online-Only Core Features

**Goal:** Full CRUD working online. Content created on mobile readable on web and vice versa.

#### 3.1 — Supabase data layer

Mobile calls Supabase directly (same RLS policies protect data):

- `getNotebooks()`, `createNotebook()`, `updateNotebook()`, `deleteNotebook()`
- `getNotes(notebookId)`, `createNote()`, `updateNote()`, `trashNote()`, `deleteNotePermanent()`
- `getTrashedNotes()`, `restoreNote()`

#### 3.4 — Note editor with 10tap-editor

- Install `@10tap/editor`
- Create `apps/mobile/src/components/editor/note-editor.tsx`
- Load content via format converter (BlockNote -> TipTap on load, TipTap -> BlockNote on save)
- Debounced auto-save (500ms)

#### 3.5 — BlockNote <-> TipTap format converter

**File:** `packages/shared/src/editor/format-converter.ts`

BlockNote blocks:

```json
[
  {
    "id": "abc",
    "type": "paragraph",
    "props": {},
    "content": [{ "type": "text", "text": "Hello", "styles": {} }],
    "children": []
  }
]
```

TipTap doc:

```json
{
  "type": "doc",
  "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Hello" }] }]
}
```

Functions:

- `blocknoteToTiptap(blocks: Block[]): TipTapDoc`
- `tiptapToBlocknote(doc: TipTapDoc): Block[]`

Both are ProseMirror-based so inline content (marks, text) is nearly identical. Main differences: BlockNote wraps in `children`/`props`, TipTap uses flat node structure.

**Critical:** Unit tests with real BlockNote samples to verify round-trip fidelity.

---

### Phase 4: Offline Storage with WatermelonDB

**Goal:** Reads from local SQLite, writes queue and sync in background.

#### 4.1 — WatermelonDB setup

Install: `@nozbe/watermelondb`, `@nozbe/with-observables`

#### 4.2 — Model classes

```text
apps/mobile/src/db/
  schema.ts        (table definitions)
  models/
    notebook.ts    (Model class with @field decorators)
    note.ts
    attachment.ts
  index.ts         (Database initialization)
```

WatermelonDB schema mirrors Supabase tables. `content` stored as `string` (JSON-serialized BlockNote blocks).

#### 4.3 — Supabase sync adapter

```text
apps/mobile/src/db/sync.ts
```

Implements WatermelonDB's `synchronize()` protocol:

- `pullChanges({ lastPulledAt })` -> query Supabase for rows where `updated_at > lastPulledAt`, grouped by table, return `{ changes: { notebooks: { created, updated, deleted }, notes: {...}, ... }, timestamp }`
- `pushChanges({ changes })` -> upsert created/updated rows to Supabase, delete removed rows
- Handles the `is_trashed` soft-delete pattern for notes
- Runs on app foreground, pull-to-refresh, and periodic background timer

#### 4.4 — Migrate screens to WatermelonDB

Replace direct Supabase queries with WatermelonDB `observe()`:

- `database.get('notebooks').query().observe()` for reactive lists
- `withObservables()` HOC or `useObservable()` hook pattern
- Writes go to WatermelonDB -> auto-synced by adapter

---

### Phase 5: Offline Write Support & Sync UX

**Goal:** Users can create and edit offline. Changes sync on reconnect.

#### 5.1-5.2 — Offline writes

WatermelonDB handles this natively — writes go to local SQLite. UUIDs generated client-side. Sync adapter pushes to Supabase when online.

#### 5.3 — Network status

- `apps/mobile/src/hooks/use-network-status.ts`
- Use `@react-native-community/netinfo`
- Banner/badge when offline
- Auto-trigger sync on reconnect

#### 5.5 — Conflict resolution

Server-wins strategy: on pull, if server's `updated_at` > local's `updated_at`, server version is applied. Toast notification: "Note updated from another device."

---

### Phase 6: Trash & Attachments

#### 6.2 — Attachment upload

- Install: `expo-image-picker`, `expo-document-picker`
- Upload to Supabase Storage at `{userId}/{noteId}/{filename}`
- 25MB limit enforced client-side

#### 6.4 — Offline attachment queuing

- Save file locally via `expo-file-system`
- Queue upload metadata in WatermelonDB `attachments` table
- Upload when connectivity returns

---

### Phase 7: UI Polish

#### 7.1 — Design system

Map CSS tokens to React Native:

```typescript
// apps/mobile/src/theme/tokens.ts
export const colors = {
  primary: { 50: '#eef2ff', 500: '#6366f1', 600: '#4f46e5', ... },
  accent:  { 50: '#fffbeb', 500: '#f59e0b', ... },
  neutral: { 50: '#fafaf9', 900: '#1c1917', ... },
};
```

---

### Phase 8: App Store Preparation

#### 8.2 — EAS Build

```json
// apps/mobile/eas.json
{
  "build": {
    "development": { "developmentClient": true },
    "preview": { "distribution": "internal" },
    "production": { "autoIncrement": true }
  }
}
```

---

### Phase 9: Testing & Release (Details)

**Goal:** Comprehensive testing and first public release.

#### Testing Strategy Overview

| Layer             | Tool                           | Runs in CI?        | Runs locally?   |
| ----------------- | ------------------------------ | ------------------ | --------------- |
| Lint + typecheck  | ESLint + tsc                   | Yes (Linux)        | Yes             |
| Unit tests        | Vitest (shared), Jest (mobile) | Yes (Linux)        | Yes             |
| Integration tests | React Native Testing Library   | Yes (Linux)        | Yes             |
| E2E tests         | Maestro                        | No (too expensive) | Yes (emulators) |
| Beta testing      | TestFlight + Play Internal     | N/A                | Manual          |

#### CI Pipeline (every PR, Linux runner, free)

```yaml
# .github/workflows/ci.yml (mobile jobs)
mobile-checks:
  runs-on: ubuntu-latest
  steps:
    - pnpm install
    - cd apps/mobile && pnpm lint
    - cd apps/mobile && pnpm exec tsc --noEmit
    - cd apps/mobile && pnpm test # unit + integration (JSDOM/RN Testing Library)
    - cd packages/shared && pnpm test # format converter tests
```

No emulators in CI. No Maestro in CI. Keeps CI fast and free.

#### Local E2E with Maestro

**Install:** `brew install maestro` (macOS)

**Test flows location:** `apps/mobile/e2e/`

```yaml
# apps/mobile/e2e/01-login.yaml
appId: eu.drafto.mobile
---
- launchApp
- tapOn: "Email"
- inputText: "test@example.com"
- tapOn: "Password"
- inputText: "password123"
- tapOn: "Log in"
- assertVisible: "Notebooks"

# apps/mobile/e2e/02-create-notebook.yaml
appId: eu.drafto.mobile
---
- launchApp
- tapOn: "New Notebook"
- inputText: "Test Notebook"
- tapOn: "Create"
- assertVisible: "Test Notebook"

# apps/mobile/e2e/03-create-edit-note.yaml
appId: eu.drafto.mobile
---
- launchApp
- tapOn: "Test Notebook"
- tapOn: "New Note"
- assertVisible: "Untitled"
- tapOn: "Untitled"
- inputText: "My Test Note"
- assertVisible: "Saved"

# apps/mobile/e2e/04-trash-restore.yaml
appId: eu.drafto.mobile
---
- launchApp
- tapOn: "Test Notebook"
- swipeLeft: "My Test Note"
- tapOn: "Trash"
- tapOn: "Trash" # tab
- assertVisible: "My Test Note"
- tapOn: "Restore"
- assertNotVisible: "My Test Note"

# apps/mobile/e2e/05-offline-mode.yaml
appId: eu.drafto.mobile
---
- launchApp
- toggleAirplaneMode  # Maestro supports this
- tapOn: "Test Notebook"
- tapOn: "New Note"
- assertVisible: "Offline"
- tapOn: "Untitled"
- inputText: "Offline Note"
- toggleAirplaneMode
- assertVisible: "Syncing"
- assertVisible: "Saved"
```

**Run locally:**

```bash
# iOS
maestro test apps/mobile/e2e/ --platform ios

# Android
maestro test apps/mobile/e2e/ --platform android

# Single flow
maestro test apps/mobile/e2e/01-login.yaml
```

**Pre-release checklist:**

1. Run full Maestro suite on iOS Simulator
2. Run full Maestro suite on Android Emulator
3. Verify all flows pass on both platforms
4. Then submit to TestFlight / Play Internal Testing

#### 9.1 — Unit tests (shared package)

- `packages/shared/__tests__/format-converter.test.ts` — round-trip: BlockNote -> TipTap -> BlockNote
- Test with real BlockNote content samples (paragraphs, headings, lists, images, code blocks)
- Verify no data loss on round-trip

#### 9.2 — Integration tests (mobile screens)

Install: `@testing-library/react-native`, `jest` (Expo default)

- `apps/mobile/__tests__/screens/login.test.tsx` — renders form, submits, handles errors
- `apps/mobile/__tests__/screens/notebooks.test.tsx` — renders list, create/delete
- `apps/mobile/__tests__/screens/notes.test.tsx` — renders list, select, trash
- `apps/mobile/__tests__/screens/editor.test.tsx` — renders editor, triggers auto-save
- `apps/mobile/__tests__/components/sync-status.test.tsx` — shows correct status

Mock Supabase and WatermelonDB in tests (no network, no SQLite).

---

## Estimated File Structure

```text
drafto/
  apps/
    web/                          (existing Next.js app, moved from root)
      src/
      __tests__/
      e2e/
      package.json
      ...
    mobile/
      app/                        (Expo Router)
        _layout.tsx
        (auth)/login.tsx, signup.tsx, waiting-for-approval.tsx
        (tabs)/_layout.tsx, index.tsx, trash.tsx, settings.tsx
        notebooks/[id].tsx
        notes/[id].tsx
      src/
        components/
          editor/note-editor.tsx, attachment-picker.tsx
          ui/skeleton.tsx, empty-state.tsx
          sync-status.tsx
        db/
          schema.ts, index.ts, sync.ts
          models/notebook.ts, note.ts, attachment.ts
        hooks/
          use-auto-save.ts, use-color-scheme.ts, use-network-status.ts
        lib/
          supabase.ts, secure-store-adapter.ts
        providers/
          auth-provider.tsx, database-provider.tsx
        theme/tokens.ts
      __tests__/
        screens/login.test.tsx, notebooks.test.tsx, notes.test.tsx, editor.test.tsx
        components/sync-status.test.tsx
      e2e/                          (Maestro YAML flows, local-only)
        01-login.yaml
        02-create-notebook.yaml
        03-create-edit-note.yaml
        04-trash-restore.yaml
        05-offline-mode.yaml
      app.config.ts
      eas.json
      package.json
  packages/
    shared/
      src/
        types/database.ts, api.ts
        editor/format-converter.ts
        constants.ts
        index.ts
      __tests__/
      package.json
  supabase/                       (stays at root)
  docs/adr/
    0009-mobile-app-technology-choices.md
    0010-offline-sync-strategy.md
    0011-app-store-deployment.md
  turbo.json
  pnpm-workspace.yaml
```

## Risk Register

| Risk                                            | Impact | Mitigation                                                                           |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| BlockNote <-> TipTap format conversion is lossy | High   | Phase 3.5 has comprehensive round-trip tests. Fallback: WebView+BlockNote            |
| WatermelonDB sync adapter complexity            | Medium | WatermelonDB has well-documented sync protocol. Start with simple last-write-wins    |
| Monorepo migration breaks web deployment        | High   | Phase 0 focuses entirely on keeping web functional. Vercel root dir change is atomic |
| 10tap-editor limitations on mobile              | Medium | If keyboard/UX issues arise, fall back to WebView+BlockNote                          |
| App store review rejection                      | Medium | Follow guidelines strictly, no private APIs                                          |

## ADRs to Create

| Phase | ADR  | Topic                                                        |
| ----- | ---- | ------------------------------------------------------------ |
| 1     | 0009 | Mobile app technology choices (Expo, React Native, monorepo) |
| 4     | 0010 | Offline sync strategy (WatermelonDB, conflict resolution)    |
| 8     | 0011 | App store deployment strategy (EAS Build, TestFlight, beta)  |

## Final Compliance Checklist (Phase 9.8)

- [ ] Login/signup works on both iOS and Android
- [ ] Notebooks CRUD works online and offline
- [ ] Notes CRUD works online and offline
- [ ] Rich text editor produces BlockNote-compatible content
- [ ] Content syncs correctly between web and mobile
- [ ] Attachments upload and display correctly
- [ ] Trash works (soft delete, restore, permanent delete)
- [ ] Dark mode works (system preference + manual toggle)
- [ ] App works fully offline (read + write)
- [ ] Sync resumes correctly after offline period
- [ ] Conflict resolution works (server-wins)
- [ ] Deep links work
- [ ] Performance targets met (< 2s cold start)
- [ ] All tests green (unit, integration, E2E)
- [ ] App store requirements met (icon, splash, metadata, privacy policy)
