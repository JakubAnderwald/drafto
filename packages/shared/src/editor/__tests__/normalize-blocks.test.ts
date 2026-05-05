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
