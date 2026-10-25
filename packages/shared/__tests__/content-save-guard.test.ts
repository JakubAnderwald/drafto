import { describe, expect, it, vi } from "vitest";

import {
  MAX_CONTENT_BASELINES,
  isNoOpContentSave,
  queueNoteWrite,
  rememberContentBaseline,
  sameStoredContent,
  serializeEditorContent,
  serializeLoadedDoc,
  type ContentBaseline,
} from "../src/editor/content-save-guard";
import { toAttachmentUrl } from "../src/editor/attachment-url";
import { contentToTiptap, tiptapToBlocknote } from "../src/editor/format-converter";
import { migrateSignedUrlsToAttachmentUrls } from "../src/editor/resolve-urls";
import type { BlockNoteBlock, TipTapDoc, TipTapNode } from "../src/editor/types";

import { jsonbReordered } from "./helpers/jsonb";

const SIGNED_URL =
  "https://example.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/photo.png?token=abc";

function textDoc(text: string): TipTapDoc {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
      { type: "paragraph", content: [{ type: "text", text, marks: [{ type: "bold" }] }] },
    ],
  };
}

describe("serializeEditorContent", () => {
  it("is deterministic for equal documents built independently", () => {
    expect(serializeEditorContent(textDoc("hello"))).toBe(serializeEditorContent(textDoc("hello")));
  });

  it("distinguishes documents that differ", () => {
    expect(serializeEditorContent(textDoc("hello"))).not.toBe(
      serializeEditorContent(textDoc("hello!")),
    );
  });

  it("matches the BlockNote + attachment-URL pipeline the save path has always used", () => {
    const doc = textDoc("hello");
    expect(serializeEditorContent(doc)).toBe(
      JSON.stringify(migrateSignedUrlsToAttachmentUrls(tiptapToBlocknote(doc))),
    );
  });

  it("rewrites signed image URLs to attachment:// so expiring tokens never persist", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [{ type: "image", attrs: { src: SIGNED_URL, alt: "photo.png" } }],
    };
    const serialized = serializeEditorContent(doc);
    expect(serialized).toContain(toAttachmentUrl("user-1/note-1/photo.png"));
    expect(serialized).not.toContain("token=abc");
  });

  it("rewrites signed link hrefs to attachment://", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "photo.png",
              marks: [{ type: "link", attrs: { href: SIGNED_URL } }],
            },
          ],
        },
      ],
    };
    const serialized = serializeEditorContent(doc);
    expect(serialized).toContain(toAttachmentUrl("user-1/note-1/photo.png"));
    expect(serialized).not.toContain("token=abc");
  });
});

describe("serializeLoadedDoc", () => {
  it("serialises an empty doc as the one empty paragraph ProseMirror fills it with", () => {
    expect(serializeLoadedDoc({ type: "doc", content: [] })).toBe(
      serializeEditorContent({ type: "doc", content: [{ type: "paragraph" }] }),
    );
  });

  it("serialises any other doc exactly like serializeEditorContent", () => {
    expect(serializeLoadedDoc(textDoc("hello"))).toBe(serializeEditorContent(textDoc("hello")));
  });
});

describe("sameStoredContent", () => {
  const content = serializeEditorContent(textDoc("hello"));

  it("treats JSON that differs only in object key order as the same content", () => {
    const pulled = jsonbReordered(content);
    expect(pulled).not.toBe(content); // precondition: the bytes really differ
    expect(sameStoredContent(content, pulled)).toBe(true);
  });

  it("distinguishes JSON with different values or array order", () => {
    expect(sameStoredContent(content, serializeEditorContent(textDoc("hello!")))).toBe(false);
    expect(sameStoredContent('[{"type":"a"},{"type":"b"}]', '[{"type":"b"},{"type":"a"}]')).toBe(
      false,
    );
    expect(sameStoredContent('{"a":1}', '{"a":1,"b":2}')).toBe(false);
    expect(sameStoredContent('{"a":1,"b":2}', '{"a":1}')).toBe(false);
    expect(sameStoredContent('{"a":[1]}', '{"a":{"0":1}}')).toBe(false);
    expect(sameStoredContent('{"a":null}', '{"a":{}}')).toBe(false);
  });

  it("requires plain text that is not JSON to match exactly", () => {
    expect(sameStoredContent("first line", "first line")).toBe(true);
    expect(sameStoredContent("first line", "first line ")).toBe(false);
    expect(sameStoredContent("not json", content)).toBe(false);
  });

  it("treats a missing value as null and never equal to stored text", () => {
    expect(sameStoredContent(null, undefined)).toBe(true);
    expect(sameStoredContent(null, "")).toBe(false);
    expect(sameStoredContent(undefined, "[]")).toBe(false);
    expect(sameStoredContent("[]", null)).toBe(false);
  });
});

describe("isNoOpContentSave", () => {
  const content = serializeEditorContent(textDoc("hello"));
  const edited = serializeEditorContent(textDoc("hello world"));
  const STORED = "stored-in-another-form";
  const baselineFor = (noteId: string, stored: string | null = STORED) =>
    new Map<string, ContentBaseline>([[noteId, { stored, serializations: [content] }]]);

  it("is true when the payload equals the baseline of the unchanged stored row", () => {
    expect(isNoOpContentSave(baselineFor("note-1"), { noteId: "note-1", content }, STORED)).toBe(
      true,
    );
  });

  it("is true when the payload equals the stored content exactly", () => {
    expect(isNoOpContentSave(new Map(), { noteId: "note-1", content }, content)).toBe(true);
  });

  it("is false when the content differs from both the baseline and the stored content", () => {
    expect(
      isNoOpContentSave(baselineFor("note-1"), { noteId: "note-1", content: edited }, STORED),
    ).toBe(false);
  });

  it("ignores a baseline belonging to a different note", () => {
    expect(isNoOpContentSave(baselineFor("note-2"), { noteId: "note-1", content }, STORED)).toBe(
      false,
    );
  });

  it("ignores a baseline once the stored row has changed underneath it (e.g. a sync pull)", () => {
    expect(
      isNoOpContentSave(baselineFor("note-1"), { noteId: "note-1", content }, "synced-from-phone"),
    ).toBe(false);
  });

  it("treats a missing stored value as null when matching a baseline", () => {
    const baselines = baselineFor("note-1", null);
    expect(isNoOpContentSave(baselines, { noteId: "note-1", content }, null)).toBe(true);
    expect(isNoOpContentSave(baselines, { noteId: "note-1", content }, undefined)).toBe(true);
    expect(isNoOpContentSave(baselines, { noteId: "note-1", content }, "")).toBe(false);
  });

  it("is false for a real save when nothing is stored yet", () => {
    expect(isNoOpContentSave(new Map(), { noteId: "note-1", content }, null)).toBe(false);
    expect(isNoOpContentSave(new Map(), { noteId: "note-1", content }, undefined)).toBe(false);
  });

  it("is true when a sync pull handed the saved content back with jsonb's key order", () => {
    expect(
      isNoOpContentSave(new Map(), { noteId: "note-1", content }, jsonbReordered(content)),
    ).toBe(true);
  });

  it("keeps a baseline when the stored row only came back re-serialised by a sync pull", () => {
    const stored = serializeEditorContent(textDoc("loaded"));
    const baselines = new Map<string, ContentBaseline>([
      ["note-1", { stored, serializations: [content] }],
    ]);
    expect(
      isNoOpContentSave(baselines, { noteId: "note-1", content }, jsonbReordered(stored)),
    ).toBe(true);
  });

  it("matches any of the baseline's serialisations, in any key order", () => {
    const baselines = new Map<string, ContentBaseline>([
      ["note-1", { stored: STORED, serializations: [edited, jsonbReordered(content)] }],
    ]);
    expect(isNoOpContentSave(baselines, { noteId: "note-1", content }, STORED)).toBe(true);
    expect(isNoOpContentSave(baselines, { noteId: "note-1", content: edited }, STORED)).toBe(true);
    expect(
      isNoOpContentSave(
        baselines,
        { noteId: "note-1", content: serializeEditorContent(textDoc("other")) },
        STORED,
      ),
    ).toBe(false);
  });

  it("is false for a baseline with no serialisations", () => {
    const baselines = new Map<string, ContentBaseline>([
      ["note-1", { stored: STORED, serializations: [] }],
    ]);
    expect(isNoOpContentSave(baselines, { noteId: "note-1", content }, STORED)).toBe(false);
  });
});

describe("a web note with nested content", () => {
  const text = (value: string) => ({ type: "text" as const, text: value, styles: {} });
  // Shaped like the web editor stores it: block ids and default props everywhere.
  const webBlock = (
    id: string,
    type: string,
    value: string,
    children: BlockNoteBlock[] = [],
    props: Record<string, unknown> = {},
  ): BlockNoteBlock => ({
    id,
    type,
    props: { textColor: "default", backgroundColor: "default", textAlignment: "left", ...props },
    content: [text(value)],
    children,
  });
  // A nested check list, and a paragraph with a child, which TipTap can only
  // show as the paragraph's next sibling.
  const STORED = JSON.stringify([
    webBlock(
      "a",
      "checkListItem",
      "a",
      [
        webBlock(
          "b",
          "checkListItem",
          "b",
          [webBlock("c", "checkListItem", "c", [], { checked: false })],
          {
            checked: true,
          },
        ),
      ],
      { checked: false },
    ),
    webBlock("p", "paragraph", "intro", [webBlock("q", "bulletListItem", "point")]),
  ]);

  // What the editor panel does on load: the converter's serialisation goes into
  // the baseline before setContent, and the editor's read-back after it.
  function openNote() {
    const doc = contentToTiptap(JSON.parse(STORED));
    const readBack = JSON.parse(JSON.stringify(doc)) as TipTapDoc;
    const baselines = new Map<string, ContentBaseline>([
      [
        "note-1",
        {
          stored: STORED,
          serializations: [serializeLoadedDoc(doc), serializeEditorContent(readBack)],
        },
      ],
    ]);
    return { doc, baselines };
  }

  function findText(nodes: TipTapNode[] | undefined, value: string): TipTapNode | undefined {
    for (const node of nodes ?? []) {
      if (node.type === "text" && node.text === value) return node;
      const found = findText(node.content, value);
      if (found) return found;
    }
    return undefined;
  }

  it("writes nothing when the note is opened and its load echo saved", () => {
    const { doc, baselines } = openNote();
    const content = serializeEditorContent(doc);
    // The echo differs from the stored row (ids, default props, the flattened
    // paragraph child), so only the baseline keeps it from being written.
    expect(sameStoredContent(content, STORED)).toBe(false);
    expect(isNoOpContentSave(baselines, { noteId: "note-1", content }, STORED)).toBe(true);
    expect(
      isNoOpContentSave(baselines, { noteId: "note-1", content }, jsonbReordered(STORED)),
    ).toBe(true);
  });

  it("keeps the nested check items and their checked states through a real edit", () => {
    const { doc, baselines } = openNote();
    const deepest = findText(doc.content, "c");
    expect(deepest).toBeDefined();
    if (deepest) deepest.text = "c edited";
    const content = serializeEditorContent(doc);

    expect(isNoOpContentSave(baselines, { noteId: "note-1", content }, STORED)).toBe(false);
    const check = (value: string, checked: boolean, children: BlockNoteBlock[] = []) => ({
      type: "checkListItem",
      content: [text(value)],
      children,
      props: { checked },
    });
    expect(JSON.parse(content)).toEqual([
      check("a", false, [check("b", true, [check("c edited", false)])]),
      { type: "paragraph", content: [text("intro")], children: [] },
      { type: "bulletListItem", content: [text("point")], children: [] },
    ]);
  });
});

describe("rememberContentBaseline", () => {
  const baseline = (serialized: string): ContentBaseline => ({
    stored: null,
    serializations: [serialized],
  });

  it("records and overwrites a note's baseline", () => {
    const baselines = new Map<string, ContentBaseline>();
    rememberContentBaseline(baselines, "note-1", baseline("a"));
    rememberContentBaseline(baselines, "note-1", baseline("b"));
    expect(baselines.get("note-1")).toEqual(baseline("b"));
    expect(baselines.size).toBe(1);
  });

  it("evicts the least recently recorded notes beyond the limit", () => {
    const baselines = new Map<string, ContentBaseline>();
    rememberContentBaseline(baselines, "a", baseline("1"), 2);
    rememberContentBaseline(baselines, "b", baseline("2"), 2);
    rememberContentBaseline(baselines, "a", baseline("3"), 2); // refreshes "a" to newest
    rememberContentBaseline(baselines, "c", baseline("4"), 2);
    expect([...baselines.keys()]).toEqual(["a", "c"]);
    expect(baselines.get("a")).toEqual(baseline("3"));
  });

  it("caps the map at MAX_CONTENT_BASELINES by default", () => {
    const baselines = new Map<string, ContentBaseline>();
    for (let i = 0; i < MAX_CONTENT_BASELINES + 5; i++) {
      rememberContentBaseline(baselines, `note-${i}`, baseline(`content-${i}`));
    }
    expect(baselines.size).toBe(MAX_CONTENT_BASELINES);
    expect(baselines.has("note-0")).toBe(false);
    expect(baselines.has(`note-${MAX_CONTENT_BASELINES + 4}`)).toBe(true);
  });
});

describe("queueNoteWrite", () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("runs a note's writes one at a time, in order", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const first = deferred();
    const events: string[] = [];

    const a = queueNoteWrite(queues, "note-1", async () => {
      events.push("first:start");
      await first.promise;
      events.push("first:end");
    });
    const b = queueNoteWrite(queues, "note-1", async () => {
      events.push("second");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("does not hold one note's write behind another note's", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const blocked = deferred();
    const ran: string[] = [];

    void queueNoteWrite(queues, "note-1", () => blocked.promise);
    await queueNoteWrite(queues, "note-2", async () => {
      ran.push("note-2");
    });

    expect(ran).toEqual(["note-2"]);
    blocked.resolve();
  });

  it("keeps the queue moving after a failed write and reports the failure to its caller", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const failing = queueNoteWrite(queues, "note-1", async () => {
      throw new Error("write failed");
    });
    const next = vi.fn(async () => {});
    const following = queueNoteWrite(queues, "note-1", next);

    await expect(failing).rejects.toThrow("write failed");
    await following;
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("hands each task's result back to its own caller", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const skipped = queueNoteWrite(queues, "note-1", async () => false);
    const written = queueNoteWrite(queues, "note-1", async () => true);

    await expect(skipped).resolves.toBe(false);
    await expect(written).resolves.toBe(true);
  });

  it("forgets a note once its queue has drained", async () => {
    const queues = new Map<string, Promise<unknown>>();
    await queueNoteWrite(queues, "note-1", async () => {});
    await Promise.resolve();
    expect(queues.has("note-1")).toBe(false);
  });
});
