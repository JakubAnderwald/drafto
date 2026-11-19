import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as NavigationBar from "expo-navigation-bar";

import { useTheme } from "@/providers/theme-provider";

/** The colour of the system bars' content (icons, text, buttons): always explicit. */
export type SystemBarContentStyle = "light" | "dark";

/**
 * The content style of both system bars for the resolved in-app theme: light
 * content on a dark theme, dark content on a light one.
 *
 * Both calls SystemBars makes name the colour of the bar's *content*:
 * expo-status-bar's `style` and expo-navigation-bar's `setButtonStyleAsync`. So
 * a dark theme passes "light" to both. expo-navigation-bar's `setStyle` is the
 * odd one out: it names the colour of the *bar* (`setStyle("dark")` gives light
 * buttons), so a call to it would need the opposite mapping. Don't "align" a
 * mix of the two, that brings back the bug this fixes (ADR-0087).
 *
 * Never "auto" or "inverted": both read the OS colour scheme, so the bar would
 * follow the OS while the app is themed the other way.
 */
export function systemBarContentStyleFor(isDark: boolean): SystemBarContentStyle {
  return isDark ? "light" : "dark";
}

/**
 * The first Android API level (10, Q) whose 3-button navigation bar is transparent
 * with a contrast scrim that follows the light-appearance flag.
 */
export const MIN_NAVIGATION_BAR_STYLE_API_LEVEL = 29;

/**
 * Whether SystemBars may set the navigation bar's button style on this device:
 * Android API 29 and later only.
 *
 * Below API 29 React Native's `enableEdgeToEdge()` paints the bar a fixed colour
 * from the OS theme at launch (a 90%-white scrim on API 26-28 with the OS in
 * Light, a dark translucent one otherwise), and there is no contrast scrim to
 * follow the flag. Flipping only the buttons there would put light buttons on
 * that near-white bar, so the bar keeps React Native's matching OS pair. API
 * 24-25 has no light navigation-bar flag at all.
 */
export function canStyleNavigationBar(): boolean {
  return (
    Platform.OS === "android" &&
    typeof Platform.Version === "number" &&
    Platform.Version >= MIN_NAVIGATION_BAR_STYLE_API_LEVEL
  );
}

/**
 * Sets the Android navigation bar's button style, and with it the 3-button
 * contrast scrim. Never throws or rejects.
 *
 * Not `NavigationBar.setStyle`: in expo-navigation-bar 55 it starts the native
 * `setButtonStyleAsync` and drops the promise, so a rejection (say, no current
 * activity while the JS context outlives it) would be an unhandled rejection.
 * The public `setButtonStyleAsync` makes the same native call and returns the
 * promise. It is marked deprecated in favour of `setStyle`; if a release drops
 * it, the typecheck fails here.
 */
async function applyNavigationBarButtonStyle(style: SystemBarContentStyle): Promise<void> {
  try {
    await NavigationBar.setButtonStyleAsync(style);
  } catch (error) {
    // Cosmetic and retried on the next theme change or resume. The mobile app has
    // no error reporter, so warn like its other best-effort native calls.
    console.warn("[SystemBars] Could not style the navigation bar:", error);
  }
}

/**
 * Keeps the OS system bars in step with the in-app theme.
 *
 * - Status bar (iOS and Android): through expo-status-bar.
 * - Navigation bar (Android API 29+, see `canStyleNavigationBar`): React
 *   Native's edge-to-edge setup picks the bar's light/dark appearance from the
 *   OS theme when the activity is created, and on 3-button navigation Android
 *   paints its contrast scrim from that flag.
 *   With the OS in Light and Drafto in Dark that is a 90%-white bar under a dark
 *   tab bar. Setting the button style from `isDark` makes the scrim follow the app.
 *
 * "System" needs nothing extra: `isDark` comes from `useColorScheme()`, which
 * updates when the OS theme changes. The style is re-applied whenever the app
 * comes back to the foreground, because a recreated activity resets the flag to
 * the OS value while the JS context lives on. That listener is added once and
 * reads the latest style from a ref, so it never applies a style captured at an
 * older render.
 */
export function SystemBars() {
  const { isDark } = useTheme();
  const style = systemBarContentStyleFor(isDark);
  const latestStyle = useRef(style);

  useEffect(() => {
    latestStyle.current = style;
    if (!canStyleNavigationBar()) return;
    void applyNavigationBarButtonStyle(style);
  }, [style]);

  useEffect(() => {
    if (!canStyleNavigationBar()) return;

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void applyNavigationBarButtonStyle(latestStyle.current);
      }
    });
    return () => subscription.remove();
  }, []);

  return <StatusBar style={style} />;
}
