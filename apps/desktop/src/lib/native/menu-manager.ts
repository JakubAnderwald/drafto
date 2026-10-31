import { NativeModules, NativeEventEmitter } from "react-native";

const { DraftoMenuManager } = NativeModules;
const menuEmitter = new NativeEventEmitter(DraftoMenuManager);

export type MenuAction =
  | "newNote"
  | "newNotebook"
  | "openSearch"
  | "findInNote"
  | "findNext"
  | "findPrevious"
  | "toggleSidebar"
  | "showTrash"
  | "themeLight"
  | "themeDark"
  | "themeSystem"
  | "openHelp";

export function setupMenus(): void {
  DraftoMenuManager.setupMenus();
}

/**
 * Tells the native menu which actions something in JS currently handles. Items whose action is
 * not in the list are shown disabled instead of doing nothing.
 */
export function setEnabledMenuActions(actions: readonly MenuAction[]): void {
  DraftoMenuManager.setEnabledActions(actions);
}

export type MenuTheme = "light" | "dark" | "system";

export function updateMenuState(state: { currentTheme: MenuTheme }): void {
  DraftoMenuManager.updateMenuState(state);
}

export function addMenuActionListener(callback: (action: MenuAction) => void): () => void {
  const subscription = menuEmitter.addListener("onMenuAction", (event: { action: MenuAction }) => {
    callback(event.action);
  });
  return () => subscription.remove();
}
