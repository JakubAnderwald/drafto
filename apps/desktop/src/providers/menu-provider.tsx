import { createContext, useContext, useEffect, useRef, useCallback } from "react";

import { useTheme } from "@/providers/theme-provider";
import type { ThemePreference } from "@/providers/theme-provider";
import {
  setupMenus,
  updateMenuState,
  addMenuActionListener,
  type MenuAction,
} from "@/lib/native/menu-manager";

type MenuActionHandlers = Partial<Record<MenuAction, () => void>>;

interface MenuContextValue {
  registerHandlers: (handlers: MenuActionHandlers) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

export function MenuProvider({ children }: { children: React.ReactNode }) {
  const { theme, setTheme } = useTheme();
  const handlersRef = useRef<MenuActionHandlers>({});

  // Set up menus once on mount
  useEffect(() => {
    setupMenus();
  }, []);

  // Sync theme state to native menu checkmarks
  useEffect(() => {
    updateMenuState({ currentTheme: theme });
  }, [theme]);

  // Subscribe to menu action events
  useEffect(() => {
    const themeActionMap: Record<string, ThemePreference> = {
      themeLight: "light",
      themeDark: "dark",
      themeSystem: "system",
    };

    const unsubscribe = addMenuActionListener((action) => {
      // Handle theme actions directly in the provider
      if (action in themeActionMap) {
        setTheme(themeActionMap[action]!);
        return;
      }

      // Delegate other actions to registered handlers
      const handler = handlersRef.current[action];
      if (handler) {
        handler();
      }
    });

    return unsubscribe;
  }, [setTheme]);

  const registerHandlers = useCallback((handlers: MenuActionHandlers) => {
    handlersRef.current = handlers;
  }, []);

  return <MenuContext.Provider value={{ registerHandlers }}>{children}</MenuContext.Provider>;
}

/**
 * Hook to register menu action handlers from a component.
 * Replaces all handlers on each call; cleans up on unmount.
 */
export function useMenuActions(handlers: MenuActionHandlers): void {
  const context = useContext(MenuContext);
  if (!context) {
    throw new Error("useMenuActions must be used within a MenuProvider");
  }

  const { registerHandlers } = context;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    registerHandlers(handlersRef.current);
    return () => registerHandlers({});
  }, [registerHandlers]);
}
