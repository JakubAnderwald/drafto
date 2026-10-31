# Mobile and Desktop Apps

**Status:** shipped **Updated:** 2026-10-25

## What it is

Drafto's native clients: an Expo + React Native app that ships to iOS and
Android, and a React Native macOS app that ships to the Mac App Store. All three
share the same offline-first data model and the same editor.

## Current state

Shipped on iOS (App Store), Android (Google Play), and macOS (Mac App Store).
All three builds run locally through Fastlane — no CI builds. Mobile is on
Expo SDK 55 / React Native 0.83.2; desktop is on React Native macOS 0.81.6.
Both link the same `@nozbe/watermelondb@0.28.x` native module and reuse the
`@10play/tentap-editor` WebView-based editor.

## Code paths

| Concern                            | Path                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Mobile package manifest            | `apps/mobile/package.json`                                                                                                    |
| Mobile Expo config (iOS + Android) | `apps/mobile/app.config.ts`                                                                                                   |
| Mobile app routes (expo-router)    | `apps/mobile/app/`                                                                                                            |
| Mobile source tree                 | `apps/mobile/src/{components,db,hooks,lib,providers,screens,theme}/`                                                          |
| Mobile Expo config plugins         | `apps/mobile/plugins/with-android-{optimizations,gradle-memory,signing}.js`, `with-ios-*.js`                                  |
| Mobile Fastlane                    | `apps/mobile/fastlane/{Fastfile,Appfile,Matchfile,Pluginfile}`                                                                |
| Mobile release-notes scripts       | `apps/mobile/scripts/{generate-release-notes.sh,post-release-notes.mjs}`                                                      |
| Mobile tests                       | `apps/mobile/__tests__/{components,hooks,lib,performance,providers,screens}/`                                                 |
| Mobile Maestro E2E                 | `apps/mobile/e2e/`                                                                                                            |
| Desktop package manifest           | `apps/desktop/package.json`                                                                                                   |
| Desktop Xcode workspace            | `apps/desktop/macos/Drafto.xcworkspace`                                                                                       |
| Desktop native target              | `apps/desktop/macos/Drafto-macOS/` (AppDelegate, Info.plist, entitlements, menu manager, crypto)                              |
| Desktop source tree                | `apps/desktop/src/{components,db,helpers,hooks,lib,screens}/` plus `App.tsx`, `navigation/`, `providers/`, `theme/`, `types/` |
| Desktop Fastlane                   | `apps/desktop/fastlane/{Fastfile,Appfile,Matchfile,Pluginfile}`                                                               |
| Desktop release-notes scripts      | `apps/desktop/scripts/{generate-release-notes.sh,post-release-notes.mjs}`                                                     |
| Desktop tests                      | `apps/desktop/__tests__/{components,db,helpers,lib,screens}/`                                                                 |
| Shared types and constants         | `packages/shared/src/`                                                                                                        |
| Shared markdown converter (MCP)    | `packages/shared/src/editor/markdown-converter.ts`                                                                            |
| Dev env (both apps)                | `apps/mobile/.env`, `apps/desktop/.env` (gitignored)                                                                          |
| Prod env (both apps)               | `apps/mobile/.env.production`, `apps/desktop/.env.production` (gitignored)                                                    |

## Related ADRs

- [0009 — Mobile App Technology Choices](../adr/0009-mobile-app-technology-choices.md)
- [0010 — Offline Sync Strategy with WatermelonDB](../adr/0010-offline-sync-strategy.md)
- [0015 — Desktop App Technology Choice](../adr/0015-desktop-app-technology-choice.md)
- [0016 — Local Fastlane Builds](../adr/0016-local-fastlane-builds.md) (supersedes [0011](../adr/0011-app-store-deployment-strategy.md))
- [0062 — Desktop PKCE Draws From a Native CSPRNG](../adr/0062-desktop-pkce-native-csprng.md) (in-project native modules)

## Cross-platform notes

**What's shared:**

- `@drafto/shared` — database row types, API payload types, markdown converter.
- WatermelonDB schema, models, migrations, and sync driver — see
  [offline-sync.md](./offline-sync.md). These files live under
  `apps/mobile/src/db/` and `apps/desktop/src/db/` as parallel copies that must
  stay in sync.
- `@10play/tentap-editor` as the rich-text editor (WebView-based; both apps
  bridge to a shared HTML bundle).
- Supabase client setup, auth flow (email/password, Google, Apple), attachment
  queue, approval-cache logic — structurally identical across the two apps.

**What diverges:**

- **Framework**: mobile is Expo-managed with `expo-router`; desktop is bare
  React Native macOS with `@react-navigation/native-stack`. Expo modules
  (`expo-secure-store`, `expo-file-system`, `expo-image-picker`) are not
  available on macOS — desktop substitutes `react-native-keychain`,
  `react-native-fs`, and `react-native-document-picker-macos`.
- **Native shell**: mobile has no custom native code beyond Expo plugins;
  desktop has Swift/Obj-C in `apps/desktop/macos/Drafto-macOS/` for the app
  menu (`DraftoMenuManager`), the PKCE random source and SHA-256
  (`DraftoCrypto`, [ADR-0062](../adr/0062-desktop-pkce-native-csprng.md)),
  entitlements, and sandbox configuration.
- **Navigation**: mobile uses file-based routes under `apps/mobile/app/`;
  desktop uses imperative stack navigation rooted in `apps/desktop/src/App.tsx`.
- **Auth storage**: `expo-secure-store` (iOS/Android) vs. `react-native-keychain`
  (macOS). Both implement the same adapter interface for the Supabase client.

**Backend routing (from `CLAUDE.md` "Mobile Build Environment Mapping"):**

| Build              | Env file          | Supabase project | Project ref            |
| ------------------ | ----------------- | ---------------- | ---------------------- |
| Mobile debug / dev | `.env`            | drafto-dev       | `huhzactreblzcogqkbsd` |
| Mobile release     | `.env.production` | drafto.eu        | `tbmjbxxseonkciqovnpl` |
| Desktop dev run    | `.env`            | drafto-dev       | `huhzactreblzcogqkbsd` |
| Desktop release    | `.env.production` | drafto.eu        | `tbmjbxxseonkciqovnpl` |

Git worktrees do not copy these env files — see the worktree setup section of
`CLAUDE.md` before building in one.

## Modifying safely

- **Treat mobile and desktop as a single feature surface.** Any new user-facing
  behavior should ship on all three native platforms in one PR (or be
  explicitly scoped with a written reason). See the "Cross-Platform Feature
  Workflow" section of `CLAUDE.md`.
- **Shared DB layer:** changes in `apps/mobile/src/db/` must be mirrored in
  `apps/desktop/src/db/` (schema, models, migrations, sync). See
  [offline-sync.md](./offline-sync.md) for the invariants.
- **Expo config plugins** under `apps/mobile/plugins/` run during `expo
prebuild`. If you add native config, write a config plugin rather than
  editing generated `android/` or `ios/` folders — `prebuild` will wipe manual
  edits.
- **Desktop native code** under `apps/desktop/macos/Drafto-macOS/` is checked
  in directly (no prebuild). Update `Info.plist` and `Drafto.entitlements`
  together when adding new permissions or capabilities.
- **New desktop native capability** goes into an in-project module next to
  `DraftoMenuManager` and `DraftoCrypto`, not an npm package with native code,
  which would need a `pnpm install` in the fossil
  ([ADR-0062](../adr/0062-desktop-pkce-native-csprng.md),
  [ADR-0027](../adr/0027-desktop-react-version-locked-to-react-native-macos.md)).
  Add each new file to `apps/desktop/macos/Drafto.xcodeproj/project.pbxproj`:
  a file reference and group entry, plus a build file and Drafto-macOS Sources
  entry for a `.mm`. CI never builds the macOS target, so a missed entry shows
  up only in the fossil's beta build, as a `null` module.
- **Mac App Review checks the menu bar and the window.** Every enabled menu
  item must do something. `MenuProvider` reports which actions are handled
  (its own theme and Help actions, plus whatever the mounted screen registered
  with `useMenuActions`), and `DraftoMenuManager`'s `validateMenuItem:` disables
  the rest, so New Note, Search and Find are greyed out on the login screen.
  A screen disables one of its own items by passing `undefined` for that
  action: New Note stays greyed out until a notebook is selected. A command
  always runs the handler from the screen's latest render, so handlers may read
  state. App-wide actions such as Help → Drafto Help belong in `MenuProvider` itself,
  so they work on every screen. Don't add a Settings… item until there is a
  settings window. After the user closes the main window, the Dock icon and
  Window → Drafto (⌘0) bring it back (`showMainWindow:` in `AppDelegate.mm`),
  and any Drafto menu command reopens it first. Without that the app runs with
  no window, which App Review rejects.
- **Versioning:** bump `apps/mobile/package.json` or `apps/desktop/package.json`
  per the rules in `CLAUDE.md` ("Mobile Versioning" / "Desktop Versioning").
  Build numbers are auto-incremented by Fastlane — do not bump manually.
- **Bundle ID:** iOS, Android, and macOS all ship under `eu.drafto.mobile` and
  share App Store Connect App ID `6760675784`. Do not fork these.
- **Tests that catch regressions:**
  - `apps/mobile/__tests__/` and `apps/desktop/__tests__/` (Jest unit +
    integration)
  - `apps/mobile/e2e/` (Maestro, Android only, local-only)
  - `packages/shared/` tests for any change to shared types or the markdown
    converter

## Verify

```bash
cd apps/mobile && pnpm typecheck && pnpm lint && pnpm test
cd apps/desktop && pnpm typecheck && pnpm lint && pnpm test
cd packages/shared && pnpm test
```

For builds and releases (TestFlight, Google Play, Mac App Store), see
[../operations/builds-and-releases.md](../operations/builds-and-releases.md).
