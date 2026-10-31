import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockNotebooks = [
  { id: "nb-1", name: "Notes", created_at: "2026-01-01", updated_at: "2026-01-01" },
  { id: "nb-2", name: "Work", created_at: "2026-01-02", updated_at: "2026-01-02" },
];

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const TRASHED_NOTES_WARNING = "Trashed notes inside will be permanently deleted.";

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

interface RoutedFetch {
  /** `GET /api/notes/trash`. A pending promise keeps the delete check running. */
  trashed?: unknown[] | Promise<FakeResponse>;
  /** `GET /api/notebooks/:id/notes`, by notebook id. Missing ids answer with no notes. */
  activeByNotebook?: Record<string, unknown[]>;
  /** `DELETE /api/notebooks/:id`. */
  deleteResponse?: FakeResponse;
}

/**
 * Answers each request by its URL, so the delete check's two GETs can land in any order
 * around the notebook list and the DELETE.
 */
function routeFetch({
  trashed = [],
  activeByNotebook = {},
  deleteResponse = jsonResponse({ success: true }),
}: RoutedFetch = {}) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return Promise.resolve(deleteResponse);
    if (url === "/api/notebooks") return Promise.resolve(jsonResponse(mockNotebooks));
    if (url === "/api/notes/trash") {
      return Array.isArray(trashed) ? Promise.resolve(jsonResponse(trashed)) : trashed;
    }
    const match = /^\/api\/notebooks\/([^/]+)\/notes$/.exec(url);
    if (match) return Promise.resolve(jsonResponse(activeByNotebook[match[1]] ?? []));
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
}

function trashedNote(id: string, notebookId: string) {
  return {
    id,
    title: id,
    notebook_id: notebookId,
    trashed_at: "2026-10-01T00:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}

/** Renders the sidebar, opens the delete confirm for "Notes" (nb-1) and returns the dialog. */
async function openDeleteConfirmForNotes(onSelect = vi.fn()) {
  const user = userEvent.setup();

  await act(async () => {
    render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={onSelect} />);
  });

  await waitFor(() => {
    expect(screen.getByText("Notes")).toBeInTheDocument();
  });

  await user.click(screen.getByLabelText("Delete Notes"));

  const dialog = screen.getByRole("alertdialog");
  return { user, dialog, deleteButton: within(dialog).getByRole("button", { name: "Delete" }) };
}

// Re-import the module before each test to reset the internal `hasFetched` ref.
// The component guards fetching with `if (hasFetched.current) return;` so a
// single import shares that ref across all tests.
let NotebooksSidebar: typeof import("@/components/notebooks/notebooks-sidebar").NotebooksSidebar;

beforeEach(async () => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  vi.resetModules();

  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(mockNotebooks),
  });

  // Re-import to get a fresh module with a new hasFetched ref
  const mod = await import("@/components/notebooks/notebooks-sidebar");
  NotebooksSidebar = mod.NotebooksSidebar;
});

describe("NotebooksSidebar", () => {
  it("shows loading state initially", async () => {
    // Make fetch hang forever so we can see the loading state
    mockFetch.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={vi.fn()} />);
    });

    expect(screen.getByTestId("sidebar-skeleton")).toBeInTheDocument();
  });

  it("renders notebooks after loading", async () => {
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Notes")).toBeInTheDocument();
      expect(screen.getByText("Work")).toBeInTheDocument();
    });
  });

  it("shows the Notebooks heading", async () => {
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Notebooks")).toBeInTheDocument();
    });
  });

  it("has a new notebook button", async () => {
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("New notebook")).toBeInTheDocument();
    });
  });

  it("selects first notebook on load when none selected", async () => {
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("nb-1");
    });
  });

  it("does not auto-select when a notebook is already selected", async () => {
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-2" onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Notes")).toBeInTheDocument();
    });

    // onSelectNotebook should not have been called since a notebook was already selected
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("highlights the selected notebook", async () => {
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Notes")).toBeInTheDocument();
    });

    const selectedItem = screen.getByText("Notes").closest("[role='button']");
    expect(selectedItem).toHaveAttribute("data-testid", "notebook-item-active");
  });

  it("calls onSelectNotebook when a notebook is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Work")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Work"));

    expect(onSelect).toHaveBeenCalledWith("nb-2");
  });

  it("shows create input when new notebook button is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("New notebook")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("New notebook"));

    expect(screen.getByPlaceholderText("Notebook name")).toBeInTheDocument();
  });

  it("creates a notebook when name is typed and Enter is pressed", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const newNotebook = {
      id: "nb-3",
      name: "New Notebook",
      created_at: "2026-02-25",
      updated_at: "2026-02-25",
    };

    // First call: initial load. Second call: POST to create.
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockNotebooks),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(newNotebook),
      });

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("New notebook")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("New notebook"));
    const input = screen.getByPlaceholderText("Notebook name");
    await user.type(input, "New Notebook{Enter}");

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/notebooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Notebook" }),
      });
    });
  });

  it("has a delete button for each notebook", async () => {
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Delete Notes")).toBeInTheDocument();
      expect(screen.getByLabelText("Delete Work")).toBeInTheDocument();
    });
  });

  it("deletes a notebook after confirmation", async () => {
    routeFetch();
    const onSelect = vi.fn();

    const { user, deleteButton } = await openDeleteConfirmForNotes(onSelect);

    // The confirm can be accepted once the delete check has settled
    await waitFor(() => {
      expect(deleteButton).toBeEnabled();
    });
    await user.click(deleteButton);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-1", { method: "DELETE" });
    });

    // After deleting the selected notebook, onSelectNotebook(null) should be called
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(null);
    });
  });

  it("warns that trashed notes will be permanently deleted for a notebook holding only trashed notes", async () => {
    routeFetch({ trashed: [trashedNote("t-1", "nb-1"), trashedNote("t-2", "nb-2")] });

    const { dialog, deleteButton } = await openDeleteConfirmForNotes();

    expect(await within(dialog).findByText(TRASHED_NOTES_WARNING)).toBeInTheDocument();
    expect(deleteButton).toBeEnabled();
    expect(mockFetch).toHaveBeenCalledWith("/api/notes/trash");
    expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-1/notes");
  });

  it("does not warn about trashed notes for an empty notebook", async () => {
    // Only another notebook has trashed notes
    routeFetch({ trashed: [trashedNote("t-1", "nb-2")] });

    const { dialog, deleteButton } = await openDeleteConfirmForNotes();

    await waitFor(() => {
      expect(deleteButton).toBeEnabled();
    });
    expect(within(dialog).queryByText(TRASHED_NOTES_WARNING)).not.toBeInTheDocument();
  });

  it("does not warn for a notebook with active notes, and confirming still shows the API's refusal", async () => {
    const refusal = "Cannot delete notebook with notes. Move or delete notes first.";
    routeFetch({
      trashed: [trashedNote("t-1", "nb-1")],
      activeByNotebook: {
        "nb-1": [{ id: "n-1", title: "Live", created_at: "2026-09-01", updated_at: "2026-09-01" }],
      },
      deleteResponse: jsonResponse({ error: refusal }, 409),
    });
    const onSelect = vi.fn();

    const { user, dialog, deleteButton } = await openDeleteConfirmForNotes(onSelect);

    await waitFor(() => {
      expect(deleteButton).toBeEnabled();
    });
    expect(within(dialog).queryByText(TRASHED_NOTES_WARNING)).not.toBeInTheDocument();

    await user.click(deleteButton);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(refusal);
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalledWith(null);
  });

  it("warns instead of deleting when the notebook gained trashed notes while the confirm was open", async () => {
    routeFetch();
    const onSelect = vi.fn();

    const { user, dialog, deleteButton } = await openDeleteConfirmForNotes(onSelect);
    await waitFor(() => {
      expect(deleteButton).toBeEnabled();
    });
    expect(within(dialog).queryByText(TRASHED_NOTES_WARNING)).not.toBeInTheDocument();

    // A note in "Notes" is trashed beside the open confirm. The check made as the user
    // confirms is held open, to see Delete busy meanwhile.
    let answerTrash: (res: FakeResponse) => void = () => {};
    routeFetch({
      trashed: new Promise<FakeResponse>((resolve) => {
        answerTrash = resolve;
      }),
    });
    await user.click(deleteButton);

    expect(deleteButton).toBeDisabled();
    answerTrash(jsonResponse([trashedNote("t-1", "nb-1")]));

    expect(await within(dialog).findByText(TRASHED_NOTES_WARNING)).toBeInTheDocument();
    await waitFor(() => {
      expect(deleteButton).toBeEnabled();
    });
    expect(mockFetch).not.toHaveBeenCalledWith("/api/notebooks/nb-1", { method: "DELETE" });

    // Confirming again, with the warning on show, deletes the notebook.
    routeFetch({ trashed: [trashedNote("t-1", "nb-1")] });
    await user.click(deleteButton);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-1", { method: "DELETE" });
    });
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(null);
    });
  });

  it("warns before the retry when the notes behind a refused delete were trashed", async () => {
    const refusal = "Cannot delete notebook with notes. Move or delete notes first.";
    routeFetch({
      trashed: [trashedNote("t-1", "nb-1")],
      activeByNotebook: {
        "nb-1": [{ id: "n-1", title: "Live", created_at: "2026-09-01", updated_at: "2026-09-01" }],
      },
      deleteResponse: jsonResponse({ error: refusal }, 409),
    });

    const { user, dialog, deleteButton } = await openDeleteConfirmForNotes();
    await waitFor(() => {
      expect(deleteButton).toBeEnabled();
    });
    await user.click(deleteButton);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(refusal);
    expect(within(dialog).queryByText(TRASHED_NOTES_WARNING)).not.toBeInTheDocument();

    // As the 409 asks, the live note is trashed, and the user tries again.
    routeFetch({ trashed: [trashedNote("t-1", "nb-1"), trashedNote("n-1", "nb-1")] });
    await user.click(deleteButton);

    expect(await within(dialog).findByText(TRASHED_NOTES_WARNING)).toBeInTheDocument();
    const deletes = mockFetch.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deletes).toHaveLength(1);
  });

  it("sends no DELETE when the confirm is cancelled during the confirm-time check", async () => {
    routeFetch({ trashed: [trashedNote("t-1", "nb-1")] });

    const { user, dialog, deleteButton } = await openDeleteConfirmForNotes();
    expect(await within(dialog).findByText(TRASHED_NOTES_WARNING)).toBeInTheDocument();

    let answerTrash: (res: FakeResponse) => void = () => {};
    routeFetch({
      trashed: new Promise<FakeResponse>((resolve) => {
        answerTrash = resolve;
      }),
    });
    await user.click(deleteButton);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await act(async () => {
      answerTrash(jsonResponse([trashedNote("t-1", "nb-1")]));
    });

    expect(mockFetch).not.toHaveBeenCalledWith("/api/notebooks/nb-1", { method: "DELETE" });
    expect(screen.getByText("Notes")).toBeInTheDocument();
  });

  it("sends no DELETE when the confirm moves to another notebook during the confirm-time check", async () => {
    routeFetch();

    const { user, deleteButton } = await openDeleteConfirmForNotes();
    await waitFor(() => {
      expect(deleteButton).toBeEnabled();
    });

    // "Notes"'s confirm-time check, and "Work"'s first check, wait on the same trash list.
    let answerTrash: (res: FakeResponse) => void = () => {};
    routeFetch({
      trashed: new Promise<FakeResponse>((resolve) => {
        answerTrash = resolve;
      }),
    });
    await user.click(deleteButton);
    await user.click(screen.getByLabelText("Delete Work"));

    await act(async () => {
      answerTrash(jsonResponse([]));
    });

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAccessibleName('Delete "Work"?');
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Delete" })).toBeEnabled();
    });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalledWith("/api/notebooks/nb-1", { method: "DELETE" });
    expect(screen.getByText("Notes")).toBeInTheDocument();
  });

  it("keeps Delete disabled while the delete check is pending", async () => {
    routeFetch({ trashed: new Promise<FakeResponse>(() => {}) });

    const { user, dialog, deleteButton } = await openDeleteConfirmForNotes();

    expect(deleteButton).toBeDisabled();
    expect(within(dialog).queryByText(TRASHED_NOTES_WARNING)).not.toBeInTheDocument();

    await user.click(deleteButton);

    expect(mockFetch).not.toHaveBeenCalledWith("/api/notebooks/nb-1", { method: "DELETE" });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("enters edit mode on double-click and renames on Enter", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const renamedNotebook = {
      id: "nb-2",
      name: "Renamed",
      created_at: "2026-01-02",
      updated_at: "2026-02-25",
    };

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockNotebooks),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(renamedNotebook),
      });

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Work")).toBeInTheDocument();
    });

    // Double-click to enter edit mode
    await user.dblClick(screen.getByText("Work"));

    // An input should appear with the current name
    const input = screen.getByDisplayValue("Work");
    expect(input).toBeInTheDocument();

    // Clear and type new name, then press Enter
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-2", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      });
    });
  });

  it("selects notebook on keyboard Enter/Space", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Work")).toBeInTheDocument();
    });

    // Focus and press Enter on the "Work" notebook button
    const workButton = screen.getByText("Work").closest("[role='button']") as HTMLElement;
    workButton.focus();
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith("nb-2");
  });

  it("cancels create on Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("New notebook")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("New notebook"));
    expect(screen.getByPlaceholderText("Notebook name")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByPlaceholderText("Notebook name")).not.toBeInTheDocument();
  });

  it("cancels create on blur with empty name", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("New notebook")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("New notebook"));
    const input = screen.getByPlaceholderText("Notebook name");

    // Blur with empty input — should cancel creation
    await act(async () => {
      input.blur();
    });

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Notebook name")).not.toBeInTheDocument();
    });
  });

  it("fetches from /api/notebooks on mount", async () => {
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/notebooks");
    });
  });

  it("skips client fetch when initialNotebooks are provided", async () => {
    mockFetch.mockReset();

    await act(async () => {
      render(
        <NotebooksSidebar
          selectedNotebookId="nb-1"
          onSelectNotebook={vi.fn()}
          initialNotebooks={mockNotebooks}
        />,
      );
    });

    // Should render notebooks immediately without fetching
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-skeleton")).not.toBeInTheDocument();

    // Should NOT have made a fetch call
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("renders without loading state when initialNotebooks are provided", async () => {
    await act(async () => {
      render(
        <NotebooksSidebar
          selectedNotebookId={null}
          onSelectNotebook={vi.fn()}
          initialNotebooks={mockNotebooks}
        />,
      );
    });

    // Should show notebooks heading immediately (no skeleton)
    expect(screen.getByRole("heading", { name: /notebooks/i })).toBeInTheDocument();
  });
});
