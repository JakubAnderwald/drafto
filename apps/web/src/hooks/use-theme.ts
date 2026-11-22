"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  syncThemeColorMeta,
  THEME_STORAGE_KEY as STORAGE_KEY,
  type ResolvedTheme,
} from "@/lib/theme/theme-chrome";

export type Theme = "light" | "dark" | "system";
export type { ResolvedTheme };

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // localStorage may not be available in some environments
  }
  return "system";
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? getSystemTheme() : theme;
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  // `color-scheme` follows the class through globals.css; the meta needs setting.
  document.documentElement.classList.toggle("dark", resolved === "dark");
  syncThemeColorMeta(resolved);
}

// External store for theme preference
let listeners: Array<() => void> = [];
let currentTheme: Theme = typeof window !== "undefined" ? getStoredTheme() : "system";

function subscribe(listener: () => void): () => void {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot(): Theme {
  return currentTheme;
}

function getServerSnapshot(): Theme {
  return "system";
}

function setThemeInternal(theme: Theme) {
  currentTheme = theme;
  const resolved = resolveTheme(theme);
  applyTheme(resolved);
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, theme);
    }
  } catch {
    // localStorage may not be available in some environments
  }
  listeners.forEach((l) => l());
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const resolvedTheme = resolveTheme(theme);

  // Listen for system preference changes when theme is "system"
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (currentTheme === "system") {
        applyTheme(getSystemTheme());
        listeners.forEach((l) => l());
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Apply theme on mount
  useEffect(() => {
    applyTheme(resolveTheme(currentTheme));
  }, []);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeInternal(newTheme);
  }, []);

  return { theme, resolvedTheme, setTheme } as const;
}
