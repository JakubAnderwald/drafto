import React from "react";
import { useEditorBridge } from "@10play/tentap-editor";
import {
  DEBOUNCE_MS,
  contentToTiptap,
  toAttachmentUrl,
  type TipTapDoc,
  type TipTapNode,
} from "@drafto/shared";

import { render, fireEvent, act } from "../../helpers/test-utils";
import { NoteEditorPanel } from "@/components/notes/note-editor-panel";
import { serializeEditorContent } from "@/components/notes/content-save-guard";
import { useNote } from "@/hooks/use-note";
import type { Attachment, Note } from "@/db";

// Integration coverage for issue #654: opening a note on macOS must not write
// it (WatermelonDB bumps updated_at on every update, which re-sorts the list
// and syncs a phantom "modification" to every device), while real edits keep
// saving. The tentap WebView is replaced by a fake that mirrors the bridge
// contract the panel relies on: setContent() makes the web editor normalise the
// document the way ProseMirror does and post a content-update echo, which
// reaches React Native before the reply to any getJSON() sent after it (one
// FIFO postMessage channel). WatermelonDB's writer is modelled as a FIFO queue
// that another writer (a sync) can hold.

type FakeRecord = {
  id: string;
  title: string;
  content: string | null;
  createdAt: Date;
  updatedAt: Date;
  update: jest.Mock<Promise<void>, [(record: FakeRecord) => void]>;
};

const mockRecords = new Map<string, FakeRecord>();
const mockWriteQueue: { tail: Promise<unknown> } = { tail: Promise.resolve() };
const mockAttachmentPicker: { onAttachmentReady?: (attachment: Attachment) => void } = {};

jest.mock("@/db", () => ({
  database: {
    get: () => ({
      find: async (id: string) => {
        const record = mockRecords.get(id);
        if (!record) throw new Error(`no record ${id}`);
        return record;
      },
    }),
    write: (work: () => Promise<void>) => {
      const run = mockWriteQueue.tail.then(work);
      mockWriteQueue.tail = run.catch(() => undefined);
      return run;
    },
  },
  Note: class {},
}));

jest.mock("@/hooks/use-note", () => ({ useNote: jest.fn() }));

jest.mock("@/lib/data", () => ({
  getSignedUrl: jest.fn(async (filePath: string) => `https://signed.example/${filePath}`),
}));

jest.mock("@/components/editor/note-editor", () => ({ NoteEditor: () => null }));

jest.mock("@/components/editor/attachment-picker", () => ({
  AttachmentPicker: (props: { onAttachmentReady?: (attachment: Attachment) => void }) => {
    mockAttachmentPicker.onAttachmentReady = props.onAttachmentReady;
    return null;
  },
}));

const mockedUseNote = jest.mocked(useNote);
const mockedUseEditorBridge = jest.mocked(useEditorBridge);

/** Another writer (e.g. a sync) holds WatermelonDB's write queue until released. */
function holdWriteQueue(): () => void {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockWriteQueue.tail = mockWriteQueue.tail.then(() => held);
  return release;
}

// --- Fake tentap WebView ------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const EMPTY_EDITOR_DOC: TipTapDoc = { type: "doc", content: [{ type: "paragraph" }] };

// ProseMirror keeps a node's marks sorted by schema rank, whatever order they
// were given in, so the editor's read-back can differ from what was set.
const MARK_RANK = ["bold", "italic", "underline", "strike", "code", "link"];

function normaliseNode(node: TipTapNode): TipTapNode {
  const next: TipTapNode = { ...node };
  if (next.marks) {
    next.marks = [...next.marks].sort(
      (a, b) => MARK_RANK.indexOf(a.type) - MARK_RANK.indexOf(b.type),
    );
  }
  if (next.content) next.content = next.content.map(normaliseNode);
  return next;
}

/** What the web editor holds after setContent(content) — the shape getJSON returns. */
function webEditorParse(content: unknown): TipTapDoc {
  if (typeof content === "string") {
    const paragraphs = [...content.matchAll(/<p>(.*?)<\/p>/g)].map(([, inner]) =>
      inner === "<br>"
        ? { type: "paragraph" }
        : { type: "paragraph", content: [{ type: "text", text: inner }] },
    );
    return paragraphs.length > 0 ? { type: "doc", content: paragraphs } : clone(EMPTY_EDITOR_DOC);
  }
  const doc = clone(content as TipTapDoc);
  // A doc must hold at least one block; ProseMirror fills an empty one.
  if (doc.content.length === 0) return clone(EMPTY_EDITOR_DOC);
  return { ...doc, content: doc.content.map(normaliseNode) };
}

function createFakeWebEditor() {
  let doc = clone(EMPTY_EDITOR_DOC);
  let onChange: (() => void) | undefined;
  let getJSONImpl: () => Promise<object> = async () => clone(doc);

  const emitChange = () => onChange?.();
  const bridge = {
    getEditorState: () => ({ isReady: true }),
    _subscribeToEditorStateUpdate: () => () => {},
    webviewRef: { current: { injectJavaScript: jest.fn() } },
    setContent: jest.fn((content: unknown) => {
      doc = webEditorParse(content);
      // The web editor answers setContent with a content-update. It is posted
      // before the reply to any later getJSON, so it is delivered first. A
      // native promise keeps that order (jest's fake timers would defer a
      // queueMicrotask until the clock is advanced).
      void Promise.resolve().then(emitChange);
    }),
    getJSON: jest.fn(() => getJSONImpl()),
  };

  mockedUseEditorBridge.mockImplementation((options) => {
    onChange = options?.onChange;
    return bridge as unknown as ReturnType<typeof useEditorBridge>;
  });

  const overrideNextGetJSON = (impl: () => Promise<object>) => {
    const original = getJSONImpl;
    getJSONImpl = () => {
      getJSONImpl = original;
      return impl();
    };
  };

  return {
    bridge,
    /** A content-update from the WebView with no user edit (e.g. a late load echo). */
    emitChange,
    /** The user edits the document in the WebView, which then posts a content-update. */
    userEdit(next: TipTapDoc) {
      doc = clone(next);
      emitChange();
    },
    currentDoc: () => clone(doc),
    failNextGetJSON: () =>
      overrideNextGetJSON(async () => {
        throw new Error("bridge unavailable");
      }),
    /** tentap's getJSON never rejects; a lost reply leaves it pending forever. */
    hangNextGetJSON: () => overrideNextGetJSON(() => new Promise<object>(() => {})),
    /** The next read-back answers with something that is not a TipTap doc. */
    malformNextGetJSON: () => overrideNextGetJSON(async () => ({ type: "doc" })),
  };
}

// --- Fixtures -----------------------------------------------------------------

function createRecord(id: string, title: string, content: string | null): FakeRecord {
  const record: FakeRecord = {
    id,
    title,
    content,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    update: jest.fn(async (builder: (r: FakeRecord) => void) => {
      builder(record);
      record.updatedAt = new Date();
    }),
  };
  mockRecords.set(id, record);
  return record;
}

// Web-authored BlockNote content: block ids and default props mean the stored
// bytes never equal what the desktop editor re-serialises the same note to,
// and the mark order (italic before bold) is one ProseMirror re-sorts on load.
function webAuthoredContent(text: string): string {
  return JSON.stringify([
    {
      id: "block-1",
      type: "heading",
      props: { level: 2, textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [{ type: "text", text: "Welcome to Drafto", styles: {} }],
      children: [],
    },
    {
      id: "block-2",
      type: "paragraph",
      props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [{ type: "text", text, styles: { italic: true, bold: true } }],
      children: [],
    },
  ]);
}

function withParagraph(doc: TipTapDoc, text: string): TipTapDoc {
  return {
    ...doc,
    content: [...doc.content, { type: "paragraph", content: [{ type: "text", text }] }],
  };
}

async function flushAsync(ms = 0) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function renderPanel(noteId: string | undefined) {
  mockedUseNote.mockImplementation((id) => ({
    note: id ? ((mockRecords.get(id) ?? null) as unknown as Note | null) : null,
    loading: false,
    error: null,
  }));
  return render(<NoteEditorPanel noteId={noteId} />);
}

const writes = (record: FakeRecord) => record.update.mock.calls.length;

// --- Tests --------------------------------------------------------------------

describe("NoteEditorPanel — no writes from merely opening a note (#654)", () => {
  let web: ReturnType<typeof createFakeWebEditor>;

  beforeEach(() => {
    jest.useFakeTimers();
    mockRecords.clear();
    mockWriteQueue.tail = Promise.resolve();
    mockAttachmentPicker.onAttachmentReady = undefined;
    web = createFakeWebEditor();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("drops the load's own content-update at the still-closed gate", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));

    renderPanel("a");
    await flushAsync(DEBOUNCE_MS * 2);

    expect(web.bridge.setContent).toHaveBeenCalledTimes(1);
    // Only the baseline read-back ran: the echo arrived before the gate opened,
    // so it never reached the save path (which would have called getJSON again).
    expect(web.bridge.getJSON).toHaveBeenCalledTimes(1);
    expect(writes(note)).toBe(0);
  });

  it("does not write a web-authored note when a late load echo arrives after the gate opened", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    const asSet = contentToTiptap(JSON.parse(note.content!));

    renderPanel("a");
    await flushAsync();
    // Preconditions: neither the stored bytes nor the doc that was set equal the
    // editor's read-back, so only a baseline read back from the editor works.
    const readBack = serializeEditorContent(web.currentDoc());
    expect(readBack).not.toBe(note.content);
    expect(readBack).not.toBe(serializeEditorContent(asSet));

    web.emitChange();
    await flushAsync(DEBOUNCE_MS * 2);

    expect(writes(note)).toBe(0);
    expect(note.content).toBe(webAuthoredContent("Hello"));
  });

  it("does not write an empty TipTap doc, a legacy plain-text note or an empty note when opened", async () => {
    const tiptapEmpty = createRecord(
      "tiptap",
      "TipTap",
      JSON.stringify({ type: "doc", content: [] }),
    );
    const plain = createRecord("plain", "Plain", "first line\nsecond line");
    const empty = createRecord("empty", "Empty", "[]");

    const { rerender } = renderPanel("tiptap");
    for (const id of ["tiptap", "plain", "empty"]) {
      rerender(<NoteEditorPanel noteId={id} />);
      await flushAsync();
      web.emitChange();
      await flushAsync(DEBOUNCE_MS * 2);
    }

    expect(writes(tiptapEmpty)).toBe(0);
    expect(writes(plain)).toBe(0);
    expect(writes(empty)).toBe(0);
  });

  it("still saves a genuine edit after the debounce, with the edited content", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    renderPanel("a");
    await flushAsync();
    web.emitChange();
    await flushAsync(DEBOUNCE_MS * 2);

    const edited = withParagraph(web.currentDoc(), "typed by the user");
    web.userEdit(edited);
    await flushAsync(DEBOUNCE_MS - 1);
    expect(writes(note)).toBe(0); // still debouncing

    await flushAsync(1);
    expect(writes(note)).toBe(1);
    expect(note.content).toBe(serializeEditorContent(edited));
  });

  it("switching notes without editing writes neither note", async () => {
    const a = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    const b = createRecord("b", "Meeting notes", webAuthoredContent("Agenda"));

    const { rerender } = renderPanel("a");
    await flushAsync();
    web.emitChange(); // A's late echo is pending in the debounce...
    await flushAsync();

    rerender(<NoteEditorPanel noteId="b" />); // ...and is flushed by the switch
    await flushAsync();
    web.emitChange();
    await flushAsync(DEBOUNCE_MS * 2);

    expect(writes(a)).toBe(0);
    expect(writes(b)).toBe(0);
  });

  it("an edit reverted before the debounce fires writes nothing", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    renderPanel("a");
    await flushAsync();

    const original = web.currentDoc();
    web.userEdit(withParagraph(original, "oops"));
    await flushAsync(DEBOUNCE_MS / 2);
    web.userEdit(original);
    await flushAsync(DEBOUNCE_MS * 2);

    expect(writes(note)).toBe(0);
  });

  it("reverting after an edit has saved is a real change and writes again", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    renderPanel("a");
    await flushAsync();

    const original = web.currentDoc();
    web.userEdit(withParagraph(original, "added"));
    await flushAsync(DEBOUNCE_MS);
    expect(writes(note)).toBe(1);

    web.userEdit(original);
    await flushAsync(DEBOUNCE_MS);
    expect(writes(note)).toBe(2);
    expect(note.content).toBe(serializeEditorContent(original));
  });

  it("a revert is not mistaken for a no-op while the edit's write is still queued", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    renderPanel("a");
    await flushAsync();
    const original = web.currentDoc();

    const release = holdWriteQueue(); // e.g. a sync applying remote changes
    web.userEdit(withParagraph(original, "typed"));
    await flushAsync(DEBOUNCE_MS); // the edit's save runs; its write waits in the queue
    web.userEdit(original);
    await flushAsync(DEBOUNCE_MS); // the revert's save runs before that write commits

    await act(async () => {
      release();
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(note.content).toBe(serializeEditorContent(original));
  });

  it("a revert flushed by a note switch while the edit's write is queued still persists", async () => {
    const a = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    const b = createRecord("b", "Meeting notes", webAuthoredContent("Agenda"));
    const { rerender } = renderPanel("a");
    await flushAsync();
    const original = web.currentDoc();

    const release = holdWriteQueue();
    web.userEdit(withParagraph(original, "typed"));
    await flushAsync(DEBOUNCE_MS);
    web.userEdit(original);
    await flushAsync(); // the revert's save is pending in the debounce...
    rerender(<NoteEditorPanel noteId="b" />); // ...and the switch flushes it at once

    await act(async () => {
      release();
      await jest.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    });

    expect(a.content).toBe(serializeEditorContent(original));
    expect(writes(b)).toBe(0);
  });

  it("a title change still saves", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    const { getByPlaceholderText } = renderPanel("a");
    await flushAsync();

    fireEvent.changeText(getByPlaceholderText("Untitled"), "Renamed");
    await flushAsync(DEBOUNCE_MS);

    expect(writes(note)).toBe(1);
    expect(note.title).toBe("Renamed");
    expect(note.content).toBe(webAuthoredContent("Hello"));
  });

  it("a pending edit flushed by a rapid switch lands only on its own note", async () => {
    const a = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    const b = createRecord("b", "Meeting notes", webAuthoredContent("Agenda"));
    const { rerender } = renderPanel("a");
    await flushAsync();

    const editedA = withParagraph(web.currentDoc(), "only for A");
    web.userEdit(editedA);
    await flushAsync(); // getJSON resolved; the save is queued in the debounce

    rerender(<NoteEditorPanel noteId="b" />);
    await flushAsync(DEBOUNCE_MS * 2);

    expect(writes(a)).toBe(1);
    expect(a.content).toBe(serializeEditorContent(editedA));
    expect(writes(b)).toBe(0);
    expect(b.content).toBe(webAuthoredContent("Agenda"));
  });

  it("re-seeds the baseline when a note is reopened after it changed via sync", async () => {
    const a = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    createRecord("b", "Meeting notes", webAuthoredContent("Agenda"));
    const { rerender } = renderPanel("a");
    await flushAsync();
    const firstLoad = web.currentDoc();

    rerender(<NoteEditorPanel noteId="b" />);
    await flushAsync();
    a.content = webAuthoredContent("Changed on another device");
    rerender(<NoteEditorPanel noteId="a" />);
    await flushAsync();
    web.emitChange();
    await flushAsync(DEBOUNCE_MS * 2);
    expect(writes(a)).toBe(0);

    // Typing the first visit's text back in is a real edit of the synced note.
    web.userEdit(firstLoad);
    await flushAsync(DEBOUNCE_MS);
    expect(writes(a)).toBe(1);
    expect(a.content).toBe(serializeEditorContent(firstLoad));
  });

  it("a baseline stops counting once a sync changes the open note's stored row", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    renderPanel("a");
    await flushAsync();
    const original = web.currentDoc();
    const withMilk = withParagraph(original, "buy milk");

    // The phone adds a line; sync pulls it in while desktop still shows the old body.
    note.content = serializeEditorContent(withMilk);

    web.userEdit(withMilk); // desktop types the same line: already stored, no write
    await flushAsync(DEBOUNCE_MS);
    expect(writes(note)).toBe(0);

    web.userEdit(original); // ...then deletes it: a real change against the synced row
    await flushAsync(DEBOUNCE_MS);
    expect(writes(note)).toBe(1);
    expect(note.content).toBe(serializeEditorContent(original));
  });

  it("still opens the note and saves edits when the baseline read fails", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    web.failNextGetJSON();
    const { getByPlaceholderText } = renderPanel("a");
    await flushAsync();

    // The gate opened (title edits are gated on it too) despite the failed read.
    fireEvent.changeText(getByPlaceholderText("Untitled"), "Renamed");
    const edited = withParagraph(web.currentDoc(), "after a failed read");
    web.userEdit(edited);
    await flushAsync(DEBOUNCE_MS);

    expect(note.title).toBe("Renamed");
    expect(note.content).toBe(serializeEditorContent(edited));
  });

  it("falls back to the exact stored-content comparison when the baseline read fails", async () => {
    // Desktop-authored: the stored bytes already are the editor's serialisation.
    createRecord("seed", "Seed", webAuthoredContent("Hello"));
    const { rerender } = renderPanel("seed");
    await flushAsync();
    const stored = serializeEditorContent(web.currentDoc());
    const note = createRecord("a", "Desktop note", stored);

    web.failNextGetJSON();
    rerender(<NoteEditorPanel noteId="a" />);
    await flushAsync();
    web.emitChange(); // late load echo, after the gate opened without a baseline
    await flushAsync(DEBOUNCE_MS * 2);

    expect(writes(note)).toBe(0);
  });

  it("does not let a previous visit's baseline mask an edit when the reopen's read fails", async () => {
    const a = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    createRecord("b", "Meeting notes", webAuthoredContent("Agenda"));
    const { rerender } = renderPanel("a");
    await flushAsync();
    const firstLoad = web.currentDoc();

    rerender(<NoteEditorPanel noteId="b" />);
    await flushAsync();
    a.content = webAuthoredContent("Changed on another device");
    web.failNextGetJSON();
    rerender(<NoteEditorPanel noteId="a" />);
    await flushAsync();

    web.userEdit(firstLoad); // equals the first visit's baseline, but the row has moved on
    await flushAsync(DEBOUNCE_MS);
    expect(writes(a)).toBe(1);
    expect(a.content).toBe(serializeEditorContent(firstLoad));
  });

  it("opens the gate after a bounded wait when the WebView never answers the read", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    web.hangNextGetJSON();
    const { getByPlaceholderText } = renderPanel("a");
    await flushAsync(DEBOUNCE_MS);

    // Still gated while the read is outstanding: edits are not saved yet.
    fireEvent.changeText(getByPlaceholderText("Untitled"), "Too early");
    await flushAsync(DEBOUNCE_MS);
    expect(writes(note)).toBe(0);

    await flushAsync(5000); // past the panel's baseline-read timeout
    fireEvent.changeText(getByPlaceholderText("Untitled"), "Renamed");
    const edited = withParagraph(web.currentDoc(), "after the timeout");
    web.userEdit(edited);
    await flushAsync(DEBOUNCE_MS);

    expect(note.title).toBe("Renamed");
    expect(note.content).toBe(serializeEditorContent(edited));
  });

  it("opens the note without a baseline when the read-back cannot be serialised", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    web.malformNextGetJSON();
    const { getByPlaceholderText } = renderPanel("a");
    await flushAsync();

    expect(warn).toHaveBeenCalledWith(
      "[note-editor] baseline serialisation failed",
      expect.any(Error),
    );
    // Not routed into the load-failure path: the gate opened and edits save.
    fireEvent.changeText(getByPlaceholderText("Untitled"), "Renamed");
    await flushAsync(DEBOUNCE_MS);
    expect(note.title).toBe("Renamed");
    warn.mockRestore();
  });

  it("an inserted attachment persists once, and removing it again is a real change", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    renderPanel("a");
    await flushAsync();
    const original = web.currentDoc();

    await act(async () => {
      mockAttachmentPicker.onAttachmentReady?.({
        filePath: "user-1/a/report.pdf",
        fileName: "report.pdf",
        mimeType: "application/pdf",
      } as Attachment);
      await jest.advanceTimersByTimeAsync(0);
    });
    // The setContent echo of the insertion must not add a second write.
    await flushAsync(DEBOUNCE_MS * 2);
    expect(writes(note)).toBe(1);
    expect(note.content).toContain(toAttachmentUrl("user-1/a/report.pdf"));

    web.userEdit(original);
    await flushAsync(DEBOUNCE_MS);
    expect(writes(note)).toBe(2);
    expect(note.content).toBe(serializeEditorContent(original));
  });

  it("removing an attachment whose insert is still queued is not mistaken for a no-op", async () => {
    const note = createRecord("a", "Welcome", webAuthoredContent("Hello"));
    renderPanel("a");
    await flushAsync();
    const original = web.currentDoc();

    const release = holdWriteQueue();
    await act(async () => {
      mockAttachmentPicker.onAttachmentReady?.({
        filePath: "user-1/a/report.pdf",
        fileName: "report.pdf",
        mimeType: "application/pdf",
      } as Attachment);
      await jest.advanceTimersByTimeAsync(0);
    });
    web.userEdit(original); // removed again before the insert's write commits
    await flushAsync(DEBOUNCE_MS);

    await act(async () => {
      release();
      await jest.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    });

    expect(note.content).toBe(serializeEditorContent(original));
  });
});
