import { describe, it, expect } from "vitest";
import { getSchema, type AnyExtension } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { blocknoteToTiptap, markdownToBlockNote, tiptapToBlocknote } from "../src";
import type { BlockNoteBlock, BlockNoteInlineContent, TipTapDoc } from "../src";

// StarterKit 3.20.1 depends on `@tiptap/core ^3.20.1`, so it brings its own
// copy (3.31.3) instead of the 3.20.0 the other extensions share. The extension
// objects work across both at runtime, but TypeScript sees unrelated types.
const starterKit = StarterKit.configure({
  codeBlock: false,
  horizontalRule: false,
}) as unknown as AnyExtension;

/**
 * A headless stand-in for the editor mobile and desktop run. Both load tentap
 * 1.0.1's prebuilt WebView bundle
 * (`@10play/tentap-editor/lib/commonjs/simpleWebEditor/build/editorHtml.js`);
 * neither passes `customSource`. Facts read from that bundle, which this
 * schema mirrors:
 * - Its nodes are doc, paragraph, text, heading, blockquote, hardBreak,
 *   bulletList, orderedList, listItem, taskList, taskItem and image. That is
 *   StarterKit without `codeBlock` and `horizontalRule`, plus TaskList, TaskItem
 *   and Image. There is no `codeBlock`, `table`, `tableRow` or `tableCell` node.
 * - `listItem` is `paragraph block*`. TaskListBridge registers
 *   `TaskItem.configure({ nested: true })`, so `taskItem` is `paragraph block*` too.
 * - When `nodeFromJSON` throws on the content it is given, the bundle's
 *   `createNodeFromContent` logs `[tiptap warn]: Invalid content.` and loads an
 *   empty document: one unknown node blanks the whole note.
 * - `editor.getJSON()`, which both apps save through `tiptapToBlocknote`, is
 *   ProseMirror's `doc.toJSON()`.
 */
const schema = getSchema([starterKit, TaskList, TaskItem.configure({ nested: true }), Image]);

const text = (value: string, styles: Record<string, boolean> = {}) => ({
  type: "text" as const,
  text: value,
  styles,
});
const block = (
  type: string,
  value: string,
  children: BlockNoteBlock[] = [],
  props?: Record<string, unknown>,
): BlockNoteBlock => ({
  type,
  ...(props ? { props } : {}),
  content: value ? [text(value)] : [],
  children,
});
const check = (value: string, checked: boolean, children: BlockNoteBlock[] = []) =>
  block("checkListItem", value, children, { checked });
const file = (name: string): BlockNoteBlock => ({
  type: "file",
  props: { url: `attachment://user-1/note-1/${name}`, name },
  children: [],
});
const code = (value: string, language: string): BlockNoteBlock => ({
  type: "codeBlock",
  props: { language },
  content: [text(value)],
  children: [],
});
const table = (rows: string[][]): BlockNoteBlock => ({
  type: "table",
  content: {
    type: "tableContent",
    rows: rows.map((cells) => ({ cells: cells.map((cell) => [text(cell)]) })),
  },
  children: [],
});

/** Load blocks the way the native editor does: the converter's JSON through the bundle's schema. */
function load(blocks: BlockNoteBlock[]): ProseMirrorNode {
  const doc = schema.nodeFromJSON(blocknoteToTiptap(blocks));
  doc.check();
  return doc;
}

/** Read the editor back the way both apps save it. */
function readBack(doc: ProseMirrorNode): BlockNoteBlock[] {
  return tiptapToBlocknote(doc.toJSON() as TipTapDoc);
}

interface Outline {
  type: string;
  text: string;
  checked?: boolean;
  children: Outline[];
}

function inlineText(content: BlockNoteInlineContent[]): string {
  return content.map((item) => item.text ?? inlineText(item.content ?? [])).join("");
}

// Block types, text, checked states and nesting: what a reader of the note sees.
function outline(blocks: BlockNoteBlock[]): Outline[] {
  return blocks.map((b) => ({
    type: b.type,
    text:
      b.type === "file"
        ? String(b.props?.name ?? "")
        : Array.isArray(b.content)
          ? inlineText(b.content)
          : "",
    ...(b.type === "checkListItem" ? { checked: Boolean(b.props?.checked) } : {}),
    children: outline(b.children ?? []),
  }));
}

const MARKER = " (edited)";

interface Fixture {
  name: string;
  blocks: BlockNoteBlock[];
  /** What the editor reads back when TipTap flattens or projects part of the note. */
  expected?: BlockNoteBlock[];
  /** Text of the deepest item, which the edit types into. */
  edit: string;
  /** Text of a nested check item the edit ticks or unticks. */
  toggle?: string;
}

const fixtures: Fixture[] = [
  {
    name: "check lists nested three deep with mixed checked states",
    blocks: [
      check("a", false, [check("b", true, [check("c", false)]), check("b2", false)]),
      check("d", true),
    ],
    edit: "c",
    toggle: "b",
  },
  {
    name: "a bullet item with check children",
    blocks: [
      block("bulletListItem", "list", [
        check("x", true),
        check("y", false, [block("bulletListItem", "deep")]),
      ]),
    ],
    edit: "deep",
    toggle: "y",
  },
  {
    name: "a check item with bullet children",
    blocks: [check("todo", false, [block("bulletListItem", "note", [check("sub", true)])])],
    edit: "sub",
    toggle: "sub",
  },
  {
    name: "a numbered item whose children mix check, bullet, paragraph, heading and file blocks",
    blocks: [
      block("numberedListItem", "step", [
        check("c1", false),
        block("bulletListItem", "b1"),
        block("paragraph", "p1"),
        block("heading", "h1", [], { level: 3 }),
        file("report.pdf"),
        check("c2", true, [check("c3", false)]),
      ]),
    ],
    edit: "c3",
    toggle: "c2",
  },
  {
    name: "a paragraph and a heading with children",
    blocks: [
      block("paragraph", "p", [block("paragraph", "p1"), check("p2", false)]),
      block("heading", "h", [block("bulletListItem", "h1")], { level: 2 }),
    ],
    expected: [
      block("paragraph", "p"),
      block("paragraph", "p1"),
      check("p2", false),
      block("heading", "h", [], { level: 2 }),
      block("bulletListItem", "h1"),
    ],
    edit: "h1",
  },
  {
    name: "a paragraph with children inside a list item",
    blocks: [block("bulletListItem", "a", [block("paragraph", "p", [check("q", true)])])],
    expected: [block("bulletListItem", "a", [block("paragraph", "p"), check("q", true)])],
    edit: "q",
    toggle: "q",
  },
  {
    name: "a list item with a code block child and a table child",
    blocks: [
      block("bulletListItem", "a", [
        code("npm install\nnpm test", "bash"),
        table([
          ["h", "i"],
          ["1", "2"],
        ]),
        check("after", false),
      ]),
    ],
    expected: [
      block("bulletListItem", "a", [
        block("paragraph", "npm install\nnpm test"),
        block("paragraph", ""),
        check("after", false),
      ]),
    ],
    edit: "after",
    toggle: "after",
  },
  {
    name: "Markdown with a fenced block indented under a list item and a nested to-do list",
    blocks: markdownToBlockNote(
      [
        "1. Install",
        "   ```bash",
        "   npm install",
        "   ```",
        "2. Check",
        "   - [ ] a",
        "     - [x] b",
        "       - [ ] c",
      ].join("\n"),
    ),
    expected: [
      block("numberedListItem", "Install", [block("paragraph", "npm install")]),
      block("numberedListItem", "Check", [
        check("a", false, [check("b", true, [check("c", false)])]),
      ]),
    ],
    edit: "c",
    toggle: "b",
  },
  {
    name: "inline content with empty text nodes",
    blocks: [
      {
        type: "paragraph",
        content: [text(""), { type: "link", href: "https://x.test", content: [] }, text("x")],
        children: [],
      },
      { type: "file", props: { url: "", name: "" }, children: [] },
    ],
    expected: [block("paragraph", "x"), block("paragraph", "")],
    edit: "x",
  },
];

// The position of the check item whose own text is `value`.
function findCheckItem(doc: ProseMirrorNode, value: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === "taskItem" && node.firstChild?.textContent === value) {
      found = pos;
    }
    return found === -1;
  });
  return found;
}

/**
 * The edit a user makes in the WebView, as one ProseMirror transaction: tick or
 * untick a nested check item, then type at the end of the deepest item's text.
 */
function applyEdit(doc: ProseMirrorNode, fixture: Fixture): ProseMirrorNode {
  const state = EditorState.create({ schema, doc });
  const tr = state.tr;

  if (fixture.toggle !== undefined) {
    const pos = findCheckItem(tr.doc, fixture.toggle);
    expect(pos).toBeGreaterThan(-1);
    expect(tr.doc.resolve(pos).depth).toBeGreaterThan(1); // nested, not a top-level item
    const item = tr.doc.nodeAt(pos);
    tr.setNodeMarkup(pos, undefined, { ...item?.attrs, checked: !item?.attrs.checked });
  }

  let at = -1;
  let atDepth = -1;
  let deepest = -1;
  tr.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const depth = tr.doc.resolve(pos).depth;
    deepest = Math.max(deepest, depth);
    if (at === -1 && node.textContent === fixture.edit) {
      at = pos + node.nodeSize - 1;
      atDepth = depth;
    }
    return false;
  });
  expect(at).toBeGreaterThan(-1);
  expect(atDepth).toBe(deepest);
  tr.insertText(MARKER, at);

  return state.apply(tr).doc;
}

function editedOutline(blocks: Outline[], fixture: Fixture): Outline[] {
  return blocks.map((b) => ({
    ...b,
    text: b.text === fixture.edit ? b.text + MARKER : b.text,
    ...(b.type === "checkListItem" && b.text === fixture.toggle ? { checked: !b.checked } : {}),
    children: editedOutline(b.children, fixture),
  }));
}

describe("native editor schema", () => {
  it("mirrors the bundle: list items hold nested blocks, and there is no code block or table", () => {
    expect(schema.nodes.listItem.spec.content).toBe("paragraph block*");
    expect(schema.nodes.taskItem.spec.content).toBe("paragraph block*");
    expect(schema.nodes.codeBlock).toBeUndefined();
    expect(schema.nodes.table).toBeUndefined();
    expect(() => schema.nodeFromJSON({ type: "doc", content: [{ type: "codeBlock" }] })).toThrow();
  });

  it.each(fixtures)("loads $name without an unknown or invalid node", (fixture) => {
    expect(() => load(fixture.blocks)).not.toThrow();
  });

  it.each(fixtures)(
    "reads $name back with its block types, text, checked states and nesting",
    (fixture) => {
      const readBlocks = readBack(load(fixture.blocks));
      expect(outline(readBlocks)).toEqual(outline(fixture.expected ?? fixture.blocks));
      // Nothing to flatten or project: the note comes back exactly as stored.
      if (!fixture.expected) expect(readBlocks).toEqual(fixture.blocks);
    },
  );

  it.each(fixtures)("keeps every nested item of $name through an edit", (fixture) => {
    const edited = applyEdit(load(fixture.blocks), fixture);
    expect(() => edited.check()).not.toThrow();
    expect(outline(readBack(edited))).toEqual(
      editedOutline(outline(fixture.expected ?? fixture.blocks), fixture),
    );
  });

  it("reads back a note it loaded without editing as the same blocks every time", () => {
    for (const fixture of fixtures) {
      const once = readBack(load(fixture.blocks));
      expect(readBack(load(once))).toEqual(once);
    }
  });
});
