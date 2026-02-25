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

const mockNotes = [
  { id: "note-1", title: "First Note", updated_at: new Date().toISOString() },
  { id: "note-2", title: "Second Note", updated_at: new Date().toISOString() },
];

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { NoteList } = await import("@/components/notes/note-list");

// The component uses a module-level Map cache (`notesCache`). We need to
// bust it by varying the `refreshTrigger` prop between tests so each test
// gets a fresh fetch.
let triggerCounter = 100;

function nextTrigger() {
  return triggerCounter++;
}

describe("NoteList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockNotes),
    });
  });

  it("renders notes after loading", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
      expect(screen.getByText("Second Note")).toBeInTheDocument();
    });
  });

  it("shows the Notes heading", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Notes")).toBeInTheDocument();
    });
  });

  it("has a new note button", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText("New note")).toBeInTheDocument();
    });
  });

  it("calls onCreateNote when the new note button is clicked", async () => {
    const trigger = nextTrigger();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText("New note")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("New note"));

    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("calls onSelectNote when a note is clicked", async () => {
    const trigger = nextTrigger();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    await user.click(screen.getByText("First Note"));

    expect(onSelect).toHaveBeenCalledWith("note-1");
  });

  it("highlights the selected note", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId="note-1"
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    const selectedButton = screen.getByText("First Note").closest("button");
    expect(selectedButton).toHaveClass("bg-blue-100");
  });

  it("shows empty state when there are no notes", async () => {
    const trigger = nextTrigger();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("No notes yet. Create one to get started.")).toBeInTheDocument();
    });
  });

  it("shows Suspense fallback while loading", async () => {
    const trigger = nextTrigger();
    // Create a promise that never resolves to keep the component suspended
    mockFetch.mockReturnValue(new Promise(() => {}));

    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("fetches notes for the given notebook ID", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-42"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-42/notes");
    });
  });
});
