# 0089 — macOS Native Appearance Follows the In-App Theme

- **Status**: Accepted
- **Date**: 2026-11-21
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

The macOS app lets you choose Light, Dark or System in View → Appearance (and in the sidebar's account menu). `apps/desktop/src/providers/theme-provider.tsx` resolves that choice to `isDark` and recolours the React content. Nothing told AppKit about it, so `NSApp.appearance` stayed `nil` and the native chrome kept following macOS: the title bar, the menu bar's menus, `NSAlert` sheets (every `Alert.alert`, such as the sign-out confirmation) and scroll bars. With Drafto on Dark and macOS on Light, the result was a dark window under a white title bar, with white alerts. This came up while fixing PrimeTestLab report 10668 item M-04, the Android equivalent ([ADR-0087](./0087-android-navigation-bar-follows-in-app-theme.md)), which listed it as a follow-up (#861).

`react-native-macos` already provides the call this needs. `Appearance.setColorScheme(scheme)` reaches `RCTAppearance setColorScheme:` (`React/CoreModules/RCTAppearance.mm`), which on macOS sets `NSApp.appearance` on the main queue: `NSAppearanceNameAqua` for `"light"`, `NSAppearanceNameDarkAqua` for `"dark"`, and `nil` for `"unspecified"`. `nil` means the app follows the system appearance again.

ADR-0087 rejected `Appearance.setColorScheme()` on Android. There it calls `AppCompatDelegate.setDefaultNightMode`, after which `useColorScheme()` reports the forced value, so "System" could no longer see the real OS theme.

## Decision

- Add `apps/desktop/src/lib/native/app-appearance.ts`, the one place that maps the in-app theme to the native appearance:
  - `colorSchemeForTheme(theme)` is a pure mapping: `light` → `"light"`, `dark` → `"dark"`, `system` → `"unspecified"`.
  - `applyAppAppearance(theme)` calls `Appearance.setColorScheme(colorSchemeForTheme(theme))`.
- `ThemeProvider` calls `applyAppAppearance(theme)` in an effect keyed on the stored preference (`theme`), not on the resolved `isDark`. It runs on mount (`system`, so `nil`), when the stored preference loads, and on every change from the menu or the sidebar.
- A theme picked before the stored preference has loaded wins: `ThemeProvider` ignores the stored value once `setTheme` has run. Without that guard, a late AsyncStorage read would now also flip the native chrome back.
- No native code changes. `DraftoMenuManager.updateMenuState` still only sets the menu checkmarks.

On macOS, the Android objection doesn't hold:

- While Light or Dark is forced, `useColorScheme()` reports the forced scheme. `ThemeProvider` ignores `useColorScheme()` unless the preference is System, so this changes nothing.
- Choosing System sets `NSApp.appearance = nil`. The root view's effective appearance changes, `RCTSurfaceHostingView viewDidChangeEffectiveAppearance` posts `RCTUserInterfaceStyleDidChangeNotification`, and `RCTAppearance` emits `appearanceChanged`. So `useColorScheme()` reports the OS scheme again. Later OS changes reach it through the same path, which is how System follows a live switch.

## Consequences

- **Positive**: The title bar, alert sheets and scroll bars match the theme you chose. System behaves as before, including live OS switches. The change is small and in JS, with nothing for the Xcode project.
- **Negative**: Menu-bar menus (File, Edit, View, …) still follow macOS. On build 96 under macOS 27.0.1, with Drafto on Dark and macOS on Light, the View menu showed black text on a light material, and the reverse with the themes swapped. A minimal AppKit app on the same Mac showed the same: its menu-bar menu stayed light under a forced DarkAqua, whether set through `NSApp.appearance` alone or also through `NSMenu.appearance` on the main menu and its submenus. AppKit draws these menus with the system menu bar's appearance, and no public API changes that. #861's acceptance criterion for menus can't be met.
- **Negative**: At launch the chrome follows macOS until AsyncStorage returns the stored preference, a fraction of a second. The React content already behaves the same way.
- **Negative**: When switching back to System, the JS `setColorScheme("unspecified")` reads `getColorScheme()` synchronously, before the main-queue change has landed, so for about one frame `useColorScheme()` can still report the previously forced scheme. The native `appearanceChanged` event corrects it right away.
- **Neutral**: CI doesn't build macOS. The checks are unit tests for the mapping and the provider, plus the In-Test scenario `apps/desktop/e2e/in-test/scenarios/861-native-appearance.sh`. That scenario measures the title bar, the View menu, the content and the sign-out sheet from window captures, with the new `bin/luma` helper. Web and mobile are unchanged; Android's system bars are covered by ADR-0087.

## Alternatives Considered

- **A native module that writes `NSApp.appearance`** (for example in `DraftoMenuManager.updateMenuState`, which already receives the theme): duplicates what `RCTAppearance` does, and mixes the menu's checkmarks with app appearance in one module. Rejected.
- **A native module that stores the preference in `NSUserDefaults` and applies it in `AppDelegate` before JS starts**: it would remove the launch window during which the chrome follows macOS. It needs new native code, Xcode project changes, and a second copy of the preference kept in sync with AsyncStorage, all for a gap of a fraction of a second that the React content shares. Rejected for now; worth revisiting if the launch flash is reported.
- **Setting `window.appearance` on the main window only**: leaves alert sheets' parent panels and other app-level windows on the OS appearance. Rejected.
- **Setting `NSMenu.appearance` on the main menu and its submenus** (in `DraftoMenuManager`): tried in a minimal AppKit app on macOS 27.0.1, and the menu-bar menus stayed on the system appearance. Not adopted.
