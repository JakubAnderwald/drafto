import { buildEditorTheme, EDITOR_TOOLBAR_HEIGHT } from "@/lib/editor-theme";
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
    expect(toolbar?.toolbarBody).toEqual(
      expect.objectContaining({
        flex: 0,
        flexGrow: 0,
        flexShrink: 0,
        height: EDITOR_TOOLBAR_HEIGHT,
      }),
    );
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

  it("keeps TenTap's dark icon and link-bar styling in dark mode", () => {
    const { toolbar } = buildEditorTheme(semanticDark, true);

    expect(toolbar?.icon).toEqual({ tintColor: "white" });
    expect(toolbar?.linkBarTheme?.doneButton).toEqual({ backgroundColor: "#0085FF" });
  });

  it("leaves TenTap's light icons alone in light mode", () => {
    const { toolbar } = buildEditorTheme(semanticLight, false);

    expect(toolbar?.icon).toBeUndefined();
  });
});
