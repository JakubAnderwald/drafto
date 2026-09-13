import {
  classifyNoteContent,
  escapeHtml,
  resolveImageUrlsOrFallback,
  textToHtml,
} from "@/components/notes/note-content-loader";
import type { TipTapDoc } from "@drafto/shared";

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
    try {
      // A malformed doc with no `content` array makes resolveTipTapImageUrls throw.
      const malformed = { type: "doc" } as unknown as TipTapDoc;
      const out = await resolveImageUrlsOrFallback(
        malformed,
        async () => "https://signed.example/x",
      );
      expect(out).toBe(malformed);
    } finally {
      warn.mockRestore();
    }
  });
});
