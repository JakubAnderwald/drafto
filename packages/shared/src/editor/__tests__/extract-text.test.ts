import { describe, expect, it } from "vitest";
import { extractTextFromContent } from "../extract-text";

describe("extractTextFromContent", () => {
  it("returns empty string for null/undefined", () => {
    expect(extractTextFromContent(null)).toBe("");
    expect(extractTextFromContent(undefined)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractTextFromContent([])).toBe("");
  });

  it("extracts text from a simple BlockNote paragraph", () => {
    const content = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Hello world" }],
      },
    ];
    expect(extractTextFromContent(content)).toBe("Hello world");
  });

  it("extracts text from multiple paragraphs", () => {
    const content = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "First paragraph" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Second paragraph" }],
      },
    ];
    expect(extractTextFromContent(content)).toBe("First paragraph Second paragraph");
  });

  it("extracts text from nested structures (headings, lists)", () => {
    const content = [
      {
        type: "heading",
        content: [{ type: "text", text: "My Heading" }],
      },
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "Item one" }],
      },
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "Item two" }],
      },
    ];
    expect(extractTextFromContent(content)).toBe("My Heading Item one Item two");
  });

  it("extracts text from inline content with styles", () => {
    const content = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Normal " },
          { type: "text", text: "bold", styles: { bold: true } },
          { type: "text", text: " text" },
        ],
      },
    ];
    expect(extractTextFromContent(content)).toBe("Normal  bold  text");
  });

  it("handles TipTap document format", () => {
    const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "TipTap content" }],
        },
      ],
    };
    expect(extractTextFromContent(content)).toBe("TipTap content");
  });

  it("skips empty text values", () => {
    const content = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "Visible" },
        ],
      },
    ];
    expect(extractTextFromContent(content)).toBe("Visible");
  });

  it("handles deeply nested table content", () => {
    const content = [
      {
        type: "table",
        content: {
          rows: [
            {
              cells: [[{ type: "text", text: "Cell 1" }], [{ type: "text", text: "Cell 2" }]],
            },
          ],
        },
      },
    ];
    expect(extractTextFromContent(content)).toContain("Cell 1");
    expect(extractTextFromContent(content)).toContain("Cell 2");
  });
});
