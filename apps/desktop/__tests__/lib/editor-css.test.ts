import { EDITOR_CSS, EDITOR_FONT_CSS, EDITOR_LAYOUT_CSS } from "@/lib/editor-css";
import { EDITOR_BRIDGE_EXTENSIONS } from "@/components/editor/editor-bridge-extensions";
import { spacing } from "@/theme/tokens";

describe("desktop editor CSS", () => {
  it("pads the note body sideways, in line with the title", () => {
    expect(EDITOR_LAYOUT_CSS).toBe(
      `.ProseMirror { padding-left: ${spacing["2xl"]}px; padding-right: ${spacing["2xl"]}px; }`,
    );
    // TenTap sets padding-bottom inline; a shorthand here would fight it.
    expect(EDITOR_LAYOUT_CSS).not.toMatch(/padding-(top|bottom)|padding:/);
  });

  it("keeps the system font stack and adds the gutter", () => {
    expect(EDITOR_CSS).toContain(EDITOR_FONT_CSS);
    expect(EDITOR_CSS).toContain(EDITOR_LAYOUT_CSS);
    expect(EDITOR_FONT_CSS).toMatch(/font-family: -apple-system/);
  });
});

describe("EDITOR_BRIDGE_EXTENSIONS", () => {
  it("ships the stylesheet on the core bridge, which TenTap injects with every bridge's CSS", () => {
    const core = EDITOR_BRIDGE_EXTENSIONS.find(
      (extension) => (extension as { name?: string }).name === "core",
    ) as { extendCSS?: string } | undefined;

    expect(core?.extendCSS).toBe(EDITOR_CSS);
  });
});
