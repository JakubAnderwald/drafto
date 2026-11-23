import { describe, it, expect } from "vitest";
import {
  ATTACHMENT_LINK_SELECTORS,
  ATTACHMENT_SIZES_CSS_TAG,
  attachmentHrefFragments,
  buildAttachmentCardCss,
  buildAttachmentSizeCss,
  buildFileBlockSizeCss,
  cssString,
  semanticDark,
  semanticLight,
} from "../src";

const KEY = "user-1/note-1/Quarterly report-1700000000000-0a1b2c3d.pdf";
const SIGNED = `https://x.supabase.co/storage/v1/object/sign/attachments/${encodeURI(KEY)}?token=t`;

/** The CSS rules (one per line) whose selector list matches `pattern`. */
function rulesMatching(css: string, pattern: string): string[] {
  return css.split("\n").filter((rule) => rule.includes(pattern));
}

describe("PrimeTestLab 11035 S-04 attachment link selectors", () => {
  it("targets file links by their attachment:// or signed URL only", () => {
    expect(ATTACHMENT_LINK_SELECTORS).toEqual([
      '.ProseMirror a[href^="attachment://"]',
      '.ProseMirror a[href*="/storage/v1/object/sign/attachments/"]',
    ]);
    // No rule names an <img> or an unqualified link.
    const css = buildAttachmentCardCss(semanticLight);
    expect(css).not.toMatch(/\bimg\b/);
    for (const rule of css.split("\n")) {
      const selectors = rule.slice(0, rule.indexOf("{")).split(",");
      for (const selector of selectors) expect(selector).toMatch(/a\[href[\^*]="/);
    }
  });
});

describe("PrimeTestLab 11035 S-04 buildAttachmentCardCss", () => {
  it.each([
    ["light", semanticLight],
    ["dark", semanticDark],
  ] as const)("draws the card in the %s theme's colours", (_name, semantic) => {
    const css = buildAttachmentCardCss(semantic);
    const [card] = rulesMatching(css, "text-decoration: none");
    expect(card).toContain(`border: 1px solid ${semantic.borderStrong}`);
    expect(card).toContain(`background-color: ${semantic.bgSubtle}`);
    expect(card).toContain(`color: ${semantic.fg}`);
    expect(card).toContain("border-radius: 8px");
    const [icon] = rulesMatching(css, "::before");
    expect(icon).toContain(`background-color: ${semantic.fgMuted}`);
    expect(icon).toContain('-webkit-mask: url("data:image/svg+xml,');
    const [size] = rulesMatching(css, "::after");
    expect(size).toContain(`color: ${semantic.fgMuted}`);
  });

  it("keeps a formatted file name on the card's colours", () => {
    const [descendants] = rulesMatching(buildAttachmentCardCss(semanticDark), "] *");
    expect(descendants).toContain("background-color: transparent");
    expect(descendants).toContain("color: inherit");
  });
});

describe("PrimeTestLab 11035 S-04 cssString", () => {
  it("keeps plain characters and hex-escapes the rest", () => {
    expect(cssString("1.2 MB")).toBe('"1.2 MB"');
    expect(cssString('a"b\\c')).toBe('"a\\22 b\\5c c"');
    expect(cssString("</style>")).toBe('"\\3c /style\\3e "');
    expect(cssString("line\nbreak")).toBe('"line\\a break"');
    expect(cssString("café 😀")).toBe('"caf\\e9  \\1f600 "');
  });
});

describe("PrimeTestLab 11035 S-04 attachmentHrefFragments", () => {
  it("matches a key with the unique upload suffix on that suffix, in every encoding", () => {
    const [fragment] = attachmentHrefFragments(KEY);
    expect(attachmentHrefFragments(KEY)).toEqual(["-1700000000000-0a1b2c3d"]);
    expect(`attachment://${KEY}`).toContain(fragment);
    expect(SIGNED).toContain(fragment);
    expect(encodeURIComponent(KEY)).toContain(fragment);
  });

  it("matches a key with no extension on its suffix", () => {
    expect(attachmentHrefFragments("u/n/notes-1700000000000-ffffffff")).toEqual([
      "-1700000000000-ffffffff",
    ]);
  });

  it("matches an older key on its whole path, raw and encoded", () => {
    const legacy = "u/n/Résumé & notes.pdf";
    const fragments = attachmentHrefFragments(legacy);
    expect(fragments).toContain(legacy);
    expect(fragments).toContain(encodeURI(legacy));
    expect(fragments).toContain("u/n/R%C3%A9sum%C3%A9%20%26%20notes.pdf");
    expect(fragments).toContain(encodeURI("u/n/R%C3%A9sum%C3%A9%20%26%20notes.pdf"));
    expect(new Set(fragments).size).toBe(fragments.length);
  });

  it("lists a plain older key once", () => {
    expect(attachmentHrefFragments("u/n/report.pdf")).toEqual(["u/n/report.pdf"]);
  });

  it("skips encodings a lone surrogate can't have", () => {
    expect(attachmentHrefFragments("u/n/bad\ud800.pdf")).toEqual(["u/n/bad\ud800.pdf"]);
  });
});

describe("PrimeTestLab 11035 S-04 buildAttachmentSizeCss", () => {
  it("is exported under the tag the native editors inject it with", () => {
    expect(ATTACHMENT_SIZES_CSS_TAG).toBe("attachment-sizes");
  });

  it("writes each file's size after the links to it", () => {
    const css = buildAttachmentSizeCss([
      { filePath: KEY, fileSize: 1.2 * 1024 * 1024, mimeType: "application/pdf" },
    ]);
    expect(css).toBe(
      '.ProseMirror a[href^="attachment://"][href*="-1700000000000-0a1b2c3d"]::after, ' +
        '.ProseMirror a[href*="/storage/v1/object/sign/attachments/"][href*="-1700000000000-0a1b2c3d"]::after' +
        ' { content: "1.2 MB"; }',
    );
  });

  it("leaves out images, unknown sizes and duplicates", () => {
    const css = buildAttachmentSizeCss([
      { filePath: "u/n/photo-1700000000000-aaaaaaaa.png", fileSize: 10, mimeType: "image/png" },
      { filePath: "u/n/a-1700000000000-11111111.pdf", fileSize: Number.NaN },
      { filePath: "u/n/b-1700000000000-22222222.pdf", fileSize: null },
      { filePath: "", fileSize: 10 },
      { filePath: "u/n/c-1700000000000-33333333.zip", fileSize: 2048, mimeType: null },
      { filePath: "u/n/c-1700000000000-33333333.zip", fileSize: 2048, mimeType: null },
    ]);
    expect(css.split("\n")).toHaveLength(1);
    expect(css).toContain('content: "2 KB"');
    expect(css).not.toContain("aaaaaaaa");
    expect(css).not.toContain("11111111");
  });

  it("escapes a file name that could break out of the stylesheet", () => {
    const css = buildAttachmentSizeCss([
      { filePath: 'u/n/x"]{}</style>.pdf', fileSize: 1, mimeType: "application/pdf" },
    ]);
    expect(css).not.toContain("</style>");
    expect(css).not.toContain('x"]');
    expect(css).toContain("x\\22 \\5d \\7b \\7d \\3c /style\\3e .pdf");
  });

  it("orders older keys so a longer path's rule wins over a path it contains", () => {
    const css = buildAttachmentSizeCss([
      { filePath: "u/n/a.pdf.zip", fileSize: 2048, mimeType: "application/zip" },
      { filePath: "u/n/a.pdf", fileSize: 1024, mimeType: "application/pdf" },
    ]);
    const lines = css.split("\n");
    expect(lines[0]).toContain('content: "1 KB"');
    expect(lines[1]).toContain('content: "2 KB"');
  });

  it("is empty for a note with no sized files", () => {
    expect(buildAttachmentSizeCss([])).toBe("");
  });
});

describe("PrimeTestLab 11035 S-04 buildFileBlockSizeCss", () => {
  it("matches BlockNote's file block on its stored URL", () => {
    expect(
      buildFileBlockSizeCss([
        { filePath: "u/n/report.pdf", fileSize: 812 * 1024, mimeType: "application/pdf" },
        { filePath: "u/n/photo.png", fileSize: 812 * 1024, mimeType: "image/png" },
      ]),
    ).toBe(
      '.bn-block-content[data-content-type="file"][data-url="attachment://u/n/report.pdf"]' +
        ' .bn-file-name-with-icon::after { content: "812 KB"; }',
    );
  });
});
