import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";

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
let mockSaveStatus = "idle";
vi.mock("@/hooks/use-auto-save", () => ({
  useAutoSave: () => ({
    saveStatus: mockSaveStatus,
    debouncedSave: mockDebouncedSave,
  }),
}));

const mockNote = {
  id: "note-1",
  title: "Test Note Title",
  content: null,
  created_at: "2026-02-20T10:00:00Z",
  updated_at: "2026-02-28T15:30:00Z",
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
    mockSaveStatus = "idle";
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
        <Suspense fallback={<Skeleton height="2rem" />}>
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
        <Suspense fallback={<Skeleton height="2rem" />}>
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
        <Suspense fallback={<Skeleton height="2rem" />}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    expect(screen.getByRole("status")).toBeInTheDocument();
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
        <Suspense fallback={<Skeleton height="2rem" />}>
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
      json: () =>
        Promise.resolve({
          id: noteId,
          title: "",
          content: null,
          created_at: "2026-02-20T10:00:00Z",
          updated_at: "2026-02-28T15:30:00Z",
        }),
    });

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2rem" />}>
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
        <Suspense fallback={<Skeleton height="2rem" />}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(`/api/notes/${noteId}`);
    });
  });

  it("shows 'Saving' badge when save status is saving", async () => {
    mockSaveStatus = "saving";
    const noteId = nextNoteId();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockNote, id: noteId }),
    });

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2rem" />}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      const badge = screen.getByTestId("save-status-badge");
      expect(badge).toHaveTextContent("Saving");
      expect(badge).toHaveAttribute("role", "status");
      expect(badge).toHaveAttribute("aria-live", "polite");
    });
  });

  it("shows 'Saved' badge when save status is saved", async () => {
    mockSaveStatus = "saved";
    const noteId = nextNoteId();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockNote, id: noteId }),
    });

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2rem" />}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      const badge = screen.getByTestId("save-status-badge");
      expect(badge).toHaveTextContent("Saved");
      expect(badge).toHaveAttribute("role", "status");
    });
  });

  it("shows 'Error' badge with alert role when save status is error", async () => {
    mockSaveStatus = "error";
    const noteId = nextNoteId();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockNote, id: noteId }),
    });

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2rem" />}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      const badge = screen.getByTestId("save-status-badge");
      expect(badge).toHaveTextContent("Error");
      expect(badge).toHaveAttribute("role", "alert");
      expect(badge).toHaveAttribute("aria-live", "assertive");
    });
  });

  it("does not show save badge when save status is idle", async () => {
    mockSaveStatus = "idle";
    const noteId = nextNoteId();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockNote, id: noteId }),
    });

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2rem" />}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Note title")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("save-status-badge")).not.toBeInTheDocument();
  });

  it("re-fetches note when refreshTrigger changes", async () => {
    const noteId = nextNoteId();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockNote, id: noteId, title: "Old Title" }),
    });

    const { unmount } = await act(async () =>
      render(
        <Suspense fallback={<Skeleton height="2rem" />}>
          <NoteEditorPanel noteId={noteId} refreshTrigger={0} />
        </Suspense>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue("Old Title")).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    unmount();

    // Simulate refreshTrigger increment with updated data
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockNote, id: noteId, title: "New Title" }),
    });

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2rem" />}>
          <NoteEditorPanel noteId={noteId} refreshTrigger={1} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("New Title")).toBeInTheDocument();
    });

    // Should have fetched again because refreshTrigger changed
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("renders timestamp icons for created and modified dates", async () => {
    const noteId = nextNoteId();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...mockNote, id: noteId }),
    });

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2rem" />}>
          <NoteEditorPanel noteId={noteId} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/Created/)).toBeInTheDocument();
      expect(screen.getByText(/Modified/)).toBeInTheDocument();
    });
  });
});
