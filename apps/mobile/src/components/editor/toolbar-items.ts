import { DEFAULT_TOOLBAR_ITEMS, HEADING_ITEMS } from "@10play/tentap-editor";
import type { ToolbarItem } from "@10play/tentap-editor";

/**
 * Buttons that only switch the toolbar to another bar (the link field, the
 * heading row and back). They leave the editor's focus alone: the link bar
 * has a text field of its own, and a heading is applied by the next press.
 */
const CONTEXT_SWITCH_LABELS: ReadonlySet<string> = new Set(["Link", "Heading", "Close headings"]);

/**
 * A toolbar button that focuses the editor before it applies while the
 * editor is blurred (the keyboard down). The toolbar is always shown
 * (PrimeTestLab 11035 S-02), but TenTap's formatting commands focus the
 * editor only inside the WebView. On Android that leaves the WebView without
 * native focus: the format was set, yet no keyboard came up and typing went
 * nowhere. `editor.focus()` gives the WebView native focus and brings up the
 * keyboard (TenTap's Android IME check runs on that call) without moving the
 * caret, so the format applies where the caret was. The active and disabled
 * states are TenTap's own, so undo and redo still grey out when there is
 * nothing to undo or redo.
 */
export function focusingToolbarItem(item: ToolbarItem): ToolbarItem {
  if (item.label !== undefined && CONTEXT_SWITCH_LABELS.has(item.label)) return item;
  return {
    ...item,
    onPress: (args) => {
      const apply = item.onPress(args);
      return () => {
        if (!args.editorState.isFocused) args.editor.focus();
        apply();
      };
    },
  };
}

/** TenTap's default toolbar, each formatting button focusing the editor first. */
export const NOTE_TOOLBAR_ITEMS: ToolbarItem[] = DEFAULT_TOOLBAR_ITEMS.map(focusingToolbarItem);

/** TenTap's heading row (H1 to H6), each button focusing the editor first. */
export const NOTE_HEADING_ITEMS: ToolbarItem[] = HEADING_ITEMS.map(focusingToolbarItem);
