import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";

import { getSemanticColors, type SemanticColors } from "@/theme/tokens";

export type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
  semantic: SemanticColors;
  isDark: boolean;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}

const STORAGE_KEY = "drafto_theme_preference";

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [theme, setThemeState] = useState<ThemePreference>("system");
  useEffect(() => {
    SecureStore.getItemAsync(STORAGE_KEY).then((stored) => {
      if (stored === "light" || stored === "dark" || stored === "system") {
        setThemeState(stored);
      }
    });
  }, []);

  const setTheme = useCallback((newTheme: ThemePreference) => {
    setThemeState(newTheme);
    SecureStore.setItemAsync(STORAGE_KEY, newTheme);
  }, []);

  const isDark = theme === "system" ? systemScheme === "dark" : theme === "dark";
  const semantic = useMemo(() => getSemanticColors(isDark), [isDark]);

  const value = useMemo(
    () => ({ semantic, isDark, theme, setTheme }),
    [semantic, isDark, theme, setTheme],
  );

  // Render children even before loaded to avoid flash — defaults to system theme
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
