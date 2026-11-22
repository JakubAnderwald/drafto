"use client";

import { useTheme } from "@/hooks/use-theme";

/**
 * Keeps the theme applied on every page, not only those with a theme toggle (#865). Mounted
 * once in the root layout, it re-adds the `theme-color` meta if a client-side re-render of the
 * root dropped it, and follows the OS theme under "system". Renders nothing.
 */
export function ThemeSync(): null {
  useTheme();
  return null;
}
