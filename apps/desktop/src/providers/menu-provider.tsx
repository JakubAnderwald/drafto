import { createContext, useContext, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { Linking } from "react-native";

import { supportUrl } from "@/lib/config";
import { useTheme } from "@/providers/theme-provider";
import type { ThemePreference } from "@/providers/theme-provider";
import {
  setupMenus,
  updateMenuState,
  addMenuActionListener,
  setEnabledMenuActions,
  type MenuAction,
} from "@/lib/native/menu-manager";

type MenuActionHandlers = Partial<Record<MenuAction, () => void>>;

interface MenuContextValue {
  registerHandlers: (handlers: MenuActionHandlers) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

const THEME_ACTIONS: Partial<Record<MenuAction, ThemePreference>> = {
  themeLight: "light",
  themeDark: "dark",
  themeSystem: "system",
};

/** Actions the provider handles itself, so they work on every screen (login included). */
const PROVIDER_ACTIONS: readonly MenuAction[] = [
  ...(Object.keys(THEME_ACTIONS) as MenuAction[]),
  "openHelp",
];

/** The actions a screen supplied a handler for. An `undefined` handler leaves its item disabled. */
function screenActions(handlers: MenuActionHandlers): MenuAction[] {
  return (Object.keys(handlers) as MenuAction[]).filter(
    (action) => typeof handlers[action] === "function",
  );
}

/** The provider's own actions plus whatever the mounted screen registered. */
function handledActions(handlers: MenuActionHandlers): MenuAction[] {
  return [...PROVIDER_ACTIONS, ...screenActions(handlers)];
}

function openHelp(): void {
  Linking.openURL(supportUrl).catch((error: unknown) => {
    console.error("Help → Drafto Help could not open", supportUrl, error);
  });
}

export function MenuProvider({ children }: { children: React.ReactNode }) {
  const { theme, setTheme } = useTheme();
  const handlersRef = useRef<MenuActionHandlers>({});

  // Set up menus once on mount. Child effects run before this one, so a screen mounted in the
  // same commit has already registered: report its handlers, not an empty set.
  useEffect(() => {
    setupMenus();
    setEnabledMenuActions(handledActions(handlersRef.current));
  }, []);

  // Sync theme state to native menu checkmarks
  useEffect(() => {
    updateMenuState({ currentTheme: theme });
  }, [theme]);

  // Subscribe to menu action events
  useEffect(() => {
    const unsubscribe = addMenuActionListener((action) => {
      const themePreference = THEME_ACTIONS[action];
      if (themePreference) {
        setTheme(themePreference);
        return;
      }

      // Help can't wait for a screen to register a handler: a Help item that does nothing on
      // the login screen is a Mac App Review rejection.
      if (action === "openHelp") {
        openHelp();
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

  // Menu items no handler covers are disabled natively rather than left doing nothing.
  const registerHandlers = useCallback((handlers: MenuActionHandlers) => {
    handlersRef.current = handlers;
    setEnabledMenuActions(handledActions(handlers));
  }, []);

  return <MenuContext.Provider value={{ registerHandlers }}>{children}</MenuContext.Provider>;
}

/**
 * Hook to register menu action handlers from a component; cleans up on unmount.
 *
 * One screen registers at a time: registering replaces every handler the provider holds.
 * A menu command always runs the handler from the latest committed render, so handlers may
 * close over state. Passing `undefined` for an action disables its menu item until a later
 * render supplies a handler.
 */
export function useMenuActions(handlers: MenuActionHandlers): void {
  const context = useContext(MenuContext);
  if (!context) {
    throw new Error("useMenuActions must be used within a MenuProvider");
  }

  const { registerHandlers } = context;
  const handlersRef = useRef(handlers);
  // Updated after commit, not during render, so a render React discards can't leave its
  // closures behind for the next menu command. Layout effects run before the effects below.
  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });

  // Re-register only when the set of handled actions changes, not on every render. Sorted so
  // the same set in a different key order doesn't count as a change.
  const actionsKey = screenActions(handlers).sort().join(",");

  useEffect(() => {
    // The provider keeps the object it is given, so give it delegates that look up the current
    // handler when the command arrives. Registering `handlers` itself kept the first render's
    // closures forever: File → New Note always saw "no notebook selected" and did nothing.
    // No cleanup here: the new set replaces the old one in a single native update.
    const delegates: MenuActionHandlers = {};
    for (const action of screenActions(handlersRef.current)) {
      delegates[action] = () => handlersRef.current[action]?.();
    }
    registerHandlers(delegates);
  }, [registerHandlers, actionsKey]);

  useEffect(() => () => registerHandlers({}), [registerHandlers]);
}
