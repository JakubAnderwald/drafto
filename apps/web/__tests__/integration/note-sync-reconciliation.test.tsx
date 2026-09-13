import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";

import type { NoteListPatch } from "@/lib/note-patch";

/**
 * End-to-end reconciliation for a note changed somewhere else, exercised through the
 * real `useNoteSync` and the real `useAutoSave` — only the Supabase transport, the
 * BlockNote editor and `fetch` are stood in for.
 *
 * The unit tests own the hook's internals; this file owns the part that has to hold
 * together across them: dirty-aware apply-vs-ask, and what the user actually sees.
 */

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

type NoteRow = { id: string; updated_at: string; is_trashed: boolean };

type RealtimePayload =
  { eventType: "INSERT" | "UPDATE"; new: NoteRow } | { eventType: "DELETE"; old: { id: string } };

let realtimeHandler: ((payload: RealtimePayload) => void) | null = null;

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel(topic: string) {
      const channel = {
        topic,
        on(
          _event: string,
          _config: Record<string, string>,
          handler: (payload: RealtimePayload) => void,
        ) {
          realtimeHandler = handler;
          return channel;
        },
        subscribe: () => channel,
      };
      return channel;
    },
    removeChannel: () => {},
  }),
}));

/**
 * A stand-in for BlockNote (which needs a canvas jsdom lacks). `useState`'s initialiser
 * runs once per mounted instance, so `data-instance` changes only on a genuine remount
 * — which is what proves externally-applied content actually reaches the editor,
 * because `useCreateBlockNote` reads `initialContent` once per instance.
 */
vi.mock("@/components/editor/note-editor", async () => {
  const { useState } = await import("react");
  let instances = 0;
  return {
    NoteEditor: ({
      initialContent,
      onChange,
    }: {
      initialContent?: unknown;
      onChange: (content: never[]) => void;
    }) => {
      const [instance] = useState(() => ++instances);
      return (
        <div data-testid="note-editor" data-instance={instance}>
          <span data-testid="editor-content">{JSON.stringify(initialContent ?? null)}</span>
          <button type="button" onClick={() => onChange([])}>
            simulate typing
          </button>
        </div>
      );
    },
  };
});

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { NoteEditorPanel } = await import("@/components/notes/note-editor-panel");

const ORIGINAL_AT = "2026-09-06T12:00:00.000+00:00";
const SAVED_AT = "2026-09-06T12:01:00.000+00:00";
const EXTERNAL_AT = "2026-09-06T12:05:00.000+00:00";

const REMOTE_BODY = [{ type: "paragraph", content: [{ type: "text", text: "Remote body" }] }];

interface ServerNote {
  id: string;
  title: string;
  content: unknown;
  created_at: string;
  updated_at: string;
  is_trashed: boolean;
}

let serverNote: ServerNote;
let hardDeleted = false;
/** Bodies of every PATCH the panel's autosave actually put on the wire. */
let patches: Record<string, unknown>[];

// The panel keeps a module-level promise cache keyed by note id, so every test needs
// its own id to get a fresh initial load.
let noteIdCounter = 900;
const nextNoteId = () => `sync-note-${noteIdCounter++}`;

/**
 * Drain the pending GET/PATCH promises and let React commit the result. Yielding to
 * the macrotask queue (rather than a fixed number of `Promise.resolve()` ticks) drains
 * the whole microtask chain — `fetch` -> `res.json()` -> setState — in one go.
 */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountPanel(
  noteId: string,
  handlers: {
    onNoteUpdated?: (patch: NoteListPatch) => void;
    onNoteClosed?: (noteId: string) => void;
  } = {},
) {
  // The initial load goes through React's `use()`, so the first render suspends —
  // it has to happen inside an awaited `act` for React to resolve the boundary.
  await act(async () => {
    render(
      <Suspense fallback={<div data-testid="loading" />}>
        <NoteEditorPanel noteId={noteId} {...handlers} />
      </Suspense>,
    );
  });
  await flush();
  await screen.findByTestId("note-editor");
}

async function emitRealtime(payload: RealtimePayload) {
  await act(async () => {
    realtimeHandler?.(payload);
  });
  await flush();
}

async function wakeTab() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush();
}

function titleInput() {
  return screen.getByLabelText("Note title") as HTMLInputElement;
}

/** Put an external edit on the server without announcing it yet. */
function changeServerNote(patch: Partial<ServerNote>) {
  serverNote = { ...serverNote, ...patch };
}

const externalUpdate = (id: string): RealtimePayload => ({
  eventType: "UPDATE",
  new: { id, updated_at: EXTERNAL_AT, is_trashed: serverNote.is_trashed },
});

describe("external-change reconciliation in the note editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    realtimeHandler = null;
    hardDeleted = false;
    patches = [];
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });

    serverNote = {
      id: "placeholder",
      title: "Original title",
      content: null,
      created_at: "2026-09-06T10:00:00.000+00:00",
      updated_at: ORIGINAL_AT,
      is_trashed: false,
    };

    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ updated_at: SAVED_AT }),
        });
      }
      if (hardDeleted) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ...serverNote, id: String(url).split("/").pop() }),
      });
    });
  });

  describe("when the editor has no unsaved edits", () => {
    it("applies an external edit without a page reload", async () => {
      const noteId = nextNoteId();
      const onNoteUpdated = vi.fn();
      await mountPanel(noteId, { onNoteUpdated });
      expect(titleInput().value).toBe("Original title");
      const firstInstance = screen.getByTestId("note-editor").dataset.instance;

      changeServerNote({
        title: "Edited elsewhere",
        content: REMOTE_BODY,
        updated_at: EXTERNAL_AT,
      });
      await emitRealtime(externalUpdate(noteId));

      expect(titleInput().value).toBe("Edited elsewhere");
      expect(screen.getByTestId("editor-content").textContent).toContain("Remote body");
      // A new editor instance — the remount is what makes fresh content render.
      expect(screen.getByTestId("note-editor").dataset.instance).not.toBe(firstInstance);
      expect(screen.queryByTestId("note-sync-banner")).not.toBeInTheDocument();
      expect(onNoteUpdated).toHaveBeenCalledWith({
        noteId,
        updatedAt: EXTERNAL_AT,
        title: "Edited elsewhere",
      });
    });

    it("picks up an external edit when the tab regains focus, with no realtime event", async () => {
      const noteId = nextNoteId();
      await mountPanel(noteId);

      changeServerNote({ title: "Changed while away", updated_at: EXTERNAL_AT });
      await wakeTab();

      expect(titleInput().value).toBe("Changed while away");
    });

    it("leaves the editor alone when the wake-up finds nothing new", async () => {
      const noteId = nextNoteId();
      await mountPanel(noteId);
      const firstInstance = screen.getByTestId("note-editor").dataset.instance;

      await wakeTab();

      expect(titleInput().value).toBe("Original title");
      // No gratuitous remount — that would throw away caret and scroll position.
      expect(screen.getByTestId("note-editor").dataset.instance).toBe(firstInstance);
    });
  });

  describe("when the editor holds unsaved edits", () => {
    async function mountDirty(noteId: string, onNoteUpdated?: (patch: NoteListPatch) => void) {
      await mountPanel(noteId, onNoteUpdated ? { onNoteUpdated } : {});
      // Queue a local edit; the 500ms autosave debounce has not fired yet.
      fireEvent.change(titleInput(), { target: { value: "My unsaved title" } });
      await flush();
    }

    it("asks instead of silently overwriting the user's work", async () => {
      const noteId = nextNoteId();
      await mountDirty(noteId);

      changeServerNote({
        title: "Edited elsewhere",
        content: REMOTE_BODY,
        updated_at: EXTERNAL_AT,
      });
      await emitRealtime(externalUpdate(noteId));

      expect(screen.getByTestId("note-sync-banner")).toHaveTextContent(
        /changed on another device/i,
      );
      // The user's in-progress edit is untouched.
      expect(titleInput().value).toBe("My unsaved title");
      expect(screen.getByTestId("editor-content").textContent).not.toContain("Remote body");
    });

    it('adopts the remote version on "Discard mine" and drops the queued save', async () => {
      const noteId = nextNoteId();
      await mountDirty(noteId);
      changeServerNote({
        title: "Edited elsewhere",
        content: REMOTE_BODY,
        updated_at: EXTERNAL_AT,
      });
      await emitRealtime(externalUpdate(noteId));

      fireEvent.click(screen.getByRole("button", { name: "Discard mine" }));
      await flush();

      expect(titleInput().value).toBe("Edited elsewhere");
      expect(screen.getByTestId("editor-content").textContent).toContain("Remote body");
      expect(screen.queryByTestId("note-sync-banner")).not.toBeInTheDocument();
      // The whole point: the discarded edit must never land after the reload.
      expect(patches).toHaveLength(0);
    });

    it('keeps the local edit on "Keep mine"', async () => {
      const noteId = nextNoteId();
      await mountDirty(noteId);
      changeServerNote({ title: "Edited elsewhere", updated_at: EXTERNAL_AT });
      await emitRealtime(externalUpdate(noteId));

      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
      await flush();

      expect(screen.queryByTestId("note-sync-banner")).not.toBeInTheDocument();
      expect(titleInput().value).toBe("My unsaved title");
    });

    it("does not nag again about a change the user already dismissed", async () => {
      const noteId = nextNoteId();
      await mountDirty(noteId);
      changeServerNote({ title: "Edited elsewhere", updated_at: EXTERNAL_AT });
      await emitRealtime(externalUpdate(noteId));
      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
      await flush();

      // The same change redelivered (a duplicate, or a focus re-check).
      await wakeTab();

      expect(screen.queryByTestId("note-sync-banner")).not.toBeInTheDocument();
    });
  });

  describe("when the note stops existing elsewhere", () => {
    it("reports an external trash and keeps saving into the trashed row", async () => {
      const noteId = nextNoteId();
      const onNoteUpdated = vi.fn();
      await mountPanel(noteId, { onNoteUpdated });

      changeServerNote({ is_trashed: true, updated_at: EXTERNAL_AT });
      await emitRealtime(externalUpdate(noteId));

      expect(screen.getByTestId("note-sync-banner")).toHaveTextContent(/moved to Trash/i);
      // Still editable — a trashed note is restorable, so in-flight edits are not lost.
      expect(screen.getByTestId("note-editor")).toBeInTheDocument();
      expect(onNoteUpdated).toHaveBeenCalledWith({ noteId, removed: true });
    });

    it("closes the note when the user dismisses the trash notice", async () => {
      const noteId = nextNoteId();
      const onNoteClosed = vi.fn();
      await mountPanel(noteId, { onNoteClosed });
      changeServerNote({ is_trashed: true, updated_at: EXTERNAL_AT });
      await emitRealtime(externalUpdate(noteId));

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(onNoteClosed).toHaveBeenCalledWith(noteId);
    });

    it("reports a hard delete and takes the editor away", async () => {
      const noteId = nextNoteId();
      const onNoteUpdated = vi.fn();
      await mountPanel(noteId, { onNoteUpdated });

      hardDeleted = true;
      await emitRealtime({ eventType: "DELETE", old: { id: noteId } });

      expect(screen.getByTestId("note-sync-banner")).toHaveTextContent(/permanently deleted/i);
      expect(screen.queryByTestId("note-editor")).not.toBeInTheDocument();
      expect(onNoteUpdated).toHaveBeenCalledWith({ noteId, removed: true });
    });

    it("detects a hard delete on wake-up when no realtime event arrived", async () => {
      const noteId = nextNoteId();
      await mountPanel(noteId);

      hardDeleted = true;
      await wakeTab();

      expect(screen.getByTestId("note-sync-banner")).toHaveTextContent(/permanently deleted/i);
    });

    it("does not keep retrying a save against a note that is gone", async () => {
      const noteId = nextNoteId();
      await mountPanel(noteId);
      fireEvent.change(titleInput(), { target: { value: "Typed just before the delete" } });
      await flush();

      hardDeleted = true;
      await emitRealtime({ eventType: "DELETE", old: { id: noteId } });

      // The queued PATCH was cancelled rather than left to 404 into an "Error" badge.
      expect(patches).toHaveLength(0);
      expect(screen.queryByTestId("save-status-badge")).not.toBeInTheDocument();
    });
  });

  describe("self-echo", () => {
    it("does not treat the panel's own save as an external change", async () => {
      const noteId = nextNoteId();
      await mountPanel(noteId);
      const firstInstance = screen.getByTestId("note-editor").dataset.instance;

      fireEvent.change(titleInput(), { target: { value: "Locally typed" } });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });
      await flush();
      expect(patches).toHaveLength(1);

      // The save's own row change comes back over realtime.
      changeServerNote({ title: "Locally typed", updated_at: SAVED_AT });
      await emitRealtime({
        eventType: "UPDATE",
        new: { id: noteId, updated_at: SAVED_AT, is_trashed: false },
      });

      expect(screen.queryByTestId("note-sync-banner")).not.toBeInTheDocument();
      expect(titleInput().value).toBe("Locally typed");
      // No remount, so the user's caret survives their own autosave.
      expect(screen.getByTestId("note-editor").dataset.instance).toBe(firstInstance);
    });
  });
});
