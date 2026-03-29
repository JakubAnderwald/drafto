# 0015 — Desktop App Technology Choice

- **Status**: Accepted
- **Date**: 2026-03-29
- **Authors**: Jakub

## Context

Drafto has a web app (Next.js) and mobile app (Expo + React Native 0.83). Users want native macOS desktop access with the same offline-first architecture. The desktop app must:

- Work offline with local SQLite storage and background sync to Supabase
- Feel like a native Mac application (AppKit components, not a WebView wrapper)
- Share as much code as possible with the existing mobile app (WatermelonDB, sync, hooks, data layer)
- Be distributed via the Mac App Store
- Use the same rich text editor (TipTap/ProseMirror-based)

## Decision

We adopt **React Native macOS** ([microsoft/react-native-macos](https://github.com/microsoft/react-native-macos)) for the desktop app, using a bare React Native workflow (no Expo).

Key decisions:

1. **React Native macOS 0.81.5** — renders actual native AppKit components (NSView, NSTextField, etc.), not WebView wrappers. Used by Microsoft in their Office apps.
2. **Bare React Native workflow** — Expo does not support macOS targets. The desktop app uses `@react-native-community/cli` for native builds.
3. **WatermelonDB** — same offline-first database as mobile. The JSI C++ SQLite adapter is platform-agnostic; only the podspec needed patching to add macOS platform support (single-line change via `pnpm patch`).
4. **Monorepo integration** — `apps/desktop/` as a new workspace package (`@drafto/desktop`), sharing `@drafto/shared` types and constants.
5. **Min macOS 14.0** (Sonoma) — required by react-native-macos 0.81.5's framework dependencies.
6. **Bundle ID**: `eu.drafto.desktop`

### Code reuse from mobile (~70%)

| Layer                           | Reusable | Adaptation needed                                        |
| ------------------------------- | -------- | -------------------------------------------------------- |
| `@drafto/shared`                | 100%     | None                                                     |
| WatermelonDB schema + models    | 100%     | None (byte-for-byte copies)                              |
| Sync logic (`src/db/sync.ts`)   | ~90%     | Replace Expo-specific imports                            |
| Auth provider                   | ~80%     | Replace `expo-secure-store` with `react-native-keychain` |
| Database provider               | ~85%     | Replace `AppState` with window focus events              |
| Hooks (auto-save, search, etc.) | ~75%     | Adapt navigation/imports                                 |
| UI components                   | ~40%     | Restyle for macOS conventions                            |

### Expo module replacements

| Expo Module         | Bare RN Replacement                                      |
| ------------------- | -------------------------------------------------------- |
| `expo-router`       | `@react-navigation/native`                               |
| `expo-secure-store` | `react-native-keychain`                                  |
| `expo-file-system`  | `react-native-fs`                                        |
| `expo-image-picker` | Native file dialog                                       |
| `expo-crypto`       | `react-native-get-random-values` + `crypto.randomUUID()` |
| `expo-constants`    | Environment variables via config                         |

## Consequences

- **Positive**: ~70% code reuse with mobile — same database, models, sync engine, and most hooks. TypeScript throughout. Same team and language skills.
- **Positive**: Native AppKit rendering gives a genuine Mac experience (native sidebar, toolbar, context menus, keyboard shortcuts).
- **Positive**: Same WatermelonDB sync protocol means all platforms stay in sync with identical conflict resolution behavior.
- **Negative**: React Native version pinned to 0.81.x (behind mobile's 0.83). The shared package is pure TypeScript so this doesn't cause issues, but the desktop app may lag behind on RN features.
- **Negative**: No Expo tooling — builds, signing, and native module management must be handled manually via Xcode and CocoaPods.
- **Negative**: WatermelonDB and simdjson required `pnpm patch` to add macOS platform support to their podspecs. These patches must be maintained when upgrading these dependencies.
- **Neutral**: Separate build pipeline from mobile (no EAS). CI uses macOS runners with `xcodebuild`.

## Alternatives Considered

### Tauri v2

Rejected because it renders via WebView (WKWebView on macOS). While lightweight (~10MB bundle vs Electron's 100MB+), it doesn't provide native AppKit components. The app would look and feel like a web app, not a native Mac app.

### Electron

Rejected for the same WebView-based rendering concern as Tauri, plus significantly larger bundle size (100-150MB). Would provide zero code reuse with the React Native mobile app.

### Swift/SwiftUI

Would provide the best native experience, but requires an entirely separate codebase in a different language. Zero code reuse with the existing TypeScript/React Native mobile app — the database layer, sync engine, models, and all hooks would need to be reimplemented in Swift.

### React Native macOS with Expo

Not possible — Expo does not support macOS as a target platform. The bare React Native workflow is the only option for macOS support with react-native-macos.
