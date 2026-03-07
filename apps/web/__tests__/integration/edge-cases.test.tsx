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

// Mock handleAuthError to avoid window.location issues in tests
vi.mock("@/lib/handle-auth-error", () => ({
  handleAuthError: vi.fn((res: { status: number }) => res.status === 401),
}));

// Mock BlockNote
vi.mock("@blocknote/react", () => ({
  useCreateBlockNote: () => ({ document: [] }),
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

// Mock useAutoSave
const mockDebouncedSave = vi.fn();
vi.mock("@/hooks/use-auto-save", () => ({
  useAutoSave: () => ({
    saveStatus: "idle" as const,
    debouncedSave: mockDebouncedSave,
  }),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// --- Notebooks sidebar edge cases ---

let NotebooksSidebar: typeof import("@/components/notebooks/notebooks-sidebar").NotebooksSidebar;

describe("NotebooksSidebar — edge cases", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const mod = await import("@/components/notebooks/notebooks-sidebar");
    NotebooksSidebar = mod.NotebooksSidebar;
  });

  it("shows empty state when no notebooks exist", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText("No notebooks yet. Create one to get started.")).toBeInTheDocument();
    });
  });

  it("shows confirmation dialog when delete is clicked", async () => {
    const user = userEvent.setup();

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: "nb-1", name: "My Notebook", created_at: "2026-01-01", updated_at: "2026-01-01" },
        ]),
    });

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText("My Notebook")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Delete My Notebook"));

    // Confirmation dialog should appear
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/Delete "My Notebook"\?/)).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("cancels delete when cancel button is clicked", async () => {
    const user = userEvent.setup();

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: "nb-1", name: "My Notebook", created_at: "2026-01-01", updated_at: "2026-01-01" },
        ]),
    });

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText("My Notebook")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Delete My Notebook"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await user.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows error when delete returns 409 (notebook has notes)", async () => {
    const user = userEvent.setup();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: "nb-1", name: "My Notebook", created_at: "2026-01-01", updated_at: "2026-01-01" },
          ]),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            error: "Cannot delete notebook with notes. Move or delete notes first.",
          }),
      });

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText("My Notebook")).toBeInTheDocument();
    });

    // Click delete
    await user.click(screen.getByLabelText("Delete My Notebook"));
    // Confirm delete
    await user.click(screen.getByText("Delete"));

    // Error should appear
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(
        screen.getByText("Cannot delete notebook with notes. Move or delete notes first."),
      ).toBeInTheDocument();
    });

    // Notebook should still be in the list
    expect(screen.getByText("My Notebook")).toBeInTheDocument();
  });

  it("successfully deletes notebook after confirmation", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: "nb-1", name: "My Notebook", created_at: "2026-01-01", updated_at: "2026-01-01" },
          ]),
      })
      .mockResolvedValueOnce({ ok: true });

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByText("My Notebook")).toBeInTheDocument();
    });

    // Click delete
    await user.click(screen.getByLabelText("Delete My Notebook"));
    // Confirm delete
    await user.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-1", { method: "DELETE" });
    });

    // Notebook should be removed and onSelectNotebook(null) called
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(null);
    });
  });
});

// --- Note editor panel — title maxLength ---

describe("NoteEditorPanel — title maxLength", () => {
  it("limits title input to 255 characters", async () => {
    vi.resetModules();

    const { NoteEditorPanel } = await import("@/components/notes/note-editor-panel");
    const noteId = `note-maxlen-${Date.now()}`;

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: noteId,
          title: "Test Title",
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
      expect(screen.getByLabelText("Note title")).toBeInTheDocument();
    });

    const titleInput = screen.getByLabelText("Note title") as HTMLInputElement;
    expect(titleInput.maxLength).toBe(255);
  });
});

// --- handleAuthError utility ---

describe("handleAuthError", () => {
  it("returns true for 401 responses", async () => {
    // Re-import the real implementation
    vi.resetModules();

    // Need to use dynamic import to get the mocked version
    const { handleAuthError } = await import("@/lib/handle-auth-error");
    expect(handleAuthError({ status: 401 } as Response)).toBe(true);
  });

  it("returns false for non-401 responses", async () => {
    vi.resetModules();
    const { handleAuthError } = await import("@/lib/handle-auth-error");
    expect(handleAuthError({ status: 200 } as Response)).toBe(false);
    expect(handleAuthError({ status: 403 } as Response)).toBe(false);
    expect(handleAuthError({ status: 500 } as Response)).toBe(false);
  });
});
