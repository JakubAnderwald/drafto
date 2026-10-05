import { buildEditorColorCss, buildEditorCss, EDITOR_FONT_CSS } from "@/lib/editor-css";
import { semanticDark, semanticLight } from "@/theme/tokens";

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
});
