import { Appearance } from "react-native";

import type { ThemePreference } from "@/providers/theme-provider";

/** The values `Appearance.setColorScheme` accepts. "unspecified" means follow the OS. */
export type AppColorScheme = "light" | "dark" | "unspecified";

/**
 * Maps the in-app theme preference to the colour scheme the native app should use. "system"
 * maps to "unspecified", which hands the appearance back to macOS.
 */
export function colorSchemeForTheme(theme: ThemePreference): AppColorScheme {
  switch (theme) {
    case "light":
      return "light";
    case "dark":
      return "dark";
    case "system":
      return "unspecified";
  }
}

/**
 * Makes the native chrome (title bar, NSAlert sheets, scroll bars) follow the
 * in-app theme. Menu-bar menus keep following macOS: AppKit ignores the app's appearance for
 * them. On macOS, react-native-macos's `Appearance.setColorScheme` sets `NSApp.appearance`:
 * Aqua for "light", DarkAqua for "dark", and nil for "unspecified", so the app follows the OS
 * again, live changes included. See ADR-0089.
 */
export function applyAppAppearance(theme: ThemePreference): void {
  Appearance.setColorScheme(colorSchemeForTheme(theme));
}
