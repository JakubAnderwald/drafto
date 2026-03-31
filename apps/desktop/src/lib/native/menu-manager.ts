import { NativeModules, NativeEventEmitter } from "react-native";

const { DraftoMenuManager } = NativeModules;
const menuEmitter = new NativeEventEmitter(DraftoMenuManager);

export type MenuAction =
  | "newNote"
  | "newNotebook"
  | "openSearch"
  | "toggleSidebar"
  | "showTrash"
  | "themeLight"
  | "themeDark"
  | "themeSystem"
  | "openSettings"
  | "openHelp";

export function setupMenus(): void {
  DraftoMenuManager.setupMenus();
}

export function updateMenuState(state: { currentTheme: string }): void {
  DraftoMenuManager.updateMenuState(state);
}

export function addMenuActionListener(callback: (action: MenuAction) => void): () => void {
  const subscription = menuEmitter.addListener("onMenuAction", (event: { action: MenuAction }) => {
    callback(event.action);
  });
  return () => subscription.remove();
}
