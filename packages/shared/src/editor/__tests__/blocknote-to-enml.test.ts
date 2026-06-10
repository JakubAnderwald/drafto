import { describe, it, expect } from "vitest";
import { blocksToEnml, type MediaIndex } from "../blocknote-to-enml";
import type { BlockNoteBlock } from "../types";

const NO_MEDIA: MediaIndex = new Map();

describe("blocksToEnml", () => {
  it("wraps output in <en-note>", () => {
    const out = blocksToEnml(
      [{ type: "paragraph", content: [{ type: "text", text: "Hi", styles: {} }] }],
      NO_MEDIA,
    );
    expect(out.startsWith("<en-note>")).toBe(true);
    expect(out.endsWith("</en-note>")).toBe(true);
  });

  it("emits headings h1..h3", () => {
    const blocks: BlockNoteBlock[] = [
      { type: "heading", props: { level: 1 }, content: [{ type: "text", text: "A", styles: {} }] },
      { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "B", styles: {} }] },
      { type: "heading", props: { level: 3 }, content: [{ type: "text", text: "C", styles: {} }] },
    ];
    const out = blocksToEnml(blocks, NO_MEDIA);
    expect(out).toContain("<h1>A</h1>");
    expect(out).toContain("<h2>B</h2>");
    expect(out).toContain("<h3>C</h3>");
  });

  it("clamps h4+ to h3", () => {
    const out = blocksToEnml(
      [
        {
          type: "heading",
          props: { level: 5 },
          content: [{ type: "text", text: "deep", styles: {} }],
        },
      ],
      NO_MEDIA,
    );
    expect(out).toContain("<h3>deep</h3>");
  });

  it("emits paragraphs as <div> and uses <br/> for empty paragraphs", () => {
    const out = blocksToEnml(
      [
        { type: "paragraph", content: [{ type: "text", text: "Hello", styles: {} }] },
        { type: "paragraph", content: [] },
      ],
      NO_MEDIA,
    );
    expect(out).toContain("<div>Hello</div>");
    expect(out).toContain("<div><br/></div>");
  });

  it("emits bullet and numbered lists", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "a", styles: {} }],
      },
      {
        type: "numberedListItem",
        content: [{ type: "text", text: "1", styles: {} }],
      },
    ];
    const out = blocksToEnml(blocks, NO_MEDIA);
    expect(out).toContain("<ul><li>a</li></ul>");
    expect(out).toContain("<ol><li>1</li></ol>");
  });

  it("groups consecutive list items of the same type into one container", () => {
    const blocks: BlockNoteBlock[] = [
      { type: "bulletListItem", content: [{ type: "text", text: "a", styles: {} }] },
      { type: "bulletListItem", content: [{ type: "text", text: "b", styles: {} }] },
      { type: "bulletListItem", content: [{ type: "text", text: "c", styles: {} }] },
      { type: "numberedListItem", content: [{ type: "text", text: "1", styles: {} }] },
      { type: "numberedListItem", content: [{ type: "text", text: "2", styles: {} }] },
    ];
    const out = blocksToEnml(blocks, NO_MEDIA);
    expect(out).toContain("<ul><li>a</li><li>b</li><li>c</li></ul>");
    expect(out).toContain("<ol><li>1</li><li>2</li></ol>");
    expect(out).not.toContain("</ul><ul>");
    expect(out).not.toContain("</ol><ol>");
  });

  it("emits check list items with <en-todo>", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "checkListItem",
        props: { checked: true },
        content: [{ type: "text", text: "done", styles: {} }],
      },
      {
        type: "checkListItem",
        props: { checked: false },
        content: [{ type: "text", text: "todo", styles: {} }],
      },
    ];
    const out = blocksToEnml(blocks, NO_MEDIA);
    expect(out).toContain('<en-todo checked="true"/>done');
    expect(out).toContain('<en-todo checked="false"/>todo');
  });

  it("emits inline styles bold/italic/underline/strike/code", () => {
    const block: BlockNoteBlock = {
      type: "paragraph",
      content: [
        { type: "text", text: "B", styles: { bold: true } },
        { type: "text", text: "I", styles: { italic: true } },
        { type: "text", text: "U", styles: { underline: true } },
        { type: "text", text: "S", styles: { strike: true } },
        { type: "text", text: "C", styles: { code: true } },
      ],
    };
    const out = blocksToEnml([block], NO_MEDIA);
    expect(out).toContain("<b>B</b>");
    expect(out).toContain("<i>I</i>");
    expect(out).toContain("<u>U</u>");
    expect(out).toContain("<s>S</s>");
    expect(out).toContain("<code>C</code>");
  });

  it("emits links with escaped href", () => {
    const block: BlockNoteBlock = {
      type: "paragraph",
      content: [
        {
          type: "link",
          href: "https://example.com/?a=1&b=2",
          content: [{ type: "text", text: "link", styles: {} }],
        },
      ],
    };
    const out = blocksToEnml([block], NO_MEDIA);
    expect(out).toContain('<a href="https://example.com/?a=1&amp;b=2">link</a>');
  });

  it("emits code blocks inside <pre><code>", () => {
    const block: BlockNoteBlock = {
      type: "codeBlock",
      props: { language: "ts" },
      content: [{ type: "text", text: "const x = 1 < 2;", styles: {} }],
    };
    const out = blocksToEnml([block], NO_MEDIA);
    expect(out).toContain("<pre><code>const x = 1 &lt; 2;</code></pre>");
  });

  it("emits <en-media> when image url is in mediaIndex", () => {
    const mediaIndex: MediaIndex = new Map([
      ["attachment://user/note/photo.png", { hash: "abc123", mime: "image/png" }],
    ]);
    const block: BlockNoteBlock = {
      type: "image",
      props: { url: "attachment://user/note/photo.png", width: 200 },
    };
    const out = blocksToEnml([block], mediaIndex);
    expect(out).toContain('<en-media type="image/png" hash="abc123" width="200"/>');
  });

  it("falls back to a link when image url is missing from mediaIndex", () => {
    const block: BlockNoteBlock = {
      type: "image",
      props: { url: "attachment://missing", caption: "Photo" },
    };
    const out = blocksToEnml([block], NO_MEDIA);
    expect(out).toContain('<a href="attachment://missing">Photo</a>');
  });

  it("emits file blocks as <en-media> when matched", () => {
    const mediaIndex: MediaIndex = new Map([
      ["attachment://x.pdf", { hash: "deadbeef", mime: "application/pdf" }],
    ]);
    const block: BlockNoteBlock = {
      type: "file",
      props: { url: "attachment://x.pdf", name: "x.pdf" },
    };
    const out = blocksToEnml([block], mediaIndex);
    expect(out).toContain('<en-media type="application/pdf" hash="deadbeef"/>');
  });

  it("escapes XML special characters in text", () => {
    const block: BlockNoteBlock = {
      type: "paragraph",
      content: [{ type: "text", text: "<a> & </a>", styles: {} }],
    };
    const out = blocksToEnml([block], NO_MEDIA);
    expect(out).toContain("&lt;a&gt; &amp; &lt;/a&gt;");
  });

  it("emits tables with one <tr> per row and <td> per cell", () => {
    const block: BlockNoteBlock = {
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
              [{ type: "text", text: "1", styles: {} }],
              [{ type: "text", text: "2", styles: {} }],
            ],
          },
        ],
      },
    };
    const out = blocksToEnml([block], NO_MEDIA);
    expect(out).toContain(
      "<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>",
    );
  });

  it("emits tables when cells are stored in the wrapped {type:'tableCell', content} shape", () => {
    // BlockNote v0.47+ persists table cells as { type: "tableCell", content }.
    // The walker must read `.content` instead of treating the cell as an
    // InlineContent[] (the legacy shape).
    const block: BlockNoteBlock = {
      type: "table",
      content: {
        type: "tableContent",
        rows: [
          {
            cells: [
              {
                type: "tableCell",
                props: { textAlignment: "left" },
                content: [{ type: "text", text: "wrapped", styles: {} }],
              },
              {
                type: "tableCell",
                props: {},
                content: [{ type: "text", text: "cell", styles: { bold: true } }],
              },
            ],
          },
        ],
      },
    };
    const out = blocksToEnml([block], NO_MEDIA);
    expect(out).toContain("<td>wrapped</td>");
    expect(out).toContain("<td><b>cell</b></td>");
    expect(out).not.toContain("<td>&#xA0;</td>");
  });

  it("renders nested children under list items", () => {
    const block: BlockNoteBlock = {
      type: "bulletListItem",
      content: [{ type: "text", text: "outer", styles: {} }],
      children: [
        {
          type: "bulletListItem",
          content: [{ type: "text", text: "inner", styles: {} }],
        },
      ],
    };
    const out = blocksToEnml([block], NO_MEDIA);
    expect(out).toContain("<ul><li>outer<ul><li>inner</li></ul></li></ul>");
  });
});
