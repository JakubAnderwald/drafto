import { Platform, type AlertButton } from "react-native";

/**
 * The Trash tap menu's buttons in each platform's order. iOS stacks them and
 * puts the cancel-style one last, so Restore leads. Android has three slots
 * and fills them from the end: the last button is the positive one (right),
 * the one before it the negative, the first the neutral one (far left). So
 * Cancel goes first there, out of the primary spot, and Restore last.
 */
export function trashMenuButtons(
  restore: AlertButton,
  deleteForever: AlertButton,
  cancel: AlertButton,
): AlertButton[] {
  return Platform.OS === "android"
    ? [cancel, deleteForever, restore]
    : [restore, deleteForever, cancel];
}
