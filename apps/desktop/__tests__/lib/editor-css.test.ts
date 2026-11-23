import { buildAttachmentCardCss } from "@drafto/shared";

import {
  EDITOR_ATTACHMENT_CARD_CSS,
  EDITOR_CSS,
  EDITOR_FONT_CSS,
  EDITOR_LAYOUT_CSS,
} from "@/lib/editor-css";
import { EDITOR_BRIDGE_EXTENSIONS } from "@/components/editor/editor-bridge-extensions";
import { semanticLight, spacing } from "@/theme/tokens";

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

describe("PrimeTestLab 11035 S-04 file card", () => {
  it("draws file links as a card in the light body's colours", () => {
    expect(EDITOR_ATTACHMENT_CARD_CSS).toBe(buildAttachmentCardCss(semanticLight));
    expect(EDITOR_CSS).toContain(EDITOR_ATTACHMENT_CARD_CSS);
    expect(EDITOR_ATTACHMENT_CARD_CSS).toContain(
      '.ProseMirror a[href*="/storage/v1/object/sign/attachments/"]',
    );
    expect(EDITOR_ATTACHMENT_CARD_CSS).toContain(`background-color: ${semanticLight.bgSubtle}`);
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
