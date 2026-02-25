import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, Suspense } from "react";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

// Mock BlockNote — the real editor needs a canvas which jsdom lacks
vi.mock("@blocknote/react", () => ({
  useCreateBlockNote: () => ({
    document: [],
  }),
  BlockNoteView: vi.fn(({ editor: _editor, theme: _theme }) => (
    <div data-testid="blocknote-editor">BlockNote Editor</div>
  )),
}));

vi.mock("@blocknote/mantine", () => ({
  BlockNoteView: vi.fn(({ editor: _editor, theme: _theme }) => (
    <div data-testid="blocknote-editor">BlockNote Editor</div>
  )),
}));

vi.mock("@blocknote/mantine/style.css", () => ({}));

// Mock useAutoSave to avoid real fetch calls from the hook
const mockDebouncedSave = vi.fn();
vi.mock("@/hooks/use-auto-save", () => ({
  useAutoSave: () => ({
    saveStatus: "idle" as const,
    debouncedSave: mockDebouncedSave,
  }),
}));

const mockNote = {
  id: "note-1",
  title: "Test Note Title",
  content: null,
};

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { NoteEditorPanel } = await import("@/components/notes/note-editor-panel");

// The component uses a module-level noteCache Map. Vary note IDs between
// tests so each test gets a fresh fetch.
let noteIdCounter = 200;

function nextNoteId() {
  return `note-${noteIdCounter++}`;
}

describe("NoteEditorPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockNote, id: "dynamic" }),
    });
  });

  it("renders the note title and editor", async () => {
    const noteId = nextNoteId();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockNote, id: noteId }),
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Note title")).toBeInTheDocument();
    });

    expect(screen.getByDisplayValue("Test Note Title")).toBeInTheDocument();
    expect(screen.getByTestId("blocknote-editor")).toBeInTheDocument();
  });

  it("shows 'Note not found' when fetch returns not-ok", async () => {
    const noteId = nextNoteId();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve(null),
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Note not found")).toBeInTheDocument();
    });
  });

  it("shows Suspense fallback while loading", async () => {
    const noteId = nextNoteId();
    mockFetch.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("calls debouncedSave when title is changed", async () => {
    const noteId = nextNoteId();
    const user = userEvent.setup();

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockNote, id: noteId }),
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Note title")).toBeInTheDocument();
    });

    const titleInput = screen.getByLabelText("Note title");
    await user.clear(titleInput);
    await user.type(titleInput, "New Title");

    expect(mockDebouncedSave).toHaveBeenCalled();
    // The last call should contain the updated title
    const lastCall = mockDebouncedSave.mock.calls[mockDebouncedSave.mock.calls.length - 1];
    expect(lastCall[0]).toEqual({ title: "New Title" });
  });

  it("renders the title input with a placeholder", async () => {
    const noteId = nextNoteId();

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: noteId, title: "", content: null }),
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Untitled")).toBeInTheDocument();
    });
  });

  it("fetches the correct note by ID", async () => {
    const noteId = nextNoteId();

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockNote, id: noteId }),
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(`/api/notes/${noteId}`);
    });
  });
});
