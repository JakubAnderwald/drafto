import { describe, it, expect } from "vitest";
import { blocknoteToTiptap, tiptapToBlocknote, contentToTiptap, contentToBlocknote } from "../src";
import type { BlockNoteBlock, TipTapDoc } from "../src";

describe("blocknoteToTiptap", () => {
  it("converts a simple paragraph", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Hello world", styles: {} }],
        children: [],
      },
    ];

    const doc = blocknoteToTiptap(blocks);

    expect(doc).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello world" }],
        },
      ],
    });
  });

  it("converts a heading with level", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "heading",
        props: { level: 2 },
        content: [{ type: "text", text: "My Heading", styles: {} }],
        children: [],
      },
    ];

    const doc = blocknoteToTiptap(blocks);

    expect(doc.content[0]).toEqual({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "My Heading" }],
    });
  });

  it("converts styled text with bold and italic", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "bold", styles: { bold: true } },
          { type: "text", text: " and ", styles: {} },
          { type: "text", text: "italic", styles: { italic: true } },
        ],
        children: [],
      },
    ];

    const doc = blocknoteToTiptap(blocks);
    const content = doc.content[0].content!;

    expect(content[0]).toEqual({
      type: "text",
      text: "bold",
      marks: [{ type: "bold" }],
    });
    expect(content[1]).toEqual({ type: "text", text: " and " });
    expect(content[2]).toEqual({
      type: "text",
      text: "italic",
      marks: [{ type: "italic" }],
    });
  });

  it("converts a link", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            text: "click here",
            href: "https://drafto.eu",
            content: [{ type: "text", text: "click here", styles: {} }],
          },
        ],
        children: [],
      },
    ];

    const doc = blocknoteToTiptap(blocks);
    const content = doc.content[0].content!;

    expect(content[0]).toEqual({
      type: "text",
      text: "click here",
      marks: [{ type: "link", attrs: { href: "https://drafto.eu" } }],
    });
  });

  it("converts bullet list items and merges adjacent", () => {
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

    const doc = blocknoteToTiptap(blocks);

    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe("bulletList");
    expect(doc.content[0].content).toHaveLength(2);
  });

  it("converts numbered list items and merges adjacent", () => {
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

    const doc = blocknoteToTiptap(blocks);

    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe("orderedList");
    expect(doc.content[0].content).toHaveLength(2);
  });

  it("converts nested bullet list items", () => {
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

    const doc = blocknoteToTiptap(blocks);

    const li = doc.content[0].content![0];
    expect(li.content).toHaveLength(2);
    expect(li.content![1].type).toBe("bulletList");
    expect(li.content![1].content![0].content![0].content![0].text).toBe("Child");
  });

  it("converts check list items", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "checkListItem",
        props: { checked: true },
        content: [{ type: "text", text: "Done task", styles: {} }],
        children: [],
      },
      {
        type: "checkListItem",
        props: { checked: false },
        content: [{ type: "text", text: "Todo task", styles: {} }],
        children: [],
      },
    ];

    const doc = blocknoteToTiptap(blocks);

    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe("taskList");
    const items = doc.content[0].content!;
    expect(items[0].attrs?.checked).toBe(true);
    expect(items[1].attrs?.checked).toBe(false);
  });

  it("converts a code block", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "codeBlock",
        props: { language: "typescript" },
        content: [{ type: "text", text: "const x = 1;", styles: {} }],
        children: [],
      },
    ];

    const doc = blocknoteToTiptap(blocks);

    expect(doc.content[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [{ type: "text", text: "const x = 1;" }],
    });
  });

  it("converts an image", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "image",
        props: { url: "https://example.com/img.png", caption: "A photo", width: 400 },
        children: [],
      },
    ];

    const doc = blocknoteToTiptap(blocks);

    expect(doc.content[0]).toEqual({
      type: "image",
      attrs: { src: "https://example.com/img.png", alt: "A photo", width: 400 },
    });
  });

  it("converts a file block to a paragraph with an attachment link", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "file",
        props: { url: "attachment://user-1/note-1/report.pdf", name: "report.pdf" },
        children: [],
      },
    ];

    const doc = blocknoteToTiptap(blocks);

    expect(doc.content[0]).toEqual({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "report.pdf",
          marks: [{ type: "link", attrs: { href: "attachment://user-1/note-1/report.pdf" } }],
        },
      ],
    });
  });

  it("converts a table", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "table",
        content: {
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
                [{ type: "text", text: "C", styles: {} }],
                [{ type: "text", text: "D", styles: {} }],
              ],
            },
          ],
        },
        children: [],
      },
    ];

    const doc = blocknoteToTiptap(blocks);
    const table = doc.content[0];

    expect(table.type).toBe("table");
    expect(table.content).toHaveLength(2);
    expect(table.content![0].type).toBe("tableRow");
    expect(table.content![0].content![0].type).toBe("tableCell");
  });

  it("converts empty blocks", () => {
    const blocks: BlockNoteBlock[] = [{ type: "paragraph", content: [], children: [] }];

    const doc = blocknoteToTiptap(blocks);

    expect(doc.content[0]).toEqual({ type: "paragraph" });
  });

  it("converts empty input", () => {
    const doc = blocknoteToTiptap([]);
    expect(doc).toEqual({ type: "doc", content: [] });
  });
});

describe("tiptapToBlocknote", () => {
  it("converts a simple paragraph", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello world" }],
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "Hello world", styles: {} }],
        children: [],
      },
    ]);
  });

  it("converts a heading", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Title" }],
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks[0]).toEqual({
      type: "heading",
      props: { level: 3 },
      content: [{ type: "text", text: "Title", styles: {} }],
      children: [],
    });
  });

  it("converts styled text with marks", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "bold text",
              marks: [{ type: "bold" }],
            },
          ],
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks[0].content).toEqual([
      { type: "text", text: "bold text", styles: { bold: true } },
    ]);
  });

  it("converts a link mark to link inline content", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "click",
              marks: [{ type: "link", attrs: { href: "https://drafto.eu" } }],
            },
          ],
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks[0].content).toEqual([
      {
        type: "link",
        text: "click",
        href: "https://drafto.eu",
        content: [{ type: "text", text: "click", styles: {} }],
      },
    ]);
  });

  it("converts a bullet list", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }],
            },
          ],
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("bulletListItem");
    expect(blocks[1].type).toBe("bulletListItem");
  });

  it("converts nested lists", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Parent" }] },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "Child" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].children).toHaveLength(1);
    expect(blocks[0].children![0].type).toBe("bulletListItem");
  });

  it("converts a task list", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Done" }] }],
            },
          ],
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks[0].type).toBe("checkListItem");
    expect(blocks[0].props?.checked).toBe(true);
  });

  it("converts a code block", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "python" },
          content: [{ type: "text", text: "print('hi')" }],
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks[0]).toEqual({
      type: "codeBlock",
      props: { language: "python" },
      content: [{ type: "text", text: "print('hi')", styles: {} }],
      children: [],
    });
  });

  it("converts an image", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "https://example.com/img.png", alt: "Photo", width: 300 },
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks[0]).toEqual({
      type: "image",
      props: { url: "https://example.com/img.png", caption: "Photo", width: 300 },
      children: [],
    });
  });

  it("restores a file block from a paragraph containing a single attachment link", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "report.pdf",
              marks: [
                {
                  type: "link",
                  attrs: { href: "attachment://user-1/note-1/report.pdf" },
                },
              ],
            },
          ],
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks[0]).toEqual({
      type: "file",
      props: { url: "attachment://user-1/note-1/report.pdf", name: "report.pdf" },
      children: [],
    });
  });

  it("keeps external links in paragraphs (not converted to file blocks)", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "docs",
              marks: [{ type: "link", attrs: { href: "https://docs.example.com" } }],
            },
          ],
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].content).toEqual([
      {
        type: "link",
        text: "docs",
        href: "https://docs.example.com",
        content: [{ type: "text", text: "docs", styles: {} }],
      },
    ]);
  });

  it("converts a table", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "X" }] }],
                },
              ],
            },
          ],
        },
      ],
    };

    const blocks = tiptapToBlocknote(doc);

    expect(blocks[0].type).toBe("table");
    const tableContent = blocks[0].content as { type: string; rows: { cells: unknown[][] }[] };
    expect(tableContent.type).toBe("tableContent");
    expect(tableContent.rows).toHaveLength(1);
    expect(tableContent.rows[0].cells).toHaveLength(1);
  });

  it("handles empty doc", () => {
    const doc: TipTapDoc = { type: "doc", content: [] };
    expect(tiptapToBlocknote(doc)).toEqual([]);
  });
});

describe("round-trip fidelity", () => {
  it("paragraph round-trips BlockNote -> TipTap -> BlockNote", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello ", styles: {} },
          { type: "text", text: "world", styles: { bold: true } },
        ],
        children: [],
      },
    ];

    const tiptap = blocknoteToTiptap(original);
    const roundTripped = tiptapToBlocknote(tiptap);

    expect(roundTripped).toEqual(original);
  });

  it("heading round-trips", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "heading",
        props: { level: 2 },
        content: [{ type: "text", text: "Title", styles: {} }],
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("bullet list round-trips", () => {
    const original: BlockNoteBlock[] = [
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

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("nested list round-trips", () => {
    const original: BlockNoteBlock[] = [
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

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("check list round-trips", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "checkListItem",
        props: { checked: true },
        content: [{ type: "text", text: "Done", styles: {} }],
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("code block round-trips", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "codeBlock",
        props: { language: "javascript" },
        content: [{ type: "text", text: "const x = 1;", styles: {} }],
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("image round-trips", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "image",
        props: { url: "https://example.com/img.png", caption: "Photo", width: 400 },
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("complex document round-trips", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: "Welcome", styles: {} }],
        children: [],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "This is ", styles: {} },
          { type: "text", text: "bold", styles: { bold: true } },
          { type: "text", text: " and ", styles: {} },
          { type: "text", text: "italic", styles: { italic: true } },
        ],
        children: [],
      },
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "First", styles: {} }],
        children: [],
      },
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "Second", styles: {} }],
        children: [
          {
            type: "bulletListItem",
            content: [{ type: "text", text: "Nested", styles: {} }],
            children: [],
          },
        ],
      },
      {
        type: "paragraph",
        content: [],
        children: [],
      },
      {
        type: "codeBlock",
        props: { language: "ts" },
        content: [{ type: "text", text: "console.log('hi');", styles: {} }],
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("table round-trips", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "table",
        content: {
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
                [{ type: "text", text: "C", styles: {} }],
                [{ type: "text", text: "D", styles: {} }],
              ],
            },
          ],
        },
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("link round-trips", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Visit ", styles: {} },
          {
            type: "link",
            text: "Drafto",
            href: "https://drafto.eu",
            content: [{ type: "text", text: "Drafto", styles: {} }],
          },
          { type: "text", text: " for notes.", styles: {} },
        ],
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("numbered list round-trips", () => {
    const original: BlockNoteBlock[] = [
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
      {
        type: "numberedListItem",
        content: [{ type: "text", text: "Third", styles: {} }],
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("multiple styles round-trip (bold + italic + underline)", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "all styles",
            styles: { bold: true, italic: true, underline: true },
          },
        ],
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("strike and code styles round-trip", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "deleted", styles: { strike: true } },
          { type: "text", text: " and ", styles: {} },
          { type: "text", text: "inline code", styles: { code: true } },
        ],
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("link with bold style round-trips", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            text: "bold link",
            href: "https://example.com",
            content: [{ type: "text", text: "bold link", styles: { bold: true } }],
          },
        ],
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("deeply nested bullet list round-trips (3 levels)", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "Level 1", styles: {} }],
        children: [
          {
            type: "bulletListItem",
            content: [{ type: "text", text: "Level 2", styles: {} }],
            children: [
              {
                type: "bulletListItem",
                content: [{ type: "text", text: "Level 3", styles: {} }],
                children: [],
              },
            ],
          },
        ],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("empty paragraph round-trips", () => {
    const original: BlockNoteBlock[] = [{ type: "paragraph", content: [], children: [] }];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("file block round-trips via paragraph-with-attachment-link", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "file",
        props: { url: "attachment://user-1/note-1/report.pdf", name: "report.pdf" },
        children: [],
      },
    ];

    const tiptap = blocknoteToTiptap(original);
    expect(tiptap.content[0].type).toBe("paragraph");

    const roundTripped = tiptapToBlocknote(tiptap);
    expect(roundTripped).toEqual(original);
  });

  it("image without optional props round-trips", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "image",
        props: { url: "https://example.com/photo.jpg" },
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("code block without language round-trips", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "codeBlock",
        props: { language: "" },
        content: [{ type: "text", text: "plain code", styles: {} }],
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("heading levels 1-3 round-trip", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: "H1", styles: {} }],
        children: [],
      },
      {
        type: "heading",
        props: { level: 2 },
        content: [{ type: "text", text: "H2", styles: {} }],
        children: [],
      },
      {
        type: "heading",
        props: { level: 3 },
        content: [{ type: "text", text: "H3", styles: {} }],
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("realistic note content round-trips without data loss", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: "Meeting Notes", styles: {} }],
        children: [],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Discussed the ", styles: {} },
          { type: "text", text: "Q4 roadmap", styles: { bold: true } },
          { type: "text", text: " with the team. See ", styles: {} },
          {
            type: "link",
            text: "project board",
            href: "https://example.com/board",
            content: [{ type: "text", text: "project board", styles: {} }],
          },
          { type: "text", text: " for details.", styles: {} },
        ],
        children: [],
      },
      {
        type: "heading",
        props: { level: 2 },
        content: [{ type: "text", text: "Action Items", styles: {} }],
        children: [],
      },
      {
        type: "checkListItem",
        props: { checked: true },
        content: [{ type: "text", text: "Review PR #42", styles: {} }],
        children: [],
      },
      {
        type: "checkListItem",
        props: { checked: false },
        content: [{ type: "text", text: "Write unit tests", styles: {} }],
        children: [],
      },
      {
        type: "numberedListItem",
        content: [{ type: "text", text: "Deploy to staging", styles: {} }],
        children: [],
      },
      {
        type: "numberedListItem",
        content: [{ type: "text", text: "Run smoke tests", styles: {} }],
        children: [],
      },
      {
        type: "codeBlock",
        props: { language: "bash" },
        content: [{ type: "text", text: "pnpm test && pnpm build", styles: {} }],
        children: [],
      },
      {
        type: "paragraph",
        content: [],
        children: [],
      },
      {
        type: "image",
        props: { url: "https://example.com/architecture.png", caption: "System diagram" },
        children: [],
      },
    ];

    const tiptap = blocknoteToTiptap(original);
    const roundTripped = tiptapToBlocknote(tiptap);
    expect(roundTripped).toEqual(original);
  });

  it("table with styled content round-trips", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [
            {
              cells: [
                [{ type: "text", text: "Name", styles: { bold: true } }],
                [{ type: "text", text: "Status", styles: { bold: true } }],
              ],
            },
            {
              cells: [
                [{ type: "text", text: "Feature A", styles: {} }],
                [{ type: "text", text: "Done", styles: { italic: true } }],
              ],
            },
          ],
        },
        children: [],
      },
    ];

    const roundTripped = tiptapToBlocknote(blocknoteToTiptap(original));
    expect(roundTripped).toEqual(original);
  });

  it("TipTap -> BlockNote -> TipTap round-trips a paragraph", () => {
    const original: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: " bold", marks: [{ type: "bold" }] },
          ],
        },
      ],
    };

    const roundTripped = blocknoteToTiptap(tiptapToBlocknote(original));
    expect(roundTripped).toEqual(original);
  });
});

describe("contentToTiptap", () => {
  it("converts BlockNote array to TipTap doc", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Hello", styles: {} }],
        children: [],
      },
    ];

    const result = contentToTiptap(blocks);

    expect(result.type).toBe("doc");
    expect(result.content[0].type).toBe("paragraph");
    expect(result.content[0].content![0].text).toBe("Hello");
  });

  it("passes through TipTap doc as-is", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Already TipTap" }],
        },
      ],
    };

    const result = contentToTiptap(doc);

    expect(result).toBe(doc);
  });

  it("returns empty doc for null", () => {
    const result = contentToTiptap(null);
    expect(result).toEqual({ type: "doc", content: [] });
  });

  it("returns empty doc for undefined", () => {
    const result = contentToTiptap(undefined);
    expect(result).toEqual({ type: "doc", content: [] });
  });

  it("returns empty doc for a string", () => {
    const result = contentToTiptap("not json");
    expect(result).toEqual({ type: "doc", content: [] });
  });

  it("returns empty doc for empty array (treated as empty BlockNote)", () => {
    const result = contentToTiptap([]);
    expect(result).toEqual({ type: "doc", content: [] });
  });
});

describe("contentToBlocknote", () => {
  it("converts TipTap doc to BlockNote array", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    };

    const result = contentToBlocknote(doc);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("paragraph");
  });

  it("passes through BlockNote array as-is", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Already BlockNote", styles: {} }],
        children: [],
      },
    ];

    const result = contentToBlocknote(blocks);

    expect(result).toBe(blocks);
  });

  it("returns empty array for null", () => {
    const result = contentToBlocknote(null);
    expect(result).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    const result = contentToBlocknote(undefined);
    expect(result).toEqual([]);
  });

  it("returns empty array for a number", () => {
    const result = contentToBlocknote(42);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty array (treated as empty BlockNote)", () => {
    const result = contentToBlocknote([]);
    expect(result).toEqual([]);
  });
});

describe("contentToTiptap / contentToBlocknote round-trip", () => {
  it("BlockNote -> contentToTiptap -> contentToBlocknote preserves content", () => {
    const original: BlockNoteBlock[] = [
      {
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: "Title", styles: {} }],
        children: [],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Some ", styles: {} },
          { type: "text", text: "bold", styles: { bold: true } },
        ],
        children: [],
      },
    ];

    const tiptap = contentToTiptap(original);
    const roundTripped = contentToBlocknote(tiptap);

    expect(roundTripped).toEqual(original);
  });

  it("TipTap -> contentToBlocknote -> contentToTiptap preserves content", () => {
    const original: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: " world", marks: [{ type: "italic" }] },
          ],
        },
      ],
    };

    const blocks = contentToBlocknote(original);
    const roundTripped = contentToTiptap(blocks);

    expect(roundTripped).toEqual(original);
  });
});
