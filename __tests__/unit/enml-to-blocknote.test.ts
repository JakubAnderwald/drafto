import { describe, it, expect } from "vitest";
import { convertEnmlToBlocks } from "@/lib/import/enml-to-blocknote";

describe("convertEnmlToBlocks", () => {
  const emptyMap = new Map<string, string>();

  it("converts a simple paragraph", () => {
    const enml = "<en-note><p>Hello world</p></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].content).toEqual([{ type: "text", text: "Hello world", styles: {} }]);
  });

  it("converts headings", () => {
    const enml = "<en-note><h1>Title</h1><h2>Subtitle</h2><h3>Section</h3></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("heading");
    expect(blocks[0].props).toEqual({ level: 1 });
    expect(blocks[1].props).toEqual({ level: 2 });
    expect(blocks[2].props).toEqual({ level: 3 });
  });

  it("converts bold, italic, underline text", () => {
    const enml = "<en-note><p><b>bold</b> <i>italic</i> <u>underline</u></p></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    const content = blocks[0].content as Array<{
      type: string;
      text: string;
      styles: Record<string, boolean>;
    }>;
    expect(content.find((c) => c.text === "bold")?.styles.bold).toBe(true);
    expect(content.find((c) => c.text === "italic")?.styles.italic).toBe(true);
    expect(content.find((c) => c.text === "underline")?.styles.underline).toBe(true);
  });

  it("converts links", () => {
    const enml = '<en-note><p><a href="https://example.com">Link</a></p></en-note>';
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    const content = blocks[0].content as Array<{ type: string; text: string; href?: string }>;
    expect(content[0].type).toBe("link");
    expect(content[0].href).toBe("https://example.com");
    expect(content[0].text).toBe("Link");
  });

  it("converts unordered lists", () => {
    const enml = "<en-note><ul><li>Item 1</li><li>Item 2</li></ul></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("bulletListItem");
    expect(blocks[1].type).toBe("bulletListItem");
  });

  it("converts ordered lists", () => {
    const enml = "<en-note><ol><li>First</li><li>Second</li></ol></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("numberedListItem");
  });

  it("converts en-todo checkboxes", () => {
    const enml = '<en-note><en-todo checked="true"/>Task done</en-note>';
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    const checkbox = blocks.find((b) => b.type === "checkListItem");
    expect(checkbox).toBeDefined();
    expect(checkbox?.props?.checked).toBe(true);
  });

  it("converts en-media images with URL from map", () => {
    const urlMap = new Map([["abc123", "https://storage.example.com/image.png"]]);
    const enml = '<en-note><en-media type="image/png" hash="abc123"/></en-note>';
    const blocks = convertEnmlToBlocks(enml, urlMap);

    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeDefined();
    expect(image?.props?.url).toBe("https://storage.example.com/image.png");
  });

  it("shows placeholder for en-media without URL", () => {
    const enml = '<en-note><en-media type="image/png" hash="missing"/></en-note>';
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });

  it("converts tables", () => {
    const enml = `<en-note><table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table></en-note>`;
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    const table = blocks.find((b) => b.type === "table");
    expect(table).toBeDefined();
    const content = table?.content as { type: string; rows: { cells: unknown[][] }[] };
    expect(content.rows).toHaveLength(2);
    expect(content.rows[0].cells).toHaveLength(2);
  });

  it("returns default paragraph for empty content", () => {
    const blocks = convertEnmlToBlocks("", emptyMap);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });

  it("handles strikethrough text", () => {
    const enml = "<en-note><p><s>deleted</s></p></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);
    const content = blocks[0].content as Array<{ text: string; styles: Record<string, boolean> }>;
    expect(content[0].styles.strike).toBe(true);
  });

  it("handles nested inline styles", () => {
    const enml = "<en-note><p><b><i>bold italic</i></b></p></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);
    const content = blocks[0].content as Array<{ text: string; styles: Record<string, boolean> }>;
    expect(content[0].styles.bold).toBe(true);
    expect(content[0].styles.italic).toBe(true);
  });
});
