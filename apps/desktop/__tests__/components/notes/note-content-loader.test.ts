import {
  classifyNoteContent,
  escapeHtml,
  hasAttachmentUrls,
  resolveImageUrlsOrFallback,
  textToHtml,
} from "@/components/notes/note-content-loader";
import type { TipTapDoc, TipTapNode } from "@drafto/shared";

describe("classifyNoteContent", () => {
  it("treats empty content as empty", () => {
    expect(classifyNoteContent("")).toEqual({ kind: "empty" });
  });

  it("classifies a BlockNote array as structured and preserves the parsed value", () => {
    const raw = JSON.stringify([
      { type: "paragraph", content: [{ type: "text", text: "hello" }], children: [] },
    ]);
    const result = classifyNoteContent(raw);
    expect(result.kind).toBe("structured");
    if (result.kind === "structured") {
      expect(result.value).toEqual([
        { type: "paragraph", content: [{ type: "text", text: "hello" }], children: [] },
      ]);
    }
  });

  it("classifies a TipTap doc as structured", () => {
    const raw = JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] });
    expect(classifyNoteContent(raw).kind).toBe("structured");
  });

  it("renders non-JSON content as escaped paragraph HTML", () => {
    expect(classifyNoteContent("line one\nline two")).toEqual({
      kind: "html",
      html: "<p>line one</p><p>line two</p>",
    });
  });

  it("escapes HTML metacharacters in plain-text content", () => {
    const result = classifyNoteContent("<script>alert(1)</script>");
    expect(result.kind).toBe("html");
    if (result.kind === "html") {
      expect(result.html).not.toContain("<script>");
      expect(result.html).toContain("&lt;script&gt;");
    }
  });

  it("falls back to plain text for valid JSON that is not an editor document", () => {
    expect(classifyNoteContent("42").kind).toBe("html");
    expect(classifyNoteContent(JSON.stringify({ foo: 1 })).kind).toBe("html");
  });

  it('classifies an empty JSON array as empty (empty editor, not literal "[]")', () => {
    expect(classifyNoteContent("[]")).toEqual({ kind: "empty" });
  });

  it("never classifies real, non-empty content as empty (data-loss invariant)", () => {
    const samples = [
      JSON.stringify([{ type: "paragraph", content: [{ type: "text", text: "x" }] }]),
      JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
      "just some prose",
      "42",
    ];
    for (const raw of samples) {
      expect(classifyNoteContent(raw).kind).not.toBe("empty");
    }
  });
});

describe("textToHtml / escapeHtml", () => {
  it("maps blank lines to <br> so paragraph breaks survive", () => {
    expect(textToHtml("a\n\nb")).toBe("<p>a</p><p><br></p><p>b</p>");
  });

  it("escapes all five HTML-sensitive characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#039;");
  });
});

describe("hasAttachmentUrls", () => {
  it("returns false for a doc with no images", () => {
    const nodes: TipTapNode[] = [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }];
    expect(hasAttachmentUrls(nodes)).toBe(false);
  });

  it("detects a top-level image still pointing at attachment://", () => {
    const nodes: TipTapNode[] = [{ type: "image", attrs: { src: "attachment://photo.png" } }];
    expect(hasAttachmentUrls(nodes)).toBe(true);
  });

  it("ignores images that are already signed/remote URLs", () => {
    const nodes: TipTapNode[] = [{ type: "image", attrs: { src: "https://signed.example/x" } }];
    expect(hasAttachmentUrls(nodes)).toBe(false);
  });

  it("detects a file node pointing at attachment://", () => {
    const nodes: TipTapNode[] = [{ type: "file", attrs: { src: "attachment://doc.pdf" } }];
    expect(hasAttachmentUrls(nodes)).toBe(true);
  });

  it("detects an inline link mark with an attachment:// href (non-image attachment)", () => {
    const nodes: TipTapNode[] = [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "report.pdf",
            marks: [{ type: "link", attrs: { href: "attachment://report.pdf" } }],
          },
        ],
      },
    ];
    expect(hasAttachmentUrls(nodes)).toBe(true);
  });

  it("ignores link marks with a normal https href", () => {
    const nodes: TipTapNode[] = [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "site",
            marks: [{ type: "link", attrs: { href: "https://example.com" } }],
          },
        ],
      },
    ];
    expect(hasAttachmentUrls(nodes)).toBe(false);
  });

  it("recurses into nested content", () => {
    const nodes: TipTapNode[] = [
      {
        type: "blockquote",
        content: [{ type: "image", attrs: { src: "attachment://nested.png" } }],
      },
    ];
    expect(hasAttachmentUrls(nodes)).toBe(true);
  });

  it("returns false for an image node missing a src", () => {
    const nodes: TipTapNode[] = [{ type: "image", attrs: {} }];
    expect(hasAttachmentUrls(nodes)).toBe(false);
  });

  it("returns false for an empty node list", () => {
    expect(hasAttachmentUrls([])).toBe(false);
  });
});

describe("resolveImageUrlsOrFallback", () => {
  it("returns the same doc when there are no image URLs to resolve", async () => {
    const doc: TipTapDoc = { type: "doc", content: [{ type: "paragraph" }] };
    const out = await resolveImageUrlsOrFallback(doc, async () => "https://signed.example/x");
    expect(out).toBe(doc);
  });

  it("resolves attachment image srcs to signed URLs", async () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "attachment://photo.png" } }],
    };
    const out = await resolveImageUrlsOrFallback(doc, async () => "https://signed.example/photo");
    expect(out.content[0]?.attrs?.src).toBe("https://signed.example/photo");
  });

  it("falls back to the input doc when resolution throws (never blanks the note)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    // A malformed doc with no `content` array makes resolveTipTapImageUrls throw.
    const malformed = { type: "doc" } as unknown as TipTapDoc;
    const out = await resolveImageUrlsOrFallback(malformed, async () => "https://signed.example/x");
    expect(out).toBe(malformed);
    warn.mockRestore();
  });
});
