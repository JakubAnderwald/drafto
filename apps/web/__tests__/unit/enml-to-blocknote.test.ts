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

  it("converts en-todo checkboxes with text content", () => {
    const enml = '<en-note><en-todo checked="true"/>Task done</en-note>';
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    const checkbox = blocks.find((b) => b.type === "checkListItem");
    expect(checkbox).toBeDefined();
    expect(checkbox?.props?.checked).toBe(true);
    const content = checkbox?.content as Array<{ text: string }>;
    expect(content[0].text).toBe("Task done");
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

  it("unwraps single-column layout tables of bullet lists into a flat list", () => {
    const enml = `<en-note><table>
      <tr><td><ul><li>first</li></ul></td></tr>
      <tr><td><ul><li>second</li></ul></td></tr>
      <tr><td><div><br/></div></td></tr>
    </table></en-note>`;
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks.find((b) => b.type === "table")).toBeUndefined();
    const bullets = blocks.filter((b) => b.type === "bulletListItem");
    expect(bullets).toHaveLength(2);
    const firstContent = bullets[0].content as Array<{ text: string }>;
    const secondContent = bullets[1].content as Array<{ text: string }>;
    expect(firstContent.map((i) => i.text).join("")).toBe("first");
    expect(secondContent.map((i) => i.text).join("")).toBe("second");
    // The empty <td><div><br/></div></td> spacer cell must not leak through
    // as a paragraph containing only whitespace.
    expect(blocks.every((b) => b.type === "bulletListItem")).toBe(true);
  });

  it("flattens nested lists in genuine multi-column tables instead of dropping them", () => {
    const enml = `<en-note><table>
      <tr><td>label</td><td><ul><li>x</li><li>y</li></ul></td></tr>
    </table></en-note>`;
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    const table = blocks.find((b) => b.type === "table");
    expect(table).toBeDefined();
    const content = table?.content as {
      rows: { cells: Array<{ text: string }>[] }[];
    };
    expect(content.rows).toHaveLength(1);
    expect(content.rows[0].cells).toHaveLength(2);
    const labelText = content.rows[0].cells[0].map((i) => i.text).join("");
    const listText = content.rows[0].cells[1].map((i) => i.text).join("");
    expect(labelText).toBe("label");
    expect(listText).toBe("• x\n• y");
  });

  it("keeps a real table when any row has a header cell", () => {
    const enml = `<en-note><table>
      <tr><th>Header</th></tr>
      <tr><td><ul><li>x</li></ul></td></tr>
    </table></en-note>`;
    const blocks = convertEnmlToBlocks(enml, emptyMap);
    expect(blocks.find((b) => b.type === "table")).toBeDefined();
    expect(blocks.find((b) => b.type === "bulletListItem")).toBeUndefined();
  });

  it("keeps a real table when a single-column cell contains inline text mixed with blocks", () => {
    const enml = `<en-note><table>
      <tr><td>inline text<ul><li>a</li></ul></td></tr>
    </table></en-note>`;
    const blocks = convertEnmlToBlocks(enml, emptyMap);
    const table = blocks.find((b) => b.type === "table");
    expect(table).toBeDefined();
    const content = table?.content as { rows: { cells: Array<{ text: string }>[] }[] };
    const cellText = content.rows[0].cells[0].map((i) => i.text).join("");
    expect(cellText).toBe("inline text\n• a");
  });

  it("flattens ordered lists, links, paragraphs and inline styles in cells", () => {
    const enml = `<en-note><table>
      <tr><td>k</td><td><ol><li>one</li><li>two</li></ol><p>tail</p><b>bold</b><a href="https://x.test">l</a></td></tr>
    </table></en-note>`;
    const blocks = convertEnmlToBlocks(enml, emptyMap);
    const table = blocks.find((b) => b.type === "table");
    expect(table).toBeDefined();
    const content = table?.content as {
      rows: {
        cells: Array<{
          type: string;
          text: string;
          href?: string;
          styles?: Record<string, boolean>;
        }>[];
      }[];
    };
    const cell = content.rows[0].cells[1];
    const flat = cell.map((i) => i.text).join("");
    expect(flat).toContain("1. one");
    expect(flat).toContain("2. two");
    expect(flat).toContain("tail");
    const bold = cell.find((i) => i.text === "bold");
    expect(bold?.styles?.bold).toBe(true);
    const link = cell.find((i) => i.type === "link");
    expect(link?.href).toBe("https://x.test");
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

  it("converts non-image attachment as link when URL exists", () => {
    const urlMap = new Map([["def456", "https://storage.example.com/doc.pdf"]]);
    const enml = '<en-note><en-media type="application/pdf" hash="def456"/></en-note>';
    const blocks = convertEnmlToBlocks(enml, urlMap);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    const content = blocks[0].content as Array<{ type: string; text: string; href?: string }>;
    expect(content[0].type).toBe("link");
    expect(content[0].href).toBe("https://storage.example.com/doc.pdf");
    expect(content[0].text).toContain("application/pdf");
  });

  it("converts hr to paragraph with ---", () => {
    const enml = "<en-note><hr/></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    const content = blocks[0].content as Array<{ text: string }>;
    expect(content[0].text).toBe("---");
  });

  it("converts blockquote to paragraph", () => {
    const enml = "<en-note><blockquote>Quoted text</blockquote></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    const content = blocks[0].content as Array<{ text: string }>;
    expect(content[0].text).toBe("Quoted text");
  });

  it("handles br tags in inline content", () => {
    const enml = "<en-note><p>Line one<br/>Line two</p></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    const content = blocks[0].content as Array<{ text: string }>;
    expect(content.some((c) => c.text === "\n")).toBe(true);
  });

  it("skips block-level elements inside inline extraction", () => {
    const enml = "<en-note><p>Text<ul><li>item</li></ul></p></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    // The paragraph should have just "Text", the ul is skipped in inline extraction
    const content = blocks[0].content as Array<{ text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].text).toBe("Text");
  });

  it("handles code inline style", () => {
    const enml = "<en-note><p><code>const x = 1</code></p></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    const content = blocks[0].content as Array<{ text: string; styles: Record<string, boolean> }>;
    expect(content[0].styles.code).toBe(true);
  });

  it("handles XML declaration and DOCTYPE stripping", () => {
    const enml =
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><p>Content</p></en-note>';
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });

  it("handles div with child block elements", () => {
    const enml = "<en-note><div><p>Inside div</p></div></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });

  it("handles en-media without type attribute", () => {
    const enml = '<en-note><en-media hash="notype"/></en-note>';
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    const content = blocks[0].content as Array<{ text: string }>;
    expect(content[0].text).toContain("unknown");
  });

  it("handles nested lists", () => {
    const enml = "<en-note><ul><li>Parent<ul><li>Nested</li></ul></li></ul></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("bulletListItem");
    expect(blocks[0].children).toBeDefined();
    expect(blocks[0].children).toHaveLength(1);
    expect(blocks[0].children![0].type).toBe("bulletListItem");
  });

  it("handles unknown elements with inline content", () => {
    const enml = "<en-note><custom-tag>Some text</custom-tag></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });

  it("handles image with width attribute", () => {
    const urlMap = new Map([["img123", "https://storage.example.com/photo.jpg"]]);
    const enml = '<en-note><en-media type="image/jpeg" hash="img123" width="400"/></en-note>';
    const blocks = convertEnmlToBlocks(enml, urlMap);

    const image = blocks.find((b) => b.type === "image");
    expect(image?.props?.width).toBe(400);
  });

  it("handles del and strike tags for strikethrough", () => {
    const enml = "<en-note><p><del>deleted</del> <strike>struck</strike></p></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);
    const content = blocks[0].content as Array<{ text: string; styles: Record<string, boolean> }>;
    expect(content.find((c) => c.text === "deleted")?.styles.strike).toBe(true);
    expect(content.find((c) => c.text === "struck")?.styles.strike).toBe(true);
  });

  it("handles strong and em tags", () => {
    const enml = "<en-note><p><strong>bold</strong> <em>italic</em></p></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);
    const content = blocks[0].content as Array<{ text: string; styles: Record<string, boolean> }>;
    expect(content.find((c) => c.text === "bold")?.styles.bold).toBe(true);
    expect(content.find((c) => c.text === "italic")?.styles.italic).toBe(true);
  });

  it("extracts text from li > div (Evernote list format)", () => {
    const enml =
      "<en-note><ul><li><div>Item text</div></li><li><div>Second item</div></li></ul></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("bulletListItem");
    const content0 = blocks[0].content as Array<{ text: string }>;
    expect(content0[0].text).toBe("Item text");
    const content1 = blocks[1].content as Array<{ text: string }>;
    expect(content1[0].text).toBe("Second item");
  });

  it("extracts styled text from li > div", () => {
    const enml = "<en-note><ul><li><div><b>Bold item</b> text</div></li></ul></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    const content = blocks[0].content as Array<{
      text: string;
      styles: Record<string, boolean>;
    }>;
    expect(content[0].text).toBe("Bold item");
    expect(content[0].styles.bold).toBe(true);
  });

  it("extracts links and br from li content", () => {
    const enml =
      '<en-note><ul><li><a href="https://example.com">Link text</a><br/><b>bold</b></li></ul></en-note>';
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(1);
    const content = blocks[0].content as Array<{
      type: string;
      text: string;
      href?: string;
      styles: Record<string, boolean>;
    }>;
    expect(content[0].type).toBe("link");
    expect(content[0].href).toBe("https://example.com");
    expect(content[1].text).toBe("\n");
    expect(content[2].text).toBe("bold");
    expect(content[2].styles.bold).toBe(true);
  });

  it("extracts text from ol > li > div (Evernote ordered list format)", () => {
    const enml =
      "<en-note><ol><li><div>First item</div></li><li><div>Second item</div></li></ol></en-note>";
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("numberedListItem");
    const content0 = blocks[0].content as Array<{ text: string }>;
    expect(content0[0].text).toBe("First item");
    const content1 = blocks[1].content as Array<{ text: string }>;
    expect(content1[0].text).toBe("Second item");
  });

  it("captures sibling text after en-todo in a div", () => {
    const enml = '<en-note><div><en-todo checked="false"/>Buy groceries</div></en-note>';
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    const checkbox = blocks.find((b) => b.type === "checkListItem");
    expect(checkbox).toBeDefined();
    expect(checkbox?.props?.checked).toBe(false);
    const content = checkbox?.content as Array<{ text: string }>;
    expect(content[0].text).toBe("Buy groceries");
  });

  it("captures styled text after en-todo", () => {
    const enml = '<en-note><div><en-todo checked="true"/><b>Important task</b></div></en-note>';
    const blocks = convertEnmlToBlocks(enml, emptyMap);

    const checkbox = blocks.find((b) => b.type === "checkListItem");
    expect(checkbox?.props?.checked).toBe(true);
    const content = checkbox?.content as Array<{
      text: string;
      styles: Record<string, boolean>;
    }>;
    expect(content[0].text).toBe("Important task");
    expect(content[0].styles.bold).toBe(true);
  });

  it("converts modern task group placeholders to checkListItems", () => {
    const enml =
      '<en-note><div style="--en-task-group:true; --en-id:group-abc123;"></div></en-note>';
    const tasks = [
      { title: "Task one", checked: false, groupId: "group-abc123" },
      { title: "Task two", checked: true, groupId: "group-abc123" },
    ];
    const blocks = convertEnmlToBlocks(enml, emptyMap, tasks);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("checkListItem");
    expect(blocks[0].props?.checked).toBe(false);
    expect((blocks[0].content as Array<{ text: string }>)[0].text).toBe("Task one");
    expect(blocks[1].props?.checked).toBe(true);
    expect((blocks[1].content as Array<{ text: string }>)[0].text).toBe("Task two");
  });

  it("skips task group div when no matching tasks exist", () => {
    const enml =
      '<en-note><p>Before</p><div style="--en-task-group:true; --en-id:no-match;"></div><p>After</p></en-note>';
    const blocks = convertEnmlToBlocks(enml, emptyMap, []);

    expect(blocks.every((b) => b.type === "paragraph")).toBe(true);
  });

  it("sorts tasks within a group by sortWeight", () => {
    const enml = '<en-note><div style="--en-task-group:true; --en-id:grp1;"></div></en-note>';
    const tasks = [
      { title: "Third", checked: false, groupId: "grp1", sortWeight: "R" },
      { title: "First", checked: false, groupId: "grp1", sortWeight: "B" },
      { title: "Second", checked: false, groupId: "grp1", sortWeight: "J" },
    ];
    const blocks = convertEnmlToBlocks(enml, emptyMap, tasks);

    expect(blocks).toHaveLength(3);
    expect((blocks[0].content as Array<{ text: string }>)[0].text).toBe("First");
    expect((blocks[1].content as Array<{ text: string }>)[0].text).toBe("Second");
    expect((blocks[2].content as Array<{ text: string }>)[0].text).toBe("Third");
  });

  it("appends orphan tasks without groupId at the end", () => {
    const enml = "<en-note><p>Note content</p></en-note>";
    const tasks = [{ title: "Orphan task", checked: true, groupId: "" }];
    const blocks = convertEnmlToBlocks(enml, emptyMap, tasks);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[1].type).toBe("checkListItem");
    expect(blocks[1].props?.checked).toBe(true);
    expect((blocks[1].content as Array<{ text: string }>)[0].text).toBe("Orphan task");
  });
});
