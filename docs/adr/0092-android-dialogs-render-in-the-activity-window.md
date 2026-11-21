# 0092 — Android Dialogs Render in the Activity Window

- **Status**: Accepted
- **Date**: 2026-11-21
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

[ADR-0087](./0087-android-navigation-bar-follows-in-app-theme.md) made the Android navigation bar follow the in-app theme by setting the light-appearance flag on the activity window (`SystemBars`, through `expo-navigation-bar`). It listed one gap as a follow-up: React Native `Modal` windows. Issue #862 tracks it. `DeleteAccountDialog` was the app's only `Modal`.

On Android, React Native 0.83 shows a `Modal` in a `Dialog`, which is a window of its own (`ReactModalHostView.showOrUpdate`). With edge-to-edge on, it always calls `Window.enableEdgeToEdge()` on that window. That sets `isAppearanceLightNavigationBars` from the **OS** night mode (`WindowUtil.kt`, `UiModeUtils.isDarkMode`). `updateSystemAppearance()` then copies only the status-bar flag from the activity. The focused window's flag decides the 3-button contrast scrim. So with the OS in Light and Drafto in Dark, the bar turned light while the dialog was open, and the reverse. On the API 34 emulator with the pre-fix build, QA case D measured luminance 0.799 with `apr=LIGHT_NAVIGATION_BARS` on the focused dialog window.

Nothing in JS can reach that window: `expo-navigation-bar` acts on the activity window, and the `navigationBarTranslucent` prop is forced on under edge-to-edge. React Native's Android code ships as the prebuilt `react-android` AAR, so a `pnpm patch` of `ReactModalHostView.kt` would not take effect without building React Native from source.

## Decision

- Add `apps/mobile/src/components/ui/modal-overlay.tsx`:
  - **`ModalOverlay`** takes `visible`, `onRequestClose`, `testID` and `children`, the `Modal` props the app used.
  - On **Android** it renders nothing in place. It hands its content to **`ModalOverlayHost`**, which draws it after the app in the activity window. `SystemBars` already themes that window's bars, so the bar keeps the in-app theme with no further code.
  - On **iOS** it is still an RN `Modal`. iOS has no navigation bar, and the native modal keeps VoiceOver focus containment and keyboard handling as they were.
- `ModalOverlayHost` is mounted once in `app/_layout.tsx`, inside every app-wide provider (theme, offline banner, auth, toasts, database) and around `RouteGuard` and the navigator. The overlay covers the header and the tab bar, as the `Modal` window did. Its content reads the same app-wide contexts on Android as in an iOS `Modal`, so a dialog that works on iOS can't fail on Android for a missing provider. Toasts draw above the overlay's dim. They don't take touches.
- On Android, the overlay does what the `Modal` window did for free:
  - Hardware back calls `onRequestClose` through `BackHandler`, while the overlay is visible and for the top overlay only. It always returns `true`, so back never leaves the screen behind an open dialog. This is the app's first `BackHandler`.
  - A full-screen layer takes every touch, so nothing behind it can be pressed.
  - The app behind it is set to `importantForAccessibility="no-hide-descendants"` while an overlay is open, so TalkBack stays in the dialog. The dialog's card also keeps `accessibilityViewIsModal`.
  - TalkBack's focus moves into the overlay once it has faded in. A new window takes focus by itself, but a view in the same window doesn't, and the element that opened it is now hidden. The optional `initialFocusRef` names the target (`DeleteAccountDialog` passes its title), which gets `AccessibilityInfo.sendAccessibilityEvent(…, "focus")`.
  - It fades in over 150 ms on the native driver.
  - Nothing renders while it is hidden.
- `DeleteAccountDialog` uses `ModalOverlay`. Its `KeyboardAvoidingView` uses `behavior="height"` on Android: the dialog window's `SOFT_INPUT_ADJUST_RESIZE` is gone, and the edge-to-edge activity window isn't resized by the keyboard.
- New dialogs use `ModalOverlay`, not RN `Modal`.
- QA 10668 runner:
  - It gains cases D (OS Light, app Dark) and E (OS Dark, app Light). They run `apps/mobile/e2e/android-only/12-delete-dialog-nav-bar.yaml`, which leaves the dialog open, and then the same `nav-bar-dark` / `nav-bar-light` host checks as flow 11.
  - It now waits for 3-button navigation to take effect. If it never does, the run stops when a nav-bar or FAB step is selected, and warns otherwise. The overlay switch is asynchronous: before this change, a first run on a fresh emulator stayed in gesture mode, and in gesture mode every nav-bar check passes without measuring the scrim.

## Consequences

- **Positive**: The navigation bar keeps the in-app theme while the delete-account dialog is open, on every Android navigation mode, without native code or patches.
- **Positive**: Any later dialog gets the same behaviour by using `ModalOverlay`.
- **Negative**: Back handling, touch blocking and TalkBack containment are ours to maintain on Android rather than the platform's. Unit tests cover them. TalkBack containment through `no-hide-descendants` was checked on the emulator, not on a physical device.
- **Negative**: The overlay's content renders at the host's place in the tree, outside the navigator. Navigator context (`useNavigation`, screen options, a screen's own providers) doesn't reach it on Android. Read such context in the owner and pass values down.
- **Negative**: The overlay fades in but closes at once. The `Modal` window also faded out. Drawing the closing frame would mean keeping hidden content mounted.
- **Neutral**: iOS behaviour is unchanged. Web and macOS have no Android navigation bar and are not affected.

## Alternatives Considered

- **Patch `ReactModalHostView` to copy `isAppearanceLightNavigationBars` from the activity**: the smallest fix, but React Native's Android code is the prebuilt `react-android` AAR here, so a patch would need building React Native from source on every release lane. Rejected.
- **A `transparentModal` expo-router route**: it stays in the activity window and gets native back handling. But it adds a route that the offline-banner screen layout and `MODAL_ROUTES` would have to account for, and the dialog's `onConfirm` couldn't be a prop any more. Rejected for one dialog. It is still an option for a future full-screen flow.
- **An overlay inside the Settings screen**: it would not cover the header or the tab bar, which the Tabs navigator draws outside the screen, and it would scroll with the Settings list. Rejected.
- **A portal library (`@gorhom/portal` and similar)**: a new dependency for about 60 lines of host code. Rejected.
