# Mobile and Desktop Apps

**Status:** shipped **Updated:** 2026-11-18

## What it is

Drafto's native clients: an Expo + React Native app that ships to iOS and
Android, and a React Native macOS app that ships to the Mac App Store. All three
share the same offline-first data model and the same editor.

## Current state

Shipped on iOS (App Store), Android (Google Play), and macOS (Mac App Store).
All three builds run locally through Fastlane — no CI builds. Mobile is on
Expo SDK 55 / React Native 0.83.10; desktop is on React Native macOS 0.83.0 on the same `react-native` 0.83.10 ([ADR-0067](../adr/0067-desktop-moves-to-react-native-macos-0-83.md)).
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
- [0087 — Android Navigation Bar Follows the In-App Theme](../adr/0087-android-navigation-bar-follows-in-app-theme.md)

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

**System bars (Android):** `apps/mobile/src/components/system-bars.tsx`
(`SystemBars`, mounted once in `app/_layout.tsx`, directly under `ThemeProvider` and
above `RouteGuard`, so it covers the launch loading screen too) keeps the status bar and the
Android navigation bar in step with the in-app theme, not the OS theme. React
Native's edge-to-edge setup picks the navigation bar's light/dark flag from the
OS at launch, and on 3-button navigation Android paints its contrast scrim from
that flag, so Drafto in Dark under an OS in Light used to get a light-grey bar
(PrimeTestLab 10668, M-04). `SystemBars` calls `expo-navigation-bar`'s
`setButtonStyleAsync("light" | "dark")` (light buttons on a dark theme) whenever the
resolved theme changes and again when the app comes back to the foreground, and
catches a rejected native call. It uses `setButtonStyleAsync` rather than `setStyle`
because `setStyle` drops the native promise. Note that the two name opposite things:
`setStyle` names the bar colour, `setButtonStyleAsync` (like `expo-status-bar`) the
content colour. It styles the navigation bar only on API 29+ (`canStyleNavigationBar`):
below that React Native paints the bar a fixed OS-themed colour, so flipping just the
buttons would make them unreadable. Never pass `"auto"` or `"inverted"`, and
don't use `Appearance.setColorScheme()`: both tie the bar back to the OS. Known
gap, tracked as a follow-up: an RN `Modal` (`DeleteAccountDialog`) re-runs
edge-to-edge from the OS theme in its own window, which `SystemBars` does not style. iOS, web and macOS have no navigation bar. See
[ADR-0087](../adr/0087-android-navigation-bar-follows-in-app-theme.md).

**Native chrome (macOS):** `ThemeProvider` calls `applyAppAppearance(theme)`
(`apps/desktop/src/lib/native/app-appearance.ts`) whenever the stored preference changes. It
calls react-native-macos's `Appearance.setColorScheme`, which sets `NSApp.appearance`: Aqua for
Light, DarkAqua for Dark, and `nil` for System, so the title bar, `Alert.alert` sheets
and scroll bars match the in-app theme, and System follows macOS again, live changes included.
Menu-bar menus (File, View, …) are the exception: they keep following macOS, because AppKit
ignores both `NSApp.appearance` and `NSMenu.appearance` for them (checked on macOS 27.0.1).
Unlike on Android, `setColorScheme` is safe here: `ThemeProvider` reads `useColorScheme()` only
for System, and setting `nil` gives the OS scheme back to it. Until AsyncStorage returns the
stored preference at launch, the chrome follows macOS. See
[ADR-0089](../adr/0089-macos-native-appearance-follows-in-app-theme.md).

**Settings → About (PrimeTestLab 11035 S-01):** the report asked for the app
version and links to the privacy policy and support. Each platform shows them:

- **iOS and Android.** The Settings tab ends with an "About" section
  (`apps/mobile/src/components/about-section.tsx`): a Version row
  (`about-version`) and two link rows, Privacy policy (`about-privacy`) and
  Support (`about-support`). The version comes from `getAppVersionLabel()`
  (`apps/mobile/src/lib/app-version.ts`): `Constants.expoConfig.version`
  (`app.config.ts` takes it from `package.json`), plus the binary's build number
  in parentheses, e.g. "1.7.0 (82)". expo-constants reads the build number
  (`CFBundleVersion`) only on iOS. On Android it exposes no `versionCode`, and
  `expo-application` isn't a dependency, so Android shows the version alone.
  The rows open `PRIVACY_POLICY_URL` and `SUPPORT_URL` from `@drafto/shared`
  (always `https://drafto.eu/...`, even in dev builds) through
  `openExternalUrl()` (`apps/mobile/src/lib/open-external-url.ts`): the in-app
  browser, then `Linking.openURL`, then an alert with the address when both fail.
  `openAttachment()` uses the same helper.
- **Web.** `/settings` ends with an About card
  (`apps/web/src/components/settings/about-section.tsx`) below Delete account.
  It links `/privacy` and `/support` on the current origin, so a preview links
  its own copy, and holds the "Build <sha>" line, which used to sit below the
  Delete account card. The links come from `LEGAL_PAGES`
  (`apps/web/src/components/legal/legal-pages.ts`), the same list the
  signed-out `LegalLinks` renders, built on `PRIVACY_POLICY_PATH` and
  `SUPPORT_PATH` from `@drafto/shared`. The mobile URLs use those paths too, on
  `DRAFTO_WEB_ORIGIN` (`packages/shared/src/web-origin.ts`), which the sign-up
  redirect and the Apple revocation origin also derive from.
- **macOS: no change.** The desktop app has no settings window. The standard
  Drafto → About Drafto panel already shows the version and build, and
  Help → Drafto Help opens the support page (`supportUrl` in
  `apps/desktop/src/lib/config.ts`). The support page links the privacy policy.
  So the app already gives everything the About section shows, in the places
  macOS users look for it. A Settings… item would need a new settings window
  for three rows that would only repeat those menus.

No new data leaves the app, so the privacy policy needs no update.

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
  `DraftoMenuManager` and `DraftoCrypto`, not an npm package with native code
  ([ADR-0062](../adr/0062-desktop-pkce-native-csprng.md)). A native _bug_ in
  React Native goes in a `pnpm patch` under `patches/` instead
  ([ADR-0067](../adr/0067-desktop-moves-to-react-native-macos-0-83.md)).
  Add each new file to `apps/desktop/macos/Drafto.xcodeproj/project.pbxproj`:
  a file reference and group entry, plus a build file and Drafto-macOS Sources
  entry for a `.mm`. CI never builds the macOS target, so a missed entry shows
  up only in a beta build, as a `null` module.
- **Mac App Review checks the menu bar and the window.** Every enabled menu
  item must do something. `MenuProvider` reports which actions are handled
  (its own theme and Help actions, plus whatever the mounted screen registered
  with `useMenuActions`), and `DraftoMenuManager`'s `validateMenuItem:` disables
  the rest, so New Note, Search and Find are greyed out on the login screen.
  A screen disables one of its own items by passing `undefined` for that
  action: New Note is greyed out unless a notebook that still exists is
  selected and Trash isn't showing. A command always runs the handler from the
  screen's latest render, so handlers may read state. Only one screen registers
  at a time. App-wide actions such as Help → Drafto Help belong in `MenuProvider` itself,
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
