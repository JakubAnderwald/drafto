import { buildEditorTheme, EDITOR_TOOLBAR_HEIGHT, toolbarIconStates } from "@/lib/editor-theme";
import { semanticDark, semanticLight } from "@/theme/tokens";

jest.mock("@10play/tentap-editor", () => ({
  darkEditorTheme: {
    toolbar: {
      toolbarBody: { backgroundColor: "#474747" },
      icon: { tintColor: "white" },
      linkBarTheme: { doneButton: { backgroundColor: "#0085FF" } },
    },
    webview: { backgroundColor: "#1C1C1E" },
    webviewContainer: {},
  },
}));

describe("buildEditorTheme", () => {
  it.each([
    ["light", semanticLight, false],
    ["dark", semanticDark, true],
  ] as const)("pins the toolbar to one fixed-height row in %s mode", (_mode, semantic, isDark) => {
    const { toolbar } = buildEditorTheme(semantic, isDark);

    // TenTap's default `flex: 1` (plus the FlatList's `flexGrow: 1`) made the
    // toolbar take half of the editor column.
    const pinned = expect.objectContaining({
      flex: 0,
      flexGrow: 0,
      flexShrink: 0,
      height: EDITOR_TOOLBAR_HEIGHT,
    });
    expect(toolbar?.toolbarBody).toEqual(pinned);
    // The link bar replaces the toolbar while a link is edited and has the
    // same default `flex: 1`.
    expect(toolbar?.linkBarTheme?.addLinkContainer).toEqual(pinned);
  });

  it.each([
    ["light", semanticLight, false],
    ["dark", semanticDark, true],
  ] as const)("uses the screen's surface colour in %s mode", (_mode, semantic, isDark) => {
    const theme = buildEditorTheme(semantic, isDark);

    expect(theme.toolbar?.toolbarBody).toEqual(
      expect.objectContaining({
        backgroundColor: semantic.bg,
        borderTopColor: semantic.border,
        borderBottomColor: semantic.border,
      }),
    );
    expect(theme.toolbar?.toolbarButton).toEqual({ backgroundColor: semantic.bg });
    expect(theme.toolbar?.iconWrapper).toEqual({ backgroundColor: semantic.bg });
    expect(theme.toolbar?.linkBarTheme?.addLinkContainer).toEqual(
      expect.objectContaining({ backgroundColor: semantic.bg }),
    );
    expect(theme.toolbar?.linkBarTheme?.linkInput).toEqual({
      backgroundColor: semantic.bg,
      color: semantic.fg,
    });
    expect(theme.webview).toEqual({ backgroundColor: semantic.bg });
  });

  it("keeps TenTap's dark link-bar styling in dark mode", () => {
    const { toolbar } = buildEditorTheme(semanticDark, true);

    expect(toolbar?.linkBarTheme?.doneButton).toEqual({ backgroundColor: "#0085FF" });
  });

  it.each([
    ["light", semanticLight, false],
    ["dark", semanticDark, true],
  ] as const)(
    "PrimeTestLab 11035 E2E draws the toolbar icons in the theme's text colours in %s mode",
    (_mode, semantic, isDark) => {
      const { toolbar } = buildEditorTheme(semantic, isDark);

      // Available, active and disabled each have their own colour; TenTap's
      // grey (white in dark mode) icons are replaced.
      expect(toolbar?.icon).toEqual({ tintColor: semantic.fgMuted });
      expect(toolbar?.iconActive).toEqual({ tintColor: semantic.fg });
      expect(toolbar?.iconWrapperActive).toEqual({ backgroundColor: semantic.bgMuted });
      expect(toolbar?.iconDisabled).toEqual({ tintColor: semantic.fgSubtle });
    },
  );

  it("PrimeTestLab 11035 E2E drops TenTap's 30% opacity on disabled buttons", () => {
    // Stacked on a pale tint, it made every button look switched off while
    // the editor's state said none applied (a new note's empty document).
    expect(toolbarIconStates(semanticLight).iconWrapperDisabled).toEqual({ opacity: 1 });
    expect(buildEditorTheme(semanticDark, true).toolbar?.iconWrapperDisabled).toEqual({
      opacity: 1,
    });
  });
});
