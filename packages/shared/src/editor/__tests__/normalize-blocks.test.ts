import { describe, expect, it } from "vitest";

import { normalizeBlocks } from "../normalize-blocks";
import type { BlockNoteBlock } from "../types";

describe("normalizeBlocks", () => {
  it("rewrites flat-shape link into canonical shape", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            text: "dev.smietnik@gmail.com",
            href: "mailto:dev.smietnik@gmail.com",
            styles: {},
          },
        ],
      },
    ];

    const out = normalizeBlocks(blocks);
    const link = (out[0].content as unknown as Array<Record<string, unknown>>)[0];
    expect(link.type).toBe("link");
    expect(link.href).toBe("mailto:dev.smietnik@gmail.com");
    expect(link.content).toEqual([{ type: "text", text: "dev.smietnik@gmail.com", styles: {} }]);
  });

  it("preserves styles by moving them onto the nested text item", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            text: "x",
            href: "https://x.test",
            styles: { bold: true },
          },
        ],
      },
    ];

    const out = normalizeBlocks(blocks);
    const link = (
      out[0].content as Array<{ content: Array<{ styles: Record<string, boolean> }> }>
    )[0];
    expect(link.content[0].styles).toEqual({ bold: true });
  });

  it("is idempotent on canonical input", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            href: "https://x.test",
            content: [{ type: "text", text: "x", styles: {} }],
          },
        ],
      },
    ];

    const once = normalizeBlocks(blocks);
    const twice = normalizeBlocks(once);
    expect(twice).toEqual(once);
  });

  it("recurses into block children and table cells", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "outer", styles: {} }],
        children: [
          {
            type: "paragraph",
            content: [{ type: "link", text: "inner", href: "https://i.test", styles: {} }],
          },
        ],
      },
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [
            {
              cells: [[{ type: "link", text: "cell-link", href: "https://c.test", styles: {} }]],
            },
          ],
        },
      },
    ];

    const out = normalizeBlocks(blocks);

    const childLink = (
      out[0].children?.[0].content as Array<{ content: Array<{ text: string }> }>
    )[0];
    expect(childLink.content[0].text).toBe("inner");

    const tableContent = out[1].content as {
      rows: { cells: Array<{ content: Array<{ text: string }> }>[] }[];
    };
    expect(tableContent.rows[0].cells[0][0].content[0].text).toBe("cell-link");
  });

  it("defaults missing text/href/styles when normalizing a partial flat-shape link", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [{ type: "link" }],
      },
    ];

    const out = normalizeBlocks(blocks);
    const link = (out[0].content as unknown as Array<Record<string, unknown>>)[0];
    expect(link.href).toBe("");
    expect(link.content).toEqual([{ type: "text", text: "", styles: {} }]);
  });

  it("treats a link with empty content array as flat and rewrites it", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [{ type: "link", href: "https://x.test", text: "x", content: [] }],
      },
    ];

    const out = normalizeBlocks(blocks);
    const link = (out[0].content as unknown as Array<Record<string, unknown>>)[0];
    expect(link.content).toEqual([{ type: "text", text: "x", styles: {} }]);
  });

  it("leaves blocks without content untouched (e.g. image blocks)", () => {
    const blocks: BlockNoteBlock[] = [{ type: "image", props: { url: "https://x.test/a.png" } }];
    const out = normalizeBlocks(blocks);
    expect(out).toEqual(blocks);
  });

  it("returns the same shape for an empty input array", () => {
    expect(normalizeBlocks([])).toEqual([]);
  });

  it("normalises wrapped {type:'tableCell', content} cells without throwing", () => {
    // Regression: BlockNote v0.47+ may persist cells as TableCell objects.
    // Walking `cell.map` would TypeError on a non-array, crashing the editor
    // load. The walker must handle both shapes.
    const blocks: BlockNoteBlock[] = [
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [
            {
              cells: [
                {
                  type: "tableCell",
                  props: { textAlignment: "left" },
                  content: [
                    { type: "link", text: "x", href: "https://x.test", styles: { bold: true } },
                  ],
                },
              ],
            },
          ],
        },
      },
    ];

    const out = normalizeBlocks(blocks);
    const tableContent = out[0].content as {
      rows: {
        cells: Array<{ type: string; content: Array<{ content: Array<{ text: string }> }> }>;
      }[];
    };
    const cell = tableContent.rows[0].cells[0];
    expect(cell.type).toBe("tableCell");
    expect(cell.content[0].content[0].text).toBe("x");
  });

  it("supports tables that mix wrapped and legacy cell shapes in one row", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [
            {
              cells: [
                [{ type: "link", text: "legacy", href: "https://l.test", styles: {} }],
                {
                  type: "tableCell",
                  content: [{ type: "link", text: "wrapped", href: "https://w.test", styles: {} }],
                },
              ],
            },
          ],
        },
      },
    ];

    const out = normalizeBlocks(blocks);
    const row = (
      out[0].content as {
        rows: {
          cells: Array<unknown>;
        }[];
      }
    ).rows[0];
    const legacyCell = row.cells[0] as Array<{ content: Array<{ text: string }> }>;
    const wrappedCell = row.cells[1] as { content: Array<{ content: Array<{ text: string }> }> };
    expect(legacyCell[0].content[0].text).toBe("legacy");
    expect(wrappedCell.content[0].content[0].text).toBe("wrapped");
  });

  it("leaves non-link inline items untouched", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "hello", styles: { bold: true } }],
      },
    ];

    const out = normalizeBlocks(blocks);
    expect(out).toEqual(blocks);
  });
});
