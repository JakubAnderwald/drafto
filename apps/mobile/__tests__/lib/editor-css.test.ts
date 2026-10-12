import {
  buildEditorColorCss,
  buildEditorCss,
  EDITOR_FONT_CSS,
  EDITOR_LAYOUT_CSS,
} from "@/lib/editor-css";
import { semanticDark, semanticLight, spacing } from "@/theme/tokens";

describe("buildEditorColorCss", () => {
  it("uses the light foreground on the dark background in dark mode", () => {
    const css = buildEditorColorCss(semanticDark, true);

    expect(css).toContain(`background-color: ${semanticDark.bg}`);
    expect(css).toContain(`color: ${semanticDark.fg}`);
    expect(css).toContain(`border-left: 3px solid ${semanticDark.borderStrong}`);
    expect(css).toContain(`.highlight-background { background-color: ${semanticDark.bgMuted}; }`);
  });

  it("uses the light-theme colours in light mode, without dark-only rules", () => {
    const css = buildEditorColorCss(semanticLight, false);

    expect(css).toBe(`* { background-color: ${semanticLight.bg}; color: ${semanticLight.fg}; }`);
  });
});

describe("buildEditorCss", () => {
  it("combines the font stack with the theme colours", () => {
    const css = buildEditorCss(semanticDark, true);

    expect(css.startsWith(EDITOR_FONT_CSS)).toBe(true);
    expect(css).toContain(buildEditorColorCss(semanticDark, true));
  });

  it.each([
    ["light", semanticLight, false],
    ["dark", semanticDark, true],
  ] as const)("gives the note body a horizontal gutter in %s mode", (_mode, semantic, isDark) => {
    const css = buildEditorCss(semantic, isDark);

    expect(css).toContain(EDITOR_LAYOUT_CSS);
    expect(css).toContain(`padding-left: ${spacing.lg}px`);
    expect(css).toContain(`padding-right: ${spacing.lg}px`);
  });
});

describe("EDITOR_LAYOUT_CSS", () => {
  it("pads the ProseMirror body sideways only, leaving padding-bottom to TenTap", () => {
    expect(EDITOR_LAYOUT_CSS).toBe(
      `.ProseMirror { padding-left: ${spacing.lg}px; padding-right: ${spacing.lg}px; }`,
    );
    expect(EDITOR_LAYOUT_CSS).not.toMatch(/padding-(top|bottom)|padding:/);
  });
});
