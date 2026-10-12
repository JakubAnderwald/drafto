import { darkEditorTheme } from "@10play/tentap-editor";
import type { EditorTheme, RecursivePartial } from "@10play/tentap-editor";

import type { SemanticColors } from "@/theme/tokens";

/** TenTap's toolbar row height (its RichText assumes 44 too). */
export const EDITOR_TOOLBAR_HEIGHT = 44;

/**
 * Theme for the TenTap editor bridge. TenTap deep-merges this over its own
 * default theme, so only the keys set here change.
 *
 * - The toolbar is a horizontal FlatList whose default theme gives it
 *   `flex: 1`, on top of the ScrollView's own `flexGrow: 1`. Inside the editor
 *   column that made it claim half of the space as soon as it appeared, leaving
 *   a blank band between the note body and a toolbar floating mid-screen. It is
 *   pinned to a fixed-height row instead. The link bar, which replaces the
 *   toolbar while a link is edited, has the same default `flex: 1` and is pinned
 *   the same way.
 * - The toolbar, its buttons and the WebView use the app's surface colour
 *   rather than TenTap's white (light) or grey (dark), so the row reads as part
 *   of the screen in both themes.
 */
export function buildEditorTheme(
  semantic: SemanticColors,
  isDark: boolean,
): RecursivePartial<EditorTheme> {
  const base: RecursivePartial<EditorTheme> = isDark ? darkEditorTheme : {};
  const fixedRow = {
    flex: 0,
    flexGrow: 0,
    flexShrink: 0,
    height: EDITOR_TOOLBAR_HEIGHT,
    backgroundColor: semantic.bg,
    borderTopColor: semantic.border,
    borderBottomColor: semantic.border,
  };

  return {
    ...base,
    toolbar: {
      ...base.toolbar,
      toolbarBody: fixedRow,
      toolbarButton: { backgroundColor: semantic.bg },
      iconWrapper: { backgroundColor: semantic.bg },
      linkBarTheme: {
        ...base.toolbar?.linkBarTheme,
        addLinkContainer: fixedRow,
        linkInput: { backgroundColor: semantic.bg, color: semantic.fg },
        placeholderTextColor: semantic.fgSubtle,
      },
    },
    webview: { backgroundColor: semantic.bg },
  };
}
