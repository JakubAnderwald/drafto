import { darkEditorTheme } from "@10play/tentap-editor";
import type { EditorTheme, RecursivePartial } from "@10play/tentap-editor";

import type { SemanticColors } from "@/theme/tokens";

/** TenTap's toolbar row height (its RichText assumes 44 too). */
export const EDITOR_TOOLBAR_HEIGHT = 44;

// Mirrors apps/mobile/src/lib/editor-theme.ts. Desktop shows the toolbar
// always (PrimeTestLab 11035 S-02): with no soft keyboard on macOS, TenTap's
// default kept it hidden for good.

/**
 * Theme for the TenTap editor bridge. TenTap deep-merges this over its own
 * default theme, so only the keys set here change: the toolbar's.
 *
 * - The toolbar is a horizontal FlatList whose default theme gives it
 *   `flex: 1`, on top of the ScrollView's own `flexGrow: 1`. Inside the editor
 *   column that made it claim half of the space as soon as it appeared, leaving
 *   a blank band between the note body and a toolbar floating mid-screen. It is
 *   pinned to a fixed-height row instead. The link bar, which replaces the
 *   toolbar while a link is edited, has the same default `flex: 1` and is pinned
 *   the same way.
 * - The toolbar and its buttons use the app's surface colour rather than
 *   TenTap's white (light) or grey (dark), so the row reads as part of the
 *   window in both themes. Unlike mobile, the WebView keeps its own colours:
 *   the desktop note body is light only (editor-css.ts).
 * - The icons use the theme's text colours. TenTap's grey icons (white in
 *   dark mode) had a disabled look of a pale tint at 30% opacity, which read
 *   as a toolbar switched off (PrimeTestLab 11035 S-02 follow-up).
 */
export function buildEditorTheme(
  semantic: SemanticColors,
  isDark: boolean,
): RecursivePartial<EditorTheme> {
  // Only the toolbar part of TenTap's dark theme: its WebView colours would
  // darken the light-only note body.
  const baseToolbar: RecursivePartial<EditorTheme>["toolbar"] = isDark
    ? darkEditorTheme.toolbar
    : {};
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
    toolbar: {
      ...baseToolbar,
      toolbarBody: fixedRow,
      toolbarButton: { backgroundColor: semantic.bg },
      iconWrapper: { backgroundColor: semantic.bg },
      ...toolbarIconStates(semantic),
      linkBarTheme: {
        ...baseToolbar?.linkBarTheme,
        addLinkContainer: fixedRow,
        linkInput: { backgroundColor: semantic.bg, color: semantic.fg },
        placeholderTextColor: semantic.fgSubtle,
      },
    },
  };
}

/**
 * Icon colours for the toolbar's three button states: an available action in
 * the muted text colour, the active one (bold on at the caret, say) in the
 * full text colour on the muted surface, and one that can't apply (undo with
 * nothing to undo) in the subtle text colour. TenTap's own disabled look
 * stacked a pale tint with 30% opacity, so the opacity is reset: the colour
 * alone marks a disabled button, and stays legible in both themes.
 */
export function toolbarIconStates(
  semantic: SemanticColors,
): NonNullable<RecursivePartial<EditorTheme>["toolbar"]> {
  return {
    icon: { tintColor: semantic.fgMuted },
    iconActive: { tintColor: semantic.fg },
    iconWrapperActive: { backgroundColor: semantic.bgMuted },
    iconDisabled: { tintColor: semantic.fgSubtle },
    iconWrapperDisabled: { opacity: 1 },
  };
}
