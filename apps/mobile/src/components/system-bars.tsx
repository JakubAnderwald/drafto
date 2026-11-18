import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as NavigationBar from "expo-navigation-bar";

import { useTheme } from "@/providers/theme-provider";

/** The two navigation-bar styles SystemBars ever sets: an explicit light or dark bar. */
export type SystemBarStyle = "light" | "dark";

/**
 * The navigation-bar style for the resolved in-app theme.
 *
 * Always explicit. "auto" and "inverted" read the OS colour scheme, so passing
 * either would bring back the bug this fixes: the bar following the OS while
 * the app is themed the other way (ADR-0087).
 */
export function navigationBarStyleFor(isDark: boolean): SystemBarStyle {
  return isDark ? "dark" : "light";
}

/**
 * Keeps the OS system bars in step with the in-app theme.
 *
 * - Status bar (iOS and Android): light content on a dark theme, dark content
 *   on a light one, through expo-status-bar.
 * - Navigation bar (Android only): React Native's edge-to-edge setup picks the
 *   bar's light/dark appearance from the OS theme when the activity is created,
 *   and on 3-button navigation Android paints its contrast scrim from that flag.
 *   With the OS in Light and Drafto in Dark that is a 90%-white bar under a dark
 *   tab bar. Setting the style from `isDark` makes the scrim follow the app.
 *
 * "System" needs nothing extra: `isDark` comes from `useColorScheme()`, which
 * updates when the OS theme changes. The style is re-applied whenever the app
 * comes back to the foreground, because a recreated activity resets the flag to
 * the OS value while the JS context lives on.
 */
export function SystemBars() {
  const { isDark } = useTheme();

  useEffect(() => {
    if (Platform.OS !== "android") return;

    const style = navigationBarStyleFor(isDark);
    NavigationBar.setStyle(style);

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        NavigationBar.setStyle(style);
      }
    });
    return () => subscription.remove();
  }, [isDark]);

  return <StatusBar style={isDark ? "light" : "dark"} />;
}
