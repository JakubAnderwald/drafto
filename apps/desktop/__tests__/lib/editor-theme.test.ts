import { buildEditorTheme, EDITOR_TOOLBAR_HEIGHT } from "@/lib/editor-theme";
import { semanticDark, semanticLight } from "@/theme/tokens";

// Mirrors apps/mobile/__tests__/lib/editor-theme.test.ts, except that desktop
// leaves the WebView's colours alone.

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

describe("PrimeTestLab 11035 S-02 buildEditorTheme (desktop)", () => {
  it.each([
    ["light", semanticLight, false],
    ["dark", semanticDark, true],
  ] as const)("pins the toolbar to one fixed-height row in %s mode", (_mode, semantic, isDark) => {
    const { toolbar } = buildEditorTheme(semantic, isDark);

    const pinned = expect.objectContaining({
      flex: 0,
      flexGrow: 0,
      flexShrink: 0,
      height: EDITOR_TOOLBAR_HEIGHT,
      backgroundColor: semantic.bg,
      borderTopColor: semantic.border,
    });
    expect(toolbar?.toolbarBody).toEqual(pinned);
    expect(toolbar?.linkBarTheme?.addLinkContainer).toEqual(pinned);
    expect(toolbar?.toolbarButton).toEqual({ backgroundColor: semantic.bg });
    expect(toolbar?.iconWrapper).toEqual({ backgroundColor: semantic.bg });
  });

  it("keeps TenTap's light dark-mode icons, but not its dark WebView", () => {
    const theme = buildEditorTheme(semanticDark, true);

    expect(theme.toolbar?.icon).toEqual({ tintColor: "white" });
    expect(theme.toolbar?.linkBarTheme?.doneButton).toEqual({ backgroundColor: "#0085FF" });
    expect(theme).not.toHaveProperty("webview");
    expect(theme).not.toHaveProperty("webviewContainer");
  });

  it("leaves TenTap's light icons alone in light mode", () => {
    expect(buildEditorTheme(semanticLight, false).toolbar?.icon).toBeUndefined();
  });
});
