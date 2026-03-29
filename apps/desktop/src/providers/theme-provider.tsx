import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

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
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === "light" || stored === "dark" || stored === "system") {
          setThemeState(stored);
        }
      })
      .catch(() => {
        // Storage unavailable; keep default "system" preference
      });
  }, []);

  const setTheme = useCallback((newTheme: ThemePreference) => {
    setThemeState(newTheme);
    AsyncStorage.setItem(STORAGE_KEY, newTheme);
  }, []);

  const isDark = theme === "system" ? systemScheme === "dark" : theme === "dark";
  const semantic = useMemo(() => getSemanticColors(isDark), [isDark]);

  const value = useMemo(
    () => ({ semantic, isDark, theme, setTheme }),
    [semantic, isDark, theme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
