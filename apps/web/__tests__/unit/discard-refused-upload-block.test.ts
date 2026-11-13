import { describe, expect, it } from "vitest";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { discardRefusedUploadBlock } from "@/components/editor/discard-refused-upload-block";

/**
 * Runs against a real (unmounted) BlockNote editor, so the document operations
 * are BlockNote's own: what matters is what's left in the note.
 */
function editorWith(blocks: PartialBlock[]): BlockNoteEditor {
  return BlockNoteEditor.create({ initialContent: blocks });
}

/** The document as type/text pairs, with nested children, for easy comparison. */
function outline(editor: BlockNoteEditor) {
  type Node = { type: string; text: string; children: Node[] };
  const walk = (blocks: BlockNoteEditor["document"]): Node[] =>
    blocks.map((block) => ({
      type: block.type,
      text: Array.isArray(block.content)
        ? block.content.map((part) => ("text" in part ? part.text : "")).join("")
        : "",
      children: walk(block.children),
    }));
  return walk(editor.document);
}

describe("discardRefusedUploadBlock", () => {
  it("removes the empty file block BlockNote inserted for the upload", () => {
    const editor = editorWith([
      { id: "before", type: "paragraph", content: "Before" },
      { id: "upload", type: "image", props: { name: "photo.png" } },
      { id: "after", type: "paragraph", content: "After" },
    ]);

    discardRefusedUploadBlock(editor, "upload");

    expect(editor.getBlock("upload")).toBeUndefined();
    expect(outline(editor).map((node) => node.text)).toEqual(["Before", "After"]);
  });

  it("removes an empty generic file block too", () => {
    const editor = editorWith([
      { id: "keep", type: "paragraph", content: "Keep" },
      { id: "upload", type: "file", props: { name: "report.pdf" } },
    ]);

    discardRefusedUploadBlock(editor, "upload");

    expect(editor.getBlock("upload")).toBeUndefined();
    expect(editor.getBlock("keep")).toBeDefined();
  });

  it("leaves an image that already has its file (Replace on an existing image)", () => {
    const editor = editorWith([
      { id: "existing", type: "image", props: { url: "attachment://u/n/photo.png" } },
    ]);
    const before = JSON.stringify(editor.document);

    discardRefusedUploadBlock(editor, "existing");

    expect(JSON.stringify(editor.document)).toBe(before);
    const block = editor.getBlock("existing");
    expect(block?.type).toBe("image");
    expect((block?.props as { url?: string }).url).toBe("attachment://u/n/photo.png");
  });

  it("keeps the nested children of a placeholder converted in place", () => {
    // BlockNote turns an empty block into the file block in place, and the
    // converted block keeps the children the empty block had.
    const editor = editorWith([
      {
        id: "parent",
        type: "bulletListItem",
        content: "",
        children: [
          { id: "milk", type: "bulletListItem", content: "milk" },
          { id: "eggs", type: "bulletListItem", content: "eggs" },
        ],
      },
    ]);
    editor.updateBlock("parent", { type: "image", props: { name: "photo.png" } });
    expect(editor.getBlock("parent")?.type).toBe("image");

    discardRefusedUploadBlock(editor, "parent");

    expect(outline(editor)).toEqual([
      {
        type: "paragraph",
        text: "",
        children: [
          { type: "bulletListItem", text: "milk", children: [] },
          { type: "bulletListItem", text: "eggs", children: [] },
        ],
      },
    ]);
    expect(editor.getBlock("milk")).toBeDefined();
    expect(editor.getBlock("eggs")).toBeDefined();
  });

  it("leaves a placeholder the user turned into text while it uploaded", () => {
    // The upload is async: by the time it is refused, the block may no longer be
    // a file block, and what the user typed in it must survive.
    const editor = editorWith([
      { id: "upload", type: "image", props: { name: "photo.png" } },
      { id: "after", type: "paragraph", content: "After" },
    ]);
    editor.updateBlock("upload", { type: "paragraph", content: "Typed meanwhile" });
    const before = JSON.stringify(editor.document);

    discardRefusedUploadBlock(editor, "upload");

    expect(JSON.stringify(editor.document)).toBe(before);
    expect(outline(editor).map((node) => node.text)).toEqual(["Typed meanwhile", "After"]);
  });

  it("leaves a placeholder turned into an empty block of another type", () => {
    const editor = editorWith([{ id: "upload", type: "image", props: { name: "photo.png" } }]);
    editor.updateBlock("upload", { type: "heading", content: [] });
    const before = JSON.stringify(editor.document);

    discardRefusedUploadBlock(editor, "upload");

    expect(JSON.stringify(editor.document)).toBe(before);
    expect(editor.getBlock("upload")?.type).toBe("heading");
  });

  it("does nothing when the block is already gone", () => {
    const editor = editorWith([{ id: "keep", type: "paragraph", content: "Keep" }]);
    const before = JSON.stringify(editor.document);

    expect(() => discardRefusedUploadBlock(editor, "missing")).not.toThrow();
    expect(JSON.stringify(editor.document)).toBe(before);
  });
});
