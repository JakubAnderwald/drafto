import { describe, it, expect } from "vitest";
import { blockNoteToMarkdown, markdownToBlockNote } from "../markdown-converter";
import type { BlockNoteBlock, BlockNoteTableContent } from "../types";

describe("blockNoteToMarkdown", () => {
  it("converts headings", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: "Title", styles: {} }],
        children: [],
      },
      {
        type: "heading",
        props: { level: 3 },
        content: [{ type: "text", text: "Sub", styles: {} }],
        children: [],
      },
    ];
    expect(blockNoteToMarkdown(blocks)).toBe("# Title\n\n### Sub");
  });

  it("converts paragraphs", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Hello world", styles: {} }],
        children: [],
      },
    ];
    expect(blockNoteToMarkdown(blocks)).toBe("Hello world");
  });

  it("converts bullet list items", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "Item 1", styles: {} }],
        children: [],
      },
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "Item 2", styles: {} }],
        children: [],
      },
    ];
    expect(blockNoteToMarkdown(blocks)).toBe("- Item 1\n\n- Item 2");
  });

  it("converts numbered list items", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "numberedListItem",
        content: [{ type: "text", text: "First", styles: {} }],
        children: [],
      },
      {
        type: "numberedListItem",
        content: [{ type: "text", text: "Second", styles: {} }],
        children: [],
      },
    ];
    expect(blockNoteToMarkdown(blocks)).toBe("1. First\n\n1. Second");
  });

  it("converts check list items", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "checkListItem",
        props: { checked: true },
        content: [{ type: "text", text: "Done", styles: {} }],
        children: [],
      },
      {
        type: "checkListItem",
        props: { checked: false },
        content: [{ type: "text", text: "Todo", styles: {} }],
        children: [],
      },
    ];
    expect(blockNoteToMarkdown(blocks)).toBe("- [x] Done\n\n- [ ] Todo");
  });

  it("converts code blocks", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "codeBlock",
        props: { language: "ts" },
        content: [{ type: "text", text: "const x = 1;", styles: {} }],
        children: [],
      },
    ];
    expect(blockNoteToMarkdown(blocks)).toBe("```ts\nconst x = 1;\n```");
  });

  it("converts images", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "image",
        props: { url: "https://example.com/img.png", caption: "A photo" },
        children: [],
      },
    ];
    expect(blockNoteToMarkdown(blocks)).toBe("![A photo](https://example.com/img.png)");
  });

  it("converts tables", () => {
    const tableContent: BlockNoteTableContent = {
      type: "tableContent",
      rows: [
        {
          cells: [
            [{ type: "text", text: "A", styles: {} }],
            [{ type: "text", text: "B", styles: {} }],
          ],
        },
        {
          cells: [
            [{ type: "text", text: "1", styles: {} }],
            [{ type: "text", text: "2", styles: {} }],
          ],
        },
      ],
    };
    const blocks: BlockNoteBlock[] = [{ type: "table", content: tableContent, children: [] }];
    expect(blockNoteToMarkdown(blocks)).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("converts inline styles", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "bold", styles: { bold: true } },
          { type: "text", text: " and ", styles: {} },
          { type: "text", text: "italic", styles: { italic: true } },
          { type: "text", text: " and ", styles: {} },
          { type: "text", text: "code", styles: { code: true } },
        ],
        children: [],
      },
    ];
    expect(blockNoteToMarkdown(blocks)).toBe("**bold** and *italic* and `code`");
  });

  it("converts links", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Visit ", styles: {} },
          {
            type: "link",
            text: "example",
            href: "https://example.com",
            content: [{ type: "text", text: "example", styles: {} }],
          },
        ],
        children: [],
      },
    ];
    expect(blockNoteToMarkdown(blocks)).toBe("Visit [example](https://example.com)");
  });

  it("handles nested children with indent", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "Parent", styles: {} }],
        children: [
          {
            type: "bulletListItem",
            content: [{ type: "text", text: "Child", styles: {} }],
            children: [],
          },
        ],
      },
    ];
    expect(blockNoteToMarkdown(blocks)).toBe("- Parent\n  - Child");
  });

  it("handles empty blocks", () => {
    const blocks: BlockNoteBlock[] = [];
    expect(blockNoteToMarkdown(blocks)).toBe("");
  });
});

describe("markdownToBlockNote", () => {
  it("parses headings", () => {
    const blocks = markdownToBlockNote("# Hello\n\n## World");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("heading");
    expect(blocks[0].props?.level).toBe(1);
    expect(blocks[1].type).toBe("heading");
    expect(blocks[1].props?.level).toBe(2);
  });

  it("parses paragraphs", () => {
    const blocks = markdownToBlockNote("Hello world");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].content).toEqual([{ type: "text", text: "Hello world", styles: {} }]);
  });

  it("parses bullet lists", () => {
    const blocks = markdownToBlockNote("- Item 1\n- Item 2");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("bulletListItem");
    expect(blocks[1].type).toBe("bulletListItem");
  });

  it("parses numbered lists", () => {
    const blocks = markdownToBlockNote("1. First\n2. Second");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("numberedListItem");
    expect(blocks[1].type).toBe("numberedListItem");
  });

  it("parses check lists", () => {
    const blocks = markdownToBlockNote("- [x] Done\n- [ ] Todo");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("checkListItem");
    expect(blocks[0].props?.checked).toBe(true);
    expect(blocks[1].type).toBe("checkListItem");
    expect(blocks[1].props?.checked).toBe(false);
  });

  it("parses code blocks", () => {
    const blocks = markdownToBlockNote("```ts\nconst x = 1;\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("codeBlock");
    expect(blocks[0].props?.language).toBe("ts");
    expect(blocks[0].content).toEqual([{ type: "text", text: "const x = 1;", styles: {} }]);
  });

  it("parses images", () => {
    const blocks = markdownToBlockNote("![Alt text](https://example.com/img.png)");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("image");
    expect(blocks[0].props?.url).toBe("https://example.com/img.png");
    expect(blocks[0].props?.caption).toBe("Alt text");
  });

  it("parses tables", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const blocks = markdownToBlockNote(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("table");
    const tc = blocks[0].content as BlockNoteTableContent;
    expect(tc.type).toBe("tableContent");
    expect(tc.rows).toHaveLength(2); // header + data row, separator skipped
  });

  it("parses inline bold", () => {
    const blocks = markdownToBlockNote("**bold text**");
    expect(blocks).toHaveLength(1);
    const content = blocks[0].content as { styles?: Record<string, boolean> }[];
    expect(content[0].styles?.bold).toBe(true);
  });

  it("parses inline code", () => {
    const blocks = markdownToBlockNote("Use `const` here");
    expect(blocks).toHaveLength(1);
    const content = blocks[0].content as {
      type: string;
      text: string;
      styles?: Record<string, boolean>;
    }[];
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "text", text: "Use ", styles: {} });
    expect(content[1]).toEqual({ type: "text", text: "const", styles: { code: true } });
    expect(content[2]).toEqual({ type: "text", text: " here", styles: {} });
  });

  it("parses links", () => {
    const blocks = markdownToBlockNote("[example](https://example.com)");
    expect(blocks).toHaveLength(1);
    const content = blocks[0].content as { type: string; href?: string }[];
    expect(content[0].type).toBe("link");
    expect(content[0].href).toBe("https://example.com");
  });

  it("handles empty input", () => {
    expect(markdownToBlockNote("")).toEqual([]);
    expect(markdownToBlockNote("  \n\n  ")).toEqual([]);
  });
});

describe("round-trip", () => {
  it("preserves headings through round-trip", () => {
    const md = "# Hello";
    const result = blockNoteToMarkdown(markdownToBlockNote(md));
    expect(result).toBe(md);
  });

  it("preserves code blocks through round-trip", () => {
    const md = "```ts\nconst x = 1;\n```";
    const result = blockNoteToMarkdown(markdownToBlockNote(md));
    expect(result).toBe(md);
  });

  it("preserves check lists through round-trip", () => {
    const md = "- [x] Done";
    const result = blockNoteToMarkdown(markdownToBlockNote(md));
    expect(result).toBe(md);
  });
});
