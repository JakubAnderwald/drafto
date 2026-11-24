import { buildEditorTheme, EDITOR_TOOLBAR_HEIGHT, toolbarIconStates } from "@/lib/editor-theme";
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

  it("keeps TenTap's dark link-bar styling, but not its dark WebView", () => {
    const theme = buildEditorTheme(semanticDark, true);

    expect(theme.toolbar?.linkBarTheme?.doneButton).toEqual({ backgroundColor: "#0085FF" });
    expect(theme).not.toHaveProperty("webview");
    expect(theme).not.toHaveProperty("webviewContainer");
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
