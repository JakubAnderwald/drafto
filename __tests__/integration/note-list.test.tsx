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
    expect(selectedButton).toHaveAttribute("data-testid", "note-item-active");
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

  it("displays relative time for notes updated hours ago", async () => {
    const trigger = nextTrigger();
    const hoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: "note-h", title: "Hours Ago", updated_at: hoursAgo }]),
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("3h ago")).toBeInTheDocument();
    });
  });

  it("displays relative time for notes updated days ago", async () => {
    const trigger = nextTrigger();
    const daysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: "note-d", title: "Days Ago", updated_at: daysAgo }]),
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("5d ago")).toBeInTheDocument();
    });
  });

  it("displays date string for notes updated over 30 days ago", async () => {
    const trigger = nextTrigger();
    const oldDate = new Date(Date.now() - 60 * 86400000).toISOString();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: "note-old", title: "Old Note", updated_at: oldDate }]),
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    // Should show a date string (locale-dependent), not "Xd ago"
    await waitFor(() => {
      expect(screen.getByText("Old Note")).toBeInTheDocument();
      const timeText = screen
        .getByText("Old Note")
        .closest("button")
        ?.querySelector("p:last-child");
      expect(timeText?.textContent).not.toMatch(/d ago/);
    });
  });

  it("shows move button on hover with other notebooks available", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onMove = vi.fn();
    const notebooks = [
      { id: "nb-1", name: "Current" },
      { id: "nb-2", name: "Work" },
      { id: "nb-3", name: "Personal" },
    ];

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            onMoveNote={onMove}
            notebooks={notebooks}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    // Move buttons should be rendered (hidden by CSS, but present in DOM)
    expect(screen.getByLabelText("Actions for First Note")).toBeInTheDocument();
    expect(screen.getByLabelText("Actions for Second Note")).toBeInTheDocument();
  });

  it("opens move menu and shows other notebooks", async () => {
    const trigger = nextTrigger();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onMove = vi.fn();
    const notebooks = [
      { id: "nb-1", name: "Current" },
      { id: "nb-2", name: "Work" },
      { id: "nb-3", name: "Personal" },
    ];

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            onMoveNote={onMove}
            notebooks={notebooks}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    // Click the move button for the first note
    await user.click(screen.getByLabelText("Actions for First Note"));

    // Should show menu with other notebooks (not Current which is nb-1)
    expect(screen.getByText("Move to...")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Work" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Personal" })).toBeInTheDocument();
    // Should NOT show the current notebook
    expect(screen.queryByRole("menuitem", { name: "Current" })).not.toBeInTheDocument();
  });

  it("calls onMoveNote when a target notebook is clicked", async () => {
    const trigger = nextTrigger();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onMove = vi.fn();
    const notebooks = [
      { id: "nb-1", name: "Current" },
      { id: "nb-2", name: "Work" },
    ];

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            onMoveNote={onMove}
            notebooks={notebooks}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    // Open move menu
    await user.click(screen.getByLabelText("Actions for First Note"));

    // Click the target notebook
    await user.click(screen.getByRole("menuitem", { name: "Work" }));

    // Should call onMoveNote with the note ID and target notebook ID
    expect(onMove).toHaveBeenCalledWith("note-1", "nb-2");

    // Note should be removed from the list
    expect(screen.queryByText("First Note")).not.toBeInTheDocument();
  });

  it("does not show move button when no other notebooks exist", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const notebooks = [{ id: "nb-1", name: "Current" }];

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            notebooks={notebooks}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    // No move buttons should exist when only one notebook
    expect(screen.queryByLabelText("Actions for First Note")).not.toBeInTheDocument();
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
