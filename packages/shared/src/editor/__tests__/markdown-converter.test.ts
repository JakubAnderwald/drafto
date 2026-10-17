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

  it("converts file blocks to a durable attachment link", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "file",
        props: { url: "attachment://user/note/doc.pdf", name: "doc.pdf", caption: "" },
        children: [],
      },
    ];
    expect(blockNoteToMarkdown(blocks)).toBe("[doc.pdf](attachment://user/note/doc.pdf)");
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

  it("preserves attachment file blocks through round-trip", () => {
    const md = "[doc.pdf](attachment://user/note/doc.pdf)";
    const blocks = markdownToBlockNote(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("file");
    expect(blocks[0].props?.url).toBe("attachment://user/note/doc.pdf");
    expect(blocks[0].props?.name).toBe("doc.pdf");
    expect(blockNoteToMarkdown(blocks)).toBe(md);
  });
});

// Regression tests for #465: an MCP client reads a note as Markdown
// (blockNoteToMarkdown) and saves it back (markdownToBlockNote), so both
// directions must agree exactly.
describe("round-trip stability", () => {
  const text = (value: string, styles: Record<string, boolean> = {}) => ({
    type: "text" as const,
    text: value,
    styles,
  });
  const paragraph = (...content: BlockNoteBlock["content"][]): BlockNoteBlock => ({
    type: "paragraph",
    content: content.flat() as BlockNoteBlock["content"],
    children: [],
  });
  const item = (
    type: string,
    value: string,
    children: BlockNoteBlock[] = [],
    props?: Record<string, unknown>,
  ): BlockNoteBlock => ({
    type,
    ...(props ? { props } : {}),
    content: [text(value)],
    children,
  });
  const table = (rows: string[][]): BlockNoteBlock => ({
    type: "table",
    content: {
      type: "tableContent",
      rows: rows.map((cells) => ({ cells: cells.map((cell) => [text(cell)]) })),
    },
    children: [],
  });
  const code = (value: string, language = ""): BlockNoteBlock => ({
    type: "codeBlock",
    props: { language },
    content: value ? [text(value)] : [],
    children: [],
  });

  function expectBlocksToRoundTrip(blocks: BlockNoteBlock[]) {
    expect(markdownToBlockNote(blockNoteToMarkdown(blocks))).toEqual(blocks);
  }

  function expectMarkdownToBeStable(md: string) {
    expect(blockNoteToMarkdown(markdownToBlockNote(md))).toBe(md);
  }

  describe("nesting", () => {
    it("parses an indented bullet as a child, not a sibling", () => {
      const blocks = markdownToBlockNote("- Parent\n  - Child");
      expect(blocks).toEqual([item("bulletListItem", "Parent", [item("bulletListItem", "Child")])]);
    });

    it("round-trips bullet, numbered and check lists nested three levels deep", () => {
      expectBlocksToRoundTrip([
        item("bulletListItem", "a", [
          item("bulletListItem", "a1", [item("bulletListItem", "a1x")]),
          item("bulletListItem", "a2"),
        ]),
        item("numberedListItem", "b", [
          item("numberedListItem", "b1", [item("numberedListItem", "b1x")]),
        ]),
        item("checkListItem", "c", [item("checkListItem", "c1", [], { checked: true })], {
          checked: false,
        }),
      ]);
    });

    it("round-trips mixed block types as children", () => {
      expectBlocksToRoundTrip([
        item("bulletListItem", "list", [
          item("numberedListItem", "step", [item("checkListItem", "todo", [], { checked: true })]),
          item("paragraph", "note"),
          item("heading", "Sub", [], { level: 2 }),
          code("const x = 1;", "ts"),
          table([
            ["h", "i"],
            ["1", "2"],
          ]),
        ]),
        item("paragraph", "after"),
      ]);
    });

    it("returns to the top level after a nested run", () => {
      const md = "- a\n  - b\n    - c\n- d\n  - e\n\nTop";
      const blocks = markdownToBlockNote(md);
      expect(blocks).toEqual([
        item("bulletListItem", "a", [item("bulletListItem", "b", [item("bulletListItem", "c")])]),
        item("bulletListItem", "d", [item("bulletListItem", "e")]),
        item("paragraph", "Top"),
      ]);
    });

    it("nests 4-space and tab indents one level under the nearest shallower item", () => {
      expect(markdownToBlockNote("1. a\n    1. b\n    1. c\n2. d")).toEqual([
        item("numberedListItem", "a", [
          item("numberedListItem", "b"),
          item("numberedListItem", "c"),
        ]),
        item("numberedListItem", "d"),
      ]);
      expect(markdownToBlockNote("- a\n\t- b")).toEqual([
        item("bulletListItem", "a", [item("bulletListItem", "b")]),
      ]);
    });

    it("keeps the markdown of nested lists stable", () => {
      expectMarkdownToBeStable("- a\n  - b\n    - [x] c\n  1. d");
    });

    // CommonMark nests a code block or list inside a list item when it is
    // indented to the item's content, so a strict parser (an MCP client)
    // keeps these children in their item.
    it("indents a numbered item's children 3 spaces, to its content column", () => {
      const blocks = [
        item("numberedListItem", "Step one", [
          code("npm install", "bash"),
          item("bulletListItem", "note"),
          item("checkListItem", "done", [], { checked: true }),
        ]),
      ];
      expect(blockNoteToMarkdown(blocks)).toBe(
        "1. Step one\n   ```bash\n   npm install\n   ```\n   - note\n   - [x] done",
      );
      expectBlocksToRoundTrip(blocks);
    });

    it("indents each level to its own parent's content column", () => {
      const blocks = [
        item("numberedListItem", "a", [
          item("numberedListItem", "b", [
            item("bulletListItem", "c", [item("numberedListItem", "d")]),
          ]),
        ]),
        item("checkListItem", "e", [item("numberedListItem", "f", [item("paragraph", "g")])], {
          checked: false,
        }),
      ];
      const md = "1. a\n   1. b\n      - c\n        1. d\n\n- [ ] e\n  1. f\n     g";
      expect(blockNoteToMarkdown(blocks)).toBe(md);
      expectBlocksToRoundTrip(blocks);
      expectMarkdownToBeStable(md);
    });

    it("indents a numbered item's table, and its empty paragraph's children, 3 spaces", () => {
      const rows = [
        ["h", "i"],
        ["1", "2"],
      ];
      expect(blockNoteToMarkdown([item("numberedListItem", "a", [table(rows)])])).toBe(
        "1. a\n   | h | i |\n   | --- | --- |\n   | 1 | 2 |",
      );
      const blocks: BlockNoteBlock[] = [
        item("numberedListItem", "a", [
          table(rows),
          { type: "paragraph", content: [], children: [item("bulletListItem", "b")] },
        ]),
      ];
      const md = blockNoteToMarkdown(blocks);
      expect(md.split("\n")).toContain("   - b");
      expect(markdownToBlockNote(md)).toEqual([
        item("numberedListItem", "a", [table(rows), item("bulletListItem", "b")]),
      ]);
    });

    // Copying the children array per child takes this past the test timeout.
    it("nests a long run of children under one parent, in order", () => {
      const md = ["- Parent", ...Array.from({ length: 100_000 }, (_, n) => `  - c${n}`)].join("\n");
      const [parent, ...rest] = markdownToBlockNote(md);
      expect(rest).toHaveLength(0);
      expect(parent.children).toHaveLength(100_000);
      expect(parent.children?.[0]).toEqual(item("bulletListItem", "c0"));
      expect(parent.children?.[99_999]).toEqual(item("bulletListItem", "c99999"));
    });
  });

  describe("escaping plain text", () => {
    it.each([
      ["2 * 3 * 4"],
      ["[not a link]"],
      ["[label](https://not.a.link)"],
      ["~~not struck~~"],
      ["`not code`"],
      ["**not bold**"],
      ["a ~ b ~~ c ~"],
      ["back\\slash \\* and trailing \\"],
      ["# not a heading"],
      ["###### not a heading"],
      ["- not a bullet"],
      ["+ not a bullet"],
      ["* not a bullet"],
      ["1. not a numbered item"],
      ["- [ ] not a check item"],
      ["| not | a table |"],
      ["![not an image](x.png)"],
      ["```not a fence"],
      ["#hashtag stays readable"],
    ])("round-trips the paragraph %j with no styles added", (value) => {
      const blocks = [paragraph([text(value)])];
      expectBlocksToRoundTrip(blocks);
      expect(blockNoteToMarkdown(blocks)).not.toBe("");
    });

    it("escapes only what the parser would read as syntax", () => {
      expect(blockNoteToMarkdown([paragraph([text("2 * 3 * 4")])])).toBe("2 \\* 3 \\* 4");
      expect(blockNoteToMarkdown([paragraph([text("# x")])])).toBe("\\# x");
      expect(blockNoteToMarkdown([paragraph([text("10. x")])])).toBe("10\\. x");
      expect(blockNoteToMarkdown([paragraph([text("a ~ b, #tag, 1.5 - 2 | c")])])).toBe(
        "a ~ b, #tag, 1.5 - 2 | c",
      );
      expect(blockNoteToMarkdown([paragraph([text("C:\\Users\\x")])])).toBe("C:\\Users\\x");
    });

    it("unescapes backslash-escaped punctuation when parsing", () => {
      expect(markdownToBlockNote("2 \\* 3 \\* 4")).toEqual([paragraph([text("2 * 3 * 4")])]);
      expect(markdownToBlockNote("\\# x")).toEqual([paragraph([text("# x")])]);
      expect(markdownToBlockNote("a \\q b")).toEqual([paragraph([text("a \\q b")])]);
    });

    it("keeps escapes as text inside code spans", () => {
      const blocks = [paragraph([text("a\\*b [c]", { code: true })])];
      expect(blockNoteToMarkdown(blocks)).toBe("`a\\*b [c]`");
      expectBlocksToRoundTrip(blocks);
    });

    it("escapes a trailing backslash before the next node's delimiter", () => {
      expectBlocksToRoundTrip([
        paragraph([text("ends with \\"), text("bold", { bold: true }), text("~", {})]),
      ]);
      expectBlocksToRoundTrip([paragraph([text("a~"), text("struck", { strike: true })])]);
    });

    it("keeps a paragraph starting with `!` before a link from becoming an image", () => {
      expectBlocksToRoundTrip([
        paragraph([
          text("!"),
          { type: "link", text: "x", href: "https://x.test", content: [text("x")] },
        ]),
      ]);
    });

    // parseLine strips leading whitespace (it is indent), so the emitter drops
    // it and escapes the syntax behind it; the whitespace itself is not kept.
    it.each([[" - x"], [" + x"], [" # x"], [" 1. x"], [" | a |"], ["\t- x"], ["   - [ ] x"]])(
      "keeps the paragraph %j a paragraph",
      (value) => {
        expect(markdownToBlockNote(blockNoteToMarkdown([paragraph([text(value)])]))).toEqual([
          paragraph([text(value.trimStart())]),
        ]);
      },
    );

    it("drops leading whitespace and escapes the syntax behind it", () => {
      expect(blockNoteToMarkdown([paragraph([text(" - x")])])).toBe("\\- x");
      expect(blockNoteToMarkdown([paragraph([text("  # x")])])).toBe("\\# x");
      expect(blockNoteToMarkdown([paragraph([text(" 1. x")])])).toBe("1\\. x");
      expect(blockNoteToMarkdown([paragraph([text(" | a |")])])).toBe("\\| a |");
    });

    // Kept, the whitespace would read back as indent and turn a flat note's
    // paragraph into a child of the block before it.
    it.each([["  b"], ["\tb"], ["  b"], ["    - b"], ["\n  b"]])(
      "keeps the paragraph %j a sibling of the block before it",
      (value) => {
        expect(
          markdownToBlockNote(
            blockNoteToMarkdown([paragraph([text("a")]), paragraph([text(value)])]),
          ),
        ).toEqual([paragraph([text("a")]), paragraph([text(value.trimStart())])]);
      },
    );

    // An empty or whitespace-only paragraph emits no visible line and vanishes
    // on parse; its children must not nest under the block before it.
    it.each([
      ["empty", []],
      ["whitespace-only", [text("  ")]],
      ["bold-space", [text(" ", { bold: true })]],
    ])("keeps the children of a vanishing %s paragraph at its depth", (_, content) => {
      const vanishing = (children: BlockNoteBlock[]): BlockNoteBlock => ({
        type: "paragraph",
        content: content as BlockNoteBlock["content"],
        children,
      });
      expect(
        markdownToBlockNote(
          blockNoteToMarkdown([
            item("bulletListItem", "a"),
            vanishing([item("bulletListItem", "child", [item("bulletListItem", "grandchild")])]),
          ]),
        ),
      ).toEqual([
        item("bulletListItem", "a"),
        item("bulletListItem", "child", [item("bulletListItem", "grandchild")]),
      ]);
      expect(
        markdownToBlockNote(
          blockNoteToMarkdown([
            item("bulletListItem", "a", [
              item("paragraph", "b"),
              vanishing([item("paragraph", "c")]),
            ]),
          ]),
        ),
      ).toEqual([item("bulletListItem", "a", [item("paragraph", "b"), item("paragraph", "c")])]);
    });

    it("keeps a nested paragraph starting with whitespace at its own depth", () => {
      expect(
        markdownToBlockNote(
          blockNoteToMarkdown([
            item("bulletListItem", "a", [item("paragraph", "x"), item("paragraph", "  y")]),
          ]),
        ),
      ).toEqual([item("bulletListItem", "a", [item("paragraph", "x"), item("paragraph", "y")])]);
    });

    it("keeps a paragraph starting with whitespace and `!` before a link from becoming an image", () => {
      const link = {
        type: "link" as const,
        text: "x",
        href: "https://x.test",
        content: [text("x")],
      };
      expect(markdownToBlockNote(blockNoteToMarkdown([paragraph([text(" !"), link])]))).toEqual([
        paragraph([text("!"), link]),
      ]);
    });

    it("escapes the same characters in headings, list items and check items", () => {
      expectBlocksToRoundTrip([
        item("heading", "# 2 * 3 [x]", [], { level: 2 }),
        item("bulletListItem", "[ ] not a check"),
        item("numberedListItem", "- dash *star*"),
        item("checkListItem", "`tick` ~~x~~", [], { checked: true }),
      ]);
    });
  });

  describe("inline styles", () => {
    it("parses ***both*** as a single bold+italic node and emits it back", () => {
      const blocks = markdownToBlockNote("***both***");
      expect(blocks[0].content).toEqual([text("both", { bold: true, italic: true })]);
      expect(blockNoteToMarkdown(blocks)).toBe("***both***");
    });

    it("round-trips every style combination", () => {
      expectBlocksToRoundTrip([
        paragraph([
          text("plain "),
          text("b", { bold: true }),
          text("i", { italic: true }),
          text("bi", { bold: true, italic: true }),
          text("s", { strike: true }),
          text("bis", { bold: true, italic: true, strike: true }),
          text("c*[|", { code: true, bold: true }),
          text(" end"),
        ]),
      ]);
    });

    it("round-trips adjacent styled nodes", () => {
      expectBlocksToRoundTrip([paragraph([text("a", { bold: true }), text("b", { bold: true })])]);
      expectBlocksToRoundTrip([
        paragraph([text("a", { italic: true }), text("b", { bold: true })]),
      ]);
      expectBlocksToRoundTrip([
        paragraph([text("a", { bold: true, italic: true }), text("b", { bold: true })]),
      ]);
      expectMarkdownToBeStable("**a****b**");
      expectMarkdownToBeStable("*a***b**");
    });

    it("moves a styled node's trailing space out between two styled nodes", () => {
      const blocks = [
        paragraph([text("a ", { bold: true }), text("b", { bold: true, italic: true })]),
      ];
      expect(blockNoteToMarkdown(blocks)).toBe("**a** ***b***");
      expect(markdownToBlockNote(blockNoteToMarkdown(blocks))).toEqual([
        paragraph([text("a", { bold: true }), text(" "), text("b", { bold: true, italic: true })]),
      ]);
    });

    it("parses a styled span holding more nodes than a call takes arguments", () => {
      const content = markdownToBlockNote(`**${"`a`b".repeat(100_000)}**`)[0].content;
      expect(content).toHaveLength(200_000);
      expect((content as { styles: Record<string, boolean> }[])[0].styles).toEqual({
        bold: true,
        code: true,
      });
    });

    it("round-trips styled text containing escaped delimiters", () => {
      expectBlocksToRoundTrip([
        paragraph([text("*", { italic: true }), text("**x**", { bold: true })]),
      ]);
    });
  });

  describe("whitespace at the edges of styled text", () => {
    const plainText = (blocks: BlockNoteBlock[]) =>
      (blocks[0].content as { text: string }[]).map((node) => node.text).join("");

    // Each case must keep its block type and text, and its Markdown must be stable.
    function expectStyledWhitespaceToRoundTrip(blocks: BlockNoteBlock[], markdown: string) {
      expect(blockNoteToMarkdown(blocks)).toBe(markdown);
      const parsed = markdownToBlockNote(markdown);
      expect(parsed.map((b) => b.type)).toEqual(blocks.map((b) => b.type));
      // A paragraph's leading whitespace is dropped on emit (see normalizeInline).
      expect(plainText(parsed)).toBe(plainText(blocks).trimStart());
      expectMarkdownToBeStable(markdown);
    }

    it.each([
      ["italic", { italic: true }, "*"],
      ["bold", { bold: true }, "**"],
      ["strike", { strike: true }, "~~"],
      ["bold italic", { bold: true, italic: true }, "***"],
    ])("keeps %s text with edge spaces at the start of a paragraph a paragraph", (_, styles, d) => {
      expectStyledWhitespaceToRoundTrip(
        [paragraph([text(" x ", styles), text("y")])],
        `${d}x${d} y`,
      );
      expectStyledWhitespaceToRoundTrip(
        [paragraph([text("x ", styles), text("y")])],
        `${d}x${d} y`,
      );
    });

    it.each([
      ["italic", { italic: true }, "*"],
      ["bold", { bold: true }, "**"],
      ["strike", { strike: true }, "~~"],
    ])("keeps %s text with edge spaces mid-line in place", (_, styles, d) => {
      expectStyledWhitespaceToRoundTrip(
        [paragraph([text("a"), text(" x ", styles), text("b")])],
        `a ${d}x${d} b`,
      );
      expectStyledWhitespaceToRoundTrip(
        [paragraph([text("a"), text("\tx  ", styles), text("b")])],
        `a\t${d}x${d}  b`,
      );
    });

    it("keeps an italic node starting with a space at the start of a paragraph out of a bullet", () => {
      // Before, this emitted `* x*`, which read back as a bullet item `x*`.
      expect(
        markdownToBlockNote(blockNoteToMarkdown([paragraph([text(" x", { italic: true })])])),
      ).toEqual([paragraph([text("x", { italic: true })])]);
    });

    it("keeps styled text with edge spaces in list items, check items and headings", () => {
      expectBlocksToRoundTrip([
        { ...item("bulletListItem", ""), content: [text("x", { italic: true }), text(" y")] },
      ]);
      expect(
        markdownToBlockNote(
          blockNoteToMarkdown([
            { ...item("bulletListItem", ""), content: [text(" x", { italic: true })] },
            {
              ...item("checkListItem", "", [], { checked: true }),
              content: [text(" x ", { bold: true })],
            },
            { ...item("heading", "", [], { level: 2 }), content: [text(" x", { strike: true })] },
          ]),
        ),
      ).toEqual([
        { ...item("bulletListItem", ""), content: [text("x", { italic: true })] },
        // The trailing space now follows the delimiter, so it reads back as plain text.
        {
          ...item("checkListItem", "", [], { checked: true }),
          content: [text("x", { bold: true }), text(" ")],
        },
        { ...item("heading", "", [], { level: 2 }), content: [text("x", { strike: true })] },
      ]);
    });

    it("keeps the spaces inside a code span", () => {
      expectBlocksToRoundTrip([paragraph([text("a "), text(" x ", { code: true }), text(" b")])]);
      expectBlocksToRoundTrip([paragraph([text(" x ", { code: true, bold: true })])]);
      expect(blockNoteToMarkdown([paragraph([text(" x ", { code: true, italic: true })])])).toBe(
        "*` x `*",
      );
    });

    it("drops the style of a styled node holding only whitespace", () => {
      const blocks = [paragraph([text("a"), text("  ", { italic: true }), text("b")])];
      expect(blockNoteToMarkdown(blocks)).toBe("a  b");
      expect(markdownToBlockNote(blockNoteToMarkdown(blocks))).toEqual([paragraph([text("a  b")])]);
    });

    it("escapes a backslash that ends up next to the closing delimiter", () => {
      const blocks = [paragraph([text("a\\ ", { italic: true }), text("b")])];
      expect(blockNoteToMarkdown(blocks)).toBe("*a\\\\* b");
      expect(markdownToBlockNote(blockNoteToMarkdown(blocks))).toEqual([
        paragraph([text("a\\", { italic: true }), text(" b")]),
      ]);
    });

    it("keeps styled link text with edge spaces inside the link", () => {
      const link = {
        type: "link" as const,
        text: " x ",
        href: "https://x.test",
        content: [text(" x ", { bold: true })],
      };
      expect(blockNoteToMarkdown([paragraph([text("a"), link])])).toBe(
        "a[ **x** ](https://x.test)",
      );
    });

    // Markdown that reads back with moved whitespace settles in one round trip:
    // the whitespace the block parser drops is dropped on emit, and escaping
    // sees the merged text a re-parse produces.
    it.each([
      ["- * x*"],
      ["# * x*"],
      ["1. ** x**"],
      ["- [ ] ~~ x~~"],
      ["| * x* | y |\n| --- | --- |"],
      ["| a\\ | b |\n| --- | --- |"],
      ["**a **~b"],
      ["~b** a**"],
      ["\\\\* *"],
      ["a\\* *b*"],
    ])("settles %j after one round trip", (md) => {
      expectMarkdownToBeStable(blockNoteToMarkdown(markdownToBlockNote(md)));
    });

    it("emits no whitespace after a line marker or at a table cell's edges", () => {
      expect(
        blockNoteToMarkdown([
          { ...item("bulletListItem", ""), content: [text(" x", { italic: true })] },
          { ...item("heading", "", [], { level: 1 }), content: [text("  x")] },
          {
            type: "table",
            content: {
              type: "tableContent",
              rows: [{ cells: [[text(" x ", { bold: true })], [text(" y ")]] }],
            },
            children: [],
          },
        ]),
      ).toBe("- *x*\n\n# x\n\n| **x** | y |\n| --- | --- |");
    });

    it("escapes a `~` or `\\` by the text it ends up next to", () => {
      // The space moved out of the bold node joins "~b", so `~` is no longer at an edge.
      expect(blockNoteToMarkdown([paragraph([text("a ", { bold: true }), text("~b")])])).toBe(
        "**a** ~b",
      );
      // A backslash followed by the moved space is not an escape, so it stays as is.
      expect(blockNoteToMarkdown([paragraph([text("a\\"), text(" b", { italic: true })])])).toBe(
        "a\\ *b*",
      );
    });
  });

  describe("links", () => {
    it("parses styled link text recursively", () => {
      const blocks = markdownToBlockNote("[**x**](https://example.com)");
      expect(blocks[0].content).toEqual([
        {
          type: "link",
          text: "x",
          href: "https://example.com",
          content: [text("x", { bold: true })],
        },
      ]);
      expectMarkdownToBeStable("[**x** and *y*](https://example.com)");
    });

    it("keeps an href containing parentheses intact", () => {
      const href = "https://en.wikipedia.org/wiki/Foo_(bar)";
      const blocks: BlockNoteBlock[] = [
        paragraph([{ type: "link", text: "wiki", href, content: [text("wiki")] }, text(" after")]),
      ];
      expect(blockNoteToMarkdown(blocks)).toBe(`[wiki](<${href}>) after`);
      expectBlocksToRoundTrip(blocks);
      // Hand-written balanced parentheses parse too.
      const parsed = markdownToBlockNote(`[wiki](${href})`);
      expect((parsed[0].content as { href?: string }[])[0].href).toBe(href);
    });

    it("keeps an href with a lone ), spaces or angle brackets intact", () => {
      for (const href of ["https://x.test/a)b", "https://x.test/a b", "https://x.test/<a>\\"]) {
        expectBlocksToRoundTrip([
          paragraph([{ type: "link", text: "x", href, content: [text("x")] }]),
        ]);
      }
    });

    it("round-trips link text containing brackets", () => {
      expectBlocksToRoundTrip([
        paragraph([{ type: "link", text: "[1]", href: "https://x.test", content: [text("[1]")] }]),
      ]);
    });

    it("round-trips an attachment named with spaces and parentheses", () => {
      const blocks: BlockNoteBlock[] = [
        {
          type: "file",
          props: { url: "attachment://user/note/report (1).pdf", name: "report (1).pdf" },
          children: [],
        },
      ];
      expect(blockNoteToMarkdown(blocks)).toBe(
        "[report (1).pdf](<attachment://user/note/report (1).pdf>)",
      );
      expectBlocksToRoundTrip(blocks);
    });

    it("round-trips an image block whose upload has not finished (empty url)", () => {
      const blocks: BlockNoteBlock[] = [{ type: "image", props: { url: "" }, children: [] }];
      expect(blockNoteToMarkdown(blocks)).toBe("![](<>)");
      expectBlocksToRoundTrip(blocks);
    });

    it("round-trips image captions with brackets and urls with parentheses", () => {
      expectBlocksToRoundTrip([
        {
          type: "image",
          props: { url: "https://x.test/img (2).png", caption: "a [b] c" },
          children: [],
        },
      ]);
    });

    it("round-trips attachment names and image captions containing backticks", () => {
      // A backtick in the label must not pair with one in the url as a code span.
      expectBlocksToRoundTrip([
        {
          type: "file",
          props: { url: "attachment://u/n/`report.pdf", name: "`report.pdf" },
          children: [],
        },
        {
          type: "image",
          props: { url: "https://x.test/`a.png", caption: "`a` and `b" },
          children: [],
        },
      ]);
    });

    it("keeps text that follows an image on the same line", () => {
      const href = "https://x.test/a.png";
      const blocks = markdownToBlockNote(`![diagram](${href}) Figure 1`);
      expect(blocks).toEqual([
        paragraph([
          text("!"),
          { type: "link", text: "diagram", href, content: [text("diagram")] },
          text(" Figure 1"),
        ]),
      ]);
      expectMarkdownToBeStable(blockNoteToMarkdown(blocks));
    });
  });

  describe("tables", () => {
    it("escapes a pipe in a cell so the column count survives", () => {
      const blocks = [
        table([
          ["a|b", "c"],
          ["1", "x | y"],
        ]),
      ];
      expect(blockNoteToMarkdown(blocks)).toBe("| a\\|b | c |\n| --- | --- |\n| 1 | x \\| y |");
      expectBlocksToRoundTrip(blocks);
    });

    it("escapes a pipe inside a code span in a cell", () => {
      const blocks: BlockNoteBlock[] = [
        {
          type: "table",
          content: {
            type: "tableContent",
            rows: [{ cells: [[text("a|b", { code: true })], [text("\\|")]] }],
          },
          children: [],
        },
      ];
      expectBlocksToRoundTrip(blocks);
    });

    it.each([["foo\\|bar"], ["foo\\\\|bar"], ["ends \\"]])(
      "keeps the code span %j in one cell",
      (value) => {
        const blocks: BlockNoteBlock[] = [
          {
            type: "table",
            content: {
              type: "tableContent",
              rows: [{ cells: [[text(value, { code: true })], [text("y")]] }],
            },
            children: [],
          },
        ];
        expectBlocksToRoundTrip(blocks);
      },
    );

    it("parses tables without trailing pipes", () => {
      expect(markdownToBlockNote("| a | b\n| --- | ---\n| 1 | 2")).toEqual([
        table([
          ["a", "b"],
          ["1", "2"],
        ]),
      ]);
    });

    it("never ingests the delimiter row, with or without alignment colons", () => {
      expect(markdownToBlockNote("| a | b |\n|:---|---:|\n| 1 | 2 |")).toEqual([
        table([
          ["a", "b"],
          ["1", "2"],
        ]),
      ]);
    });

    it("keeps a body row of dashes as data", () => {
      const blocks = [table([["h"], ["---"], ["x"]])];
      expectBlocksToRoundTrip(blocks);
    });

    it("keeps empty cells and styled cells", () => {
      expectMarkdownToBeStable("| a |  | **b** |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
    });

    it("keeps sibling tables under the same parent separate", () => {
      const blocks = [
        item("bulletListItem", "a", [
          table([["x"], ["1"]]),
          table([["y"], ["2"]]),
          item("paragraph", "after"),
        ]),
      ];
      expectBlocksToRoundTrip(blocks);
      expectMarkdownToBeStable(blockNoteToMarkdown(blocks));
    });

    it("stops a table at a line with a different indent", () => {
      const md = "- list\n  | a | b |\n  | --- | --- |\n| c |\n| --- |";
      expect(markdownToBlockNote(md)).toEqual([
        item("bulletListItem", "list", [table([["a", "b"]])]),
        table([["c"]]),
      ]);
    });
  });

  describe("code blocks", () => {
    it.each([
      ["a\n```\nb"],
      ["````\nnested\n````"],
      ["```js\nconsole.log(1)\n```"],
      ["  indented\n\n\ttabbed\n"],
      ["*not* [escaped] `here` \\"],
    ])("keeps the content %j byte-identical", (value) => {
      const blocks = [code(value, "md")];
      expectBlocksToRoundTrip(blocks);
      const parsed = markdownToBlockNote(blockNoteToMarkdown(blocks));
      expect((parsed[0].content as { text: string }[])[0].text).toBe(value);
    });

    it("lengthens the fence past the longest backtick run", () => {
      expect(blockNoteToMarkdown([code("a\n```\nb")])).toBe("````\na\n```\nb\n````");
      expect(blockNoteToMarkdown([code("x ````` y")])).toBe("``````\nx ````` y\n``````");
    });

    it("round-trips a code block nested under a list item", () => {
      expectBlocksToRoundTrip([item("bulletListItem", "a", [code("x\n  ```\ny", "ts")])]);
    });

    it("parses a fenced block indented under a list item as that item's code block child", () => {
      // How LLM clients usually write numbered steps with commands.
      const blocks = markdownToBlockNote(
        "1. Install\n   ```bash\n   npm install\n     --save\n   ```\n2. Run\n  ```\n  npm test\n  ```",
      );
      // As in CommonMark, content lines lose up to the fence's own indentation.
      expect(blocks).toEqual([
        item("numberedListItem", "Install", [code("npm install\n  --save", "bash")]),
        item("numberedListItem", "Run", [code("npm test")]),
      ]);
      expectBlocksToRoundTrip(blocks);
      // Emitted at the item's content column, 3 spaces, also where the input used 2.
      const md =
        "1. Install\n   ```bash\n   npm install\n     --save\n   ```\n\n1. Run\n   ```\n   npm test\n   ```";
      expect(blockNoteToMarkdown(blocks)).toBe(md);
      expectMarkdownToBeStable(md);
    });

    it("indents a nested code block's content lines to its fence", () => {
      const blocks = [
        item("bulletListItem", "a", [item("bulletListItem", "b", [code("x\n\n  y\n\tz", "ts")])]),
      ];
      expect(blockNoteToMarkdown(blocks)).toBe(
        "- a\n  - b\n    ```ts\n    x\n\n      y\n    \tz\n    ```",
      );
      expectBlocksToRoundTrip(blocks);
    });

    it.each([["  leading"], ["\ttab"], ["a\r\n  b\r"], ["a   b"], [" \n  \n"]])(
      "keeps the nested content %j byte-identical",
      (value) => {
        expectBlocksToRoundTrip([item("numberedListItem", "a", [code(value)])]);
      },
    );

    it("strips a hand-written top-level fence's indentation from its content", () => {
      expect(markdownToBlockNote(" ```\n x\n  y\nz\n ```")).toEqual([code("x\n y\nz")]);
      expect(markdownToBlockNote("```\n  x\n```")).toEqual([code("  x")]);
    });

    it("keeps an empty code block", () => {
      expectBlocksToRoundTrip([code("")]);
    });

    it("emits a code block with more backtick runs than a call takes arguments", () => {
      expectBlocksToRoundTrip([code("`a".repeat(500_000))]);
    });
  });

  it("round-trips a note combining every fix", () => {
    const md = [
      "# Plan \\*v2\\*",
      "- Parent with ***both***\n  - Child [**link**](<https://x.test/a_(b)>)\n    1. 2 \\* 3",
      "| col\\|1 | col 2 |\n| --- | --- |\n| `a\\|b` | ~~gone~~ |",
      "````ts\nconst s = `\n```\n`;\n````",
      "\\- not a list",
    ].join("\n\n");
    expectMarkdownToBeStable(md);
  });
});
