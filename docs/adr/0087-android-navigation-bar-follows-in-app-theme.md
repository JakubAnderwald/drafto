# 0087 — Android Navigation Bar Follows the In-App Theme

- **Status**: Accepted
- **Date**: 2026-11-18
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

PrimeTestLab report 10668 (item M-04, Drafto Android 1.4.7 on a Xiaomi Mi 11, Android 14, 3-button navigation) found that with the app set to Dark and the phone set to Light, the system navigation bar stays light grey under the dark tab bar. The reverse mismatch (phone Dark, app Light) gives a dark-grey bar under the white tab bar.

The mobile app is always edge-to-edge (Expo SDK 55, React Native 0.83, `edgeToEdgeEnabled=true`). When the activity is created, React Native's `Window.enableEdgeToEdge()` makes the navigation bar transparent, keeps `isNavigationBarContrastEnforced = true`, and sets `isAppearanceLightNavigationBars` from the **OS** night mode. On 3-button navigation Android draws a contrast scrim over a transparent bar, and the scrim's colour follows that light-appearance flag: AOSP `DecorView.calculateBarColor` uses a 90%-white scrim when the flag is set and a dark translucent one when it is not. Gesture navigation draws no scrim, which is why only 3-button phones show the bug.

The in-app theme ([ADR-0005](./0005-dark-mode-implementation.md) on web; `apps/mobile/src/providers/theme-provider.tsx` on mobile) resolves `isDark` from the stored preference (System, Light or Dark) and the OS scheme. The status bar already followed it through `expo-status-bar`, but nothing in the app touched the navigation bar after start-up, so its flag kept the OS value from launch.

## Decision

- Add `expo-navigation-bar` (the SDK 55 version, `~55.0.17`, installed with `npx expo install`). It is a first-party Expo module. Do **not** add its config plugin: the plugin's `enforceContrast` option writes the theme attribute, which React Native's runtime `enableEdgeToEdge()` overrides after the theme is applied, so it would do nothing.
- Add `apps/mobile/src/components/system-bars.tsx`. `SystemBars` is the one place that keeps the OS system bars in step with the in-app theme:
  - It renders `expo-status-bar`'s `StatusBar` (light content on Dark, dark content on Light), which moves out of `app/_layout.tsx`.
  - On Android it calls `NavigationBar.setButtonStyleAsync(isDark ? "light" : "dark")` whenever the resolved `isDark` changes. That sets `isAppearanceLightNavigationBars` on the activity window, so the scrim and the buttons follow the app theme. The call is awaited inside a `try`/`catch` and a failure is logged with `console.warn`, since the style is cosmetic and is retried on the next theme change or resume.
  - It does not use `NavigationBar.setStyle`, the replacement the library recommends. In `expo-navigation-bar` 55.0.17, `setStyle` maps the bar style to a button style, then starts the same native `setButtonStyleAsync` and drops its promise, so a rejection (no current activity while the JS context outlives it) cannot be caught and surfaces as an unhandled rejection. `setButtonStyleAsync` is marked deprecated; if a release removes it, the typecheck fails and we move to whatever `setStyle` then returns.
  - The two style names mean opposite things, which is why the code maps them in one place (`systemBarContentStyleFor`): `setStyle` names the **bar** colour (`setStyle("dark")` gives light buttons), while `setButtonStyleAsync` and `expo-status-bar`'s `style` name the **content** colour. On a dark theme both bars get `"light"`.
  - It re-applies the style when the app returns to the foreground (`AppState` `active`), because a recreated activity resets the flag to the OS value while the JS context lives on. The listener is added once and reads the latest style from a ref.
  - It never passes `"auto"` or `"inverted"`. Both read the OS colour scheme, which is the bug again.
- `app/_layout.tsx` mounts `<SystemBars />` once, directly under `ThemeProvider` and above `RouteGuard`, so the bars follow the theme on the launch loading screen as well as in the app.
- "System" needs no extra code. `isDark` comes from `useColorScheme()`, which updates when the OS theme changes. `MainActivity` declares `uiMode` in `configChanges`, so the activity is not recreated and the effect re-runs.
- The Settings theme options get `testID="theme-option-<system|light|dark>"` so Maestro can select them by id.
- The scrim stays on (contrast enforcement is kept). We only control its light/dark flag.

## Consequences

- **Positive**: The navigation bar matches the in-app theme in all three settings, on every Android navigation mode. The status bar and the navigation bar are kept in one component, so they cannot drift apart again.
- **Positive**: No new native code of our own and no config plugin; the module autolinks and every release lane already runs `expo prebuild --clean`.
- **Negative**: A new native module, so the next mobile release is a minor version bump and dev clients need a rebuild.
- **Negative**: At cold start the bar follows the OS for a moment, until the stored preference loads from SecureStore. The status bar already behaves the same way.
- **Negative**: React Native `Modal` windows (only `DeleteAccountDialog`) run their own `enableEdgeToEdge()` from the OS theme and copy only the status-bar appearance, so the bar can still show the OS scrim behind that dialog's dim. `SystemBars` styles only the activity window. This is a tracked follow-up (for example, replacing that `Modal` with an in-tree overlay, which stays in the activity window), not part of this change.
- **Neutral**: iOS has no navigation bar. `SystemBars` skips the call there, so iOS behaviour is unchanged (the `StatusBar` only moved). Web and macOS have no navigation bar either; macOS window chrome following the in-app theme (`NSApp.appearance`) is a separate follow-up.
- **Neutral**: Expo's docs warn that `setStyle` (and so the same native call through `setButtonStyleAsync`) has no effect on the Android 15 emulator. The E2E check (`apps/mobile/e2e/android-only/11-dark-nav-bar.yaml` plus the host-side `apr=` flag and pixel checks) runs on API 34, the QA device's Android 14.

## Alternatives Considered

- **`Appearance.setColorScheme()`**: on Android it calls `AppCompatDelegate.setDefaultNightMode` and makes `useColorScheme()` return the forced value, so "System" could no longer see the real OS theme. Because of `configChanges`, React Native would also not re-run `enableEdgeToEdge`, so the bar would still not change. Rejected.
- **`NavigationBar.setStyle("auto")`**: reads the OS scheme, the same bug. Rejected.
- **Turn off contrast enforcement** (set `window.isNavigationBarContrastEnforced = false` after `super.onCreate`, through a config plugin or a `MainActivity` override): the 3-button bar becomes fully transparent and shows the tab bar's exact colour. It needs native code that `prebuild` regenerates, and it is not needed if the scrim follows the flag. Kept as the fallback if the device check shows the scrim ignores the flag.
- **The `expo-navigation-bar` config plugin's `enforceContrast: false`**: overridden at runtime by React Native's `enableEdgeToEdge()`, so it would have no effect. Rejected.
- **`setBackgroundColorAsync`**: does nothing under edge-to-edge. Rejected.
- **`setStyle`** (the non-deprecated call): drops the native promise, so a failure is an unhandled rejection. Rejected in favour of `setButtonStyleAsync`, see Decision.
