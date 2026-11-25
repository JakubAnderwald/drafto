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

vi.mock("@/lib/report-error", () => ({ reportError: vi.fn() }));

const mockNotebooks = [
  { id: "nb-1", name: "Notes", created_at: "2026-01-01", updated_at: "2026-01-01", note_count: 3 },
  { id: "nb-2", name: "Work", created_at: "2026-01-02", updated_at: "2026-01-02", note_count: 1 },
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
let reportError: typeof import("@/lib/report-error").reportError;

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
  // resetModules gives the sidebar a fresh report-error mock too; assert against that one.
  ({ reportError } = await import("@/lib/report-error"));
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

  it("shows the delete button without hover on a touch-only pointer", async () => {
    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={vi.fn()} />);
    });

    // jsdom applies no CSS, so this checks the class; the Playwright Tablet
    // project (e2e/responsive.spec.ts) checks the computed opacity.
    await waitFor(() => {
      expect(screen.getByLabelText("Delete Work")).toHaveClass("[@media(hover:none)]:opacity-100");
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

describe("NotebooksSidebar — duplicate names (PrimeTestLab 11035 M-01)", () => {
  const DUPLICATE_WORK = 'A notebook named "Work" already exists. Choose a different name.';

  async function renderSidebar() {
    const user = userEvent.setup();
    await act(async () => {
      render(
        <NotebooksSidebar
          selectedNotebookId="nb-1"
          onSelectNotebook={vi.fn()}
          initialNotebooks={mockNotebooks}
        />,
      );
    });
    return user;
  }

  it("refuses a taken name before sending it, ignoring case, and keeps the field open", async () => {
    const user = await renderSidebar();

    await user.click(screen.getByLabelText("New notebook"));
    const input = screen.getByPlaceholderText("Notebook name");
    await user.type(input, "  work {Enter}");

    expect(screen.getByRole("alert")).toHaveTextContent(DUPLICATE_WORK);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", "notebook-create-name-error");
    expect(document.getElementById("notebook-create-name-error")).toHaveTextContent(DUPLICATE_WORK);
    expect(mockFetch).not.toHaveBeenCalled();

    // Leaving the field doesn't send the refused name or close it.
    await act(async () => {
      input.blur();
    });
    expect(screen.getByPlaceholderText("Notebook name")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();

    // Editing the name clears the error.
    await user.type(input, "s");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the API's 409 under the field and keeps it open", async () => {
    const user = await renderSidebar();
    const message = 'A notebook named "Ideas" already exists. Choose a different name.';
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: message, status: 409 }, 409));

    await user.click(screen.getByLabelText("New notebook"));
    await user.type(screen.getByPlaceholderText("Notebook name"), "Ideas{Enter}");

    await waitFor(() => {
      expect(screen.getByTestId("notebook-name-error")).toHaveTextContent(message);
    });
    expect(screen.getByPlaceholderText("Notebook name")).toHaveValue("Ideas");
    expect(screen.queryByText("Ideas")).not.toBeInTheDocument();
  });

  it("shows a generic error when the create fails without a message", async () => {
    const user = await renderSidebar();
    mockFetch.mockResolvedValueOnce(jsonResponse(null, 500));

    await user.click(screen.getByLabelText("New notebook"));
    await user.type(screen.getByPlaceholderText("Notebook name"), "Ideas{Enter}");

    await waitFor(() => {
      expect(screen.getByTestId("notebook-name-error")).toHaveTextContent(
        "Failed to create notebook",
      );
    });
  });

  it("refuses to rename a notebook to another notebook's name", async () => {
    const user = await renderSidebar();

    await user.dblClick(screen.getByText("Notes"));
    const input = screen.getByDisplayValue("Notes");
    await user.clear(input);
    await user.type(input, "WORK{Enter}");

    expect(screen.getByRole("alert")).toHaveTextContent(DUPLICATE_WORK);
    expect(screen.getByDisplayValue("WORK")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
  });

  it("shows the API's rename refusal under the field and keeps it open", async () => {
    const user = await renderSidebar();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: "Failed to update notebook", status: 404 }, 404),
    );

    await user.dblClick(screen.getByText("Notes"));
    const input = screen.getByDisplayValue("Notes");
    await user.clear(input);
    await user.type(input, "Journal{Enter}");

    await waitFor(() => {
      expect(screen.getByTestId("notebook-name-error")).toHaveTextContent(
        "Failed to update notebook",
      );
    });
    expect(screen.getByDisplayValue("Journal")).toBeInTheDocument();
  });

  it("opens the next rename without the last one's error, and saves it on blur", async () => {
    const user = await renderSidebar();

    await user.dblClick(screen.getByText("Notes"));
    const input = screen.getByDisplayValue("Notes");
    await user.clear(input);
    await user.type(input, "WORK{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(DUPLICATE_WORK);

    // Double-clicking another notebook leaves the refused field and opens a clean one.
    await user.dblClick(screen.getByText("Work"));
    const workInput = screen.getByDisplayValue("Work");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(workInput).not.toHaveAttribute("aria-invalid");
    expect(mockFetch).not.toHaveBeenCalled();

    mockFetch.mockResolvedValueOnce(jsonResponse({ ...mockNotebooks[1], name: "Office" }));
    await user.clear(workInput);
    await user.type(workInput, "Office");
    await act(async () => {
      workInput.blur();
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/notebooks/nb-2",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Office" }) }),
      );
    });
  });

  it("gives a refused create and a refused rename their own error ids", async () => {
    const user = await renderSidebar();

    await user.click(screen.getByLabelText("New notebook"));
    const createInput = screen.getByPlaceholderText("Notebook name");
    await user.type(createInput, "Work{Enter}");

    await user.dblClick(screen.getByText("Notes"));
    const renameInput = screen.getByDisplayValue("Notes");
    await user.clear(renameInput);
    await user.type(renameInput, "Work{Enter}");

    expect(screen.getAllByRole("alert")).toHaveLength(2);
    const createErrorId = createInput.getAttribute("aria-describedby");
    const renameErrorId = renameInput.getAttribute("aria-describedby");
    expect(createErrorId).toBeTruthy();
    expect(renameErrorId).toBeTruthy();
    expect(createErrorId).not.toBe(renameErrorId);
    expect(document.querySelectorAll(`[id="${createErrorId}"]`)).toHaveLength(1);
    expect(document.querySelectorAll(`[id="${renameErrorId}"]`)).toHaveLength(1);
  });

  it("PrimeTestLab 11035 review: renames while a create is still pending, and never sends a create twice", async () => {
    const user = await renderSidebar();
    let finishCreate: (response: FakeResponse) => void = () => {};
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Promise<FakeResponse>((resolve) => {
          finishCreate = resolve;
        });
      }
      if (init?.method === "PATCH" && url === "/api/notebooks/nb-1") {
        return Promise.resolve(jsonResponse({ ...mockNotebooks[0], name: "Journal" }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await user.click(screen.getByLabelText("New notebook"));
    const createInput = screen.getByPlaceholderText("Notebook name");
    await user.type(createInput, "Ideas{Enter}");
    // A second Enter on the pending create is ignored.
    await user.type(createInput, "{Enter}");

    await user.dblClick(screen.getByText("Notes"));
    const renameInput = screen.getByDisplayValue("Notes");
    await user.clear(renameInput);
    await user.type(renameInput, "Journal{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Journal")).toBeInTheDocument();
    });
    const methods = mockFetch.mock.calls.map(([, init]) => (init as RequestInit).method);
    expect(methods.filter((method) => method === "POST")).toHaveLength(1);
    expect(methods.filter((method) => method === "PATCH")).toHaveLength(1);

    await act(async () => {
      finishCreate(
        jsonResponse({
          id: "nb-3",
          name: "Ideas",
          created_at: "2026-03-01",
          updated_at: "2026-03-01",
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Ideas")).toBeInTheDocument();
    });
  });

  it("PrimeTestLab 11035 CodeRabbit: a pending rename's answer stays with its own field", async () => {
    const user = await renderSidebar();
    let finishNotes: (response: FakeResponse) => void = () => {};
    let finishWork: (response: FakeResponse) => void = () => {};
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url === "/api/notebooks/nb-1") {
        return new Promise<FakeResponse>((resolve) => {
          finishNotes = resolve;
        });
      }
      if (init?.method === "PATCH" && url === "/api/notebooks/nb-2") {
        return new Promise<FakeResponse>((resolve) => {
          finishWork = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await user.dblClick(screen.getByText("Notes"));
    const notesInput = screen.getByDisplayValue("Notes");
    await user.clear(notesInput);
    await user.type(notesInput, "Journal{Enter}");

    // While the first rename is pending, another notebook's rename is opened and submitted.
    await user.dblClick(screen.getByText("Work"));
    const workInput = screen.getByDisplayValue("Work");
    await user.clear(workInput);
    await user.type(workInput, "Office{Enter}");

    const patched = mockFetch.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
      .map(([url]) => url);
    expect(patched).toEqual(["/api/notebooks/nb-1", "/api/notebooks/nb-2"]);

    // The first rename's refusal is not shown under the second field, which stays open.
    await act(async () => {
      finishNotes(jsonResponse({ error: "Failed to update notebook", status: 404 }, 404));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Office")).toBeInTheDocument();

    await act(async () => {
      finishWork(jsonResponse({ ...mockNotebooks[1], name: "Office" }));
    });
    await waitFor(() => {
      expect(screen.queryByDisplayValue("Office")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Office")).toBeInTheDocument();
  });

  it("PrimeTestLab 11035 CodeRabbit: a create refused after its field was reopened leaves the new field alone", async () => {
    const user = await renderSidebar();
    const finishCreates: Array<(response: FakeResponse) => void> = [];
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url === "/api/notebooks") {
        return new Promise<FakeResponse>((resolve) => {
          finishCreates.push(resolve);
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await user.click(screen.getByLabelText("New notebook"));
    await user.type(screen.getByPlaceholderText("Notebook name"), "Ideas{Enter}");
    await user.keyboard("{Escape}");
    await user.click(screen.getByLabelText("New notebook"));
    const reopened = screen.getByPlaceholderText("Notebook name");
    expect(reopened).toHaveValue("");

    await act(async () => {
      finishCreates[0](jsonResponse(null, 500));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(reopened).not.toHaveAttribute("aria-invalid");

    // The reopened field still submits on blur: no stale error holds it back.
    await user.type(reopened, "Plans");
    await act(async () => {
      reopened.blur();
    });
    expect(finishCreates).toHaveLength(2);
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/api/notebooks",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Plans" }) }),
    );
  });

  it("lets a notebook change only the case of its own name, keeping its count", async () => {
    const user = await renderSidebar();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ...mockNotebooks[0], name: "NOTES", updated_at: "2026-02-25" }),
    );

    await user.dblClick(screen.getByText("Notes"));
    const input = screen.getByDisplayValue("Notes");
    await user.clear(input);
    await user.type(input, "NOTES{Enter}");

    await waitFor(() => {
      expect(screen.getByText("NOTES")).toBeInTheDocument();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("NOTES").closest("[role='button']")).toHaveTextContent("3 notes");
  });
});

describe("NotebooksSidebar — note counts (PrimeTestLab 11035 S-03)", () => {
  it("shows each notebook's note count from the server prefetch", async () => {
    await act(async () => {
      render(
        <NotebooksSidebar
          selectedNotebookId="nb-1"
          onSelectNotebook={vi.fn()}
          initialNotebooks={mockNotebooks}
        />,
      );
    });

    const counts = screen.getAllByTestId("notebook-note-count").map((el) => el.textContent);
    expect(counts).toEqual(["3 notes", "1 note"]);
  });

  it("keeps the name in its own element, apart from the count", async () => {
    // E2E helpers read the active notebook's name from it (apps/web/e2e/notes.spec.ts).
    await act(async () => {
      render(
        <NotebooksSidebar
          selectedNotebookId="nb-1"
          onSelectNotebook={vi.fn()}
          initialNotebooks={mockNotebooks}
        />,
      );
    });

    const active = screen.getByTestId("notebook-item-active");
    expect(active).toHaveTextContent("3 notes");
    expect(within(active).getByTestId("notebook-name").textContent).toBe("Notes");
  });

  it("refetches the counts when the lists refresh", async () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <NotebooksSidebar
        selectedNotebookId="nb-1"
        onSelectNotebook={onSelect}
        initialNotebooks={mockNotebooks}
      />,
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { ...mockNotebooks[0], note_count: 4 },
        { ...mockNotebooks[1], note_count: 0 },
      ]),
    );

    rerender(
      <NotebooksSidebar
        selectedNotebookId="nb-1"
        onSelectNotebook={onSelect}
        initialNotebooks={mockNotebooks}
        refreshTrigger={1}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("notebook-note-count").map((el) => el.textContent)).toEqual([
        "4 notes",
        "0 notes",
      ]);
    });
    expect(mockFetch).toHaveBeenCalledWith("/api/notebooks");
  });

  it("shows an error with Retry when the notebooks fail to load, and Retry loads them", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />);
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load your notebooks.");
    expect(screen.queryByText(/No notebooks yet/)).not.toBeInTheDocument();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), "notebooks-sidebar:load", {
      extra: { status: 500 },
    });

    mockFetch.mockResolvedValueOnce(jsonResponse(mockNotebooks));
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText("Notes")).toBeInTheDocument();
      expect(screen.getByText("Work")).toBeInTheDocument();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith("nb-1");
  });

  it("doesn't move a user out of Trash when a Retry succeeds", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));

    let rerender: ReturnType<typeof render>["rerender"] = () => {};
    await act(async () => {
      ({ rerender } = render(
        <NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />,
      ));
    });
    const alert = await screen.findByRole("alert");

    // The user opens Trash, then retries.
    await act(async () => {
      rerender(
        <NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} isTrashSelected />,
      );
    });
    mockFetch.mockResolvedValueOnce(jsonResponse(mockNotebooks));
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText("Work")).toBeInTheDocument();
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows the error state and reports when the notebooks request throws", async () => {
    const networkError = new TypeError("Failed to fetch");
    mockFetch.mockRejectedValueOnce(networkError);

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={vi.fn()} />);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load your notebooks.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(reportError).toHaveBeenCalledWith(networkError, "notebooks-sidebar:load");
  });

  it("keeps the list on show and only reports when a refresh fails", async () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <NotebooksSidebar
        selectedNotebookId="nb-1"
        onSelectNotebook={onSelect}
        initialNotebooks={mockNotebooks}
      />,
    );
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 503));

    rerender(
      <NotebooksSidebar
        selectedNotebookId="nb-1"
        onSelectNotebook={onSelect}
        initialNotebooks={mockNotebooks}
        refreshTrigger={1}
      />,
    );

    await waitFor(() => {
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), "notebooks-sidebar:load", {
        extra: { status: 503 },
      });
    });
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your notebooks.")).not.toBeInTheDocument();
  });

  it("applies only the newest load when an older one settles after it", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={vi.fn()} />);
    });
    const retry = within(await screen.findByRole("alert")).getByRole("button", { name: "Retry" });

    // Two Retries in flight: the newer one finds no notebooks, then the older one fails.
    let settleOlder: (res: FakeResponse) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise<FakeResponse>((resolve) => {
        settleOlder = resolve;
      }),
    );
    mockFetch.mockResolvedValueOnce(jsonResponse([]));
    await user.click(retry);
    await user.click(retry);

    await waitFor(() => {
      expect(screen.getByText(/No notebooks yet/)).toBeInTheDocument();
    });
    await act(async () => {
      settleOlder(jsonResponse({ error: "boom" }, 500));
    });

    // The older failure is still reported, but the error state follows the newest load.
    await waitFor(() => {
      expect(reportError).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/No notebooks yet/)).toBeInTheDocument();
  });

  it("still opens the first notebook when a refresh replaces the first load", async () => {
    const onSelect = vi.fn();
    let settleFirst: (res: FakeResponse) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise<FakeResponse>((resolve) => {
        settleFirst = resolve;
      }),
    );
    mockFetch.mockResolvedValueOnce(jsonResponse(mockNotebooks));

    let rerender: ReturnType<typeof render>["rerender"] = () => {};
    await act(async () => {
      ({ rerender } = render(
        <NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />,
      ));
    });
    await act(async () => {
      rerender(
        <NotebooksSidebar
          selectedNotebookId={null}
          onSelectNotebook={onSelect}
          refreshTrigger={1}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Work")).toBeInTheDocument();
    });
    expect(onSelect).toHaveBeenCalledWith("nb-1");

    // The first load settles last; its empty list doesn't replace the newer one.
    await act(async () => {
      settleFirst(jsonResponse([]));
    });
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("starts a new notebook at 0 notes", async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(
        <NotebooksSidebar
          selectedNotebookId="nb-1"
          onSelectNotebook={vi.fn()}
          initialNotebooks={mockNotebooks}
        />,
      );
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        id: "nb-3",
        name: "Ideas",
        created_at: "2026-03-01",
        updated_at: "2026-03-01",
      }),
    );

    await user.click(screen.getByLabelText("New notebook"));
    await user.type(screen.getByPlaceholderText("Notebook name"), "Ideas{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Ideas").closest("[role='button']")).toHaveTextContent("0 notes");
    });
  });
});

const NETWORK_ERROR = "Network error. Please try again.";

/** The notebook rows' names, top to bottom, as the sidebar shows them. */
function renderedNotebookNames(): string[] {
  return screen.getAllByTestId("notebook-name").map((el) => el.textContent ?? "");
}

/** The fetch calls sent with `method`. */
function fetchCallsWithMethod(method: string) {
  return mockFetch.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === method,
  );
}

interface SidebarNotebook {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  note_count?: number;
}

/** Renders the sidebar from a server prefetch, so no initial GET is sent. */
async function renderSidebarWith(initialNotebooks: SidebarNotebook[], onNotebooksChange = vi.fn()) {
  const user = userEvent.setup();
  await act(async () => {
    render(
      <NotebooksSidebar
        selectedNotebookId={initialNotebooks[0]?.id ?? null}
        onSelectNotebook={vi.fn()}
        onNotebooksChange={onNotebooksChange}
        initialNotebooks={initialNotebooks}
      />,
    );
  });
  return { user, onNotebooksChange };
}

describe("NotebooksSidebar — one request per create or rename (issue 480)", () => {
  it("sends one POST when the create field is left after Enter while the POST is pending", async () => {
    const { user } = await renderSidebarWith(mockNotebooks);
    let finishCreate: (response: FakeResponse) => void = () => {};
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url === "/api/notebooks") {
        return new Promise<FakeResponse>((resolve) => {
          finishCreate = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await user.click(screen.getByLabelText("New notebook"));
    const input = screen.getByPlaceholderText("Notebook name");
    await user.type(input, "Ideas{Enter}");
    // Leaving the field while its create is in flight doesn't send the name again.
    await act(async () => {
      input.blur();
    });
    expect(input).not.toHaveFocus();
    expect(fetchCallsWithMethod("POST")).toHaveLength(1);

    await act(async () => {
      finishCreate(
        jsonResponse({
          id: "nb-3",
          name: "Ideas",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Ideas")).toBeInTheDocument();
    });
    expect(screen.queryByPlaceholderText("Notebook name")).not.toBeInTheDocument();
    expect(fetchCallsWithMethod("POST")).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends one PATCH when the rename field is left after Enter while the PATCH is pending", async () => {
    const { user } = await renderSidebarWith(mockNotebooks);
    let finishRename: (response: FakeResponse) => void = () => {};
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url === "/api/notebooks/nb-1") {
        return new Promise<FakeResponse>((resolve) => {
          finishRename = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await user.dblClick(screen.getByText("Notes"));
    const input = screen.getByDisplayValue("Notes");
    await user.clear(input);
    await user.type(input, "Journal{Enter}");
    await act(async () => {
      input.blur();
    });
    expect(input).not.toHaveFocus();
    expect(fetchCallsWithMethod("PATCH")).toHaveLength(1);

    await act(async () => {
      finishRename(
        jsonResponse({ ...mockNotebooks[0], name: "Journal", updated_at: "2026-03-01T00:00:00Z" }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Journal")).toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue("Journal")).not.toBeInTheDocument();
    const patched = fetchCallsWithMethod("PATCH").map(([url]) => url);
    expect(patched).toEqual(["/api/notebooks/nb-1"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("shows the network error under the create field when the POST fails to send", async () => {
    const { user } = await renderSidebarWith(mockNotebooks);
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url === "/api/notebooks") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await user.click(screen.getByLabelText("New notebook"));
    const input = screen.getByPlaceholderText("Notebook name");
    await user.type(input, "Ideas{Enter}");

    const error = await screen.findByTestId("notebook-name-error");
    expect(error).toHaveTextContent(NETWORK_ERROR);
    expect(error).toHaveAttribute("id", "notebook-create-name-error");
    expect(input).toHaveAttribute("aria-describedby", "notebook-create-name-error");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveValue("Ideas");
    expect(renderedNotebookNames()).toEqual(["Notes", "Work"]);

    // Leaving the refused field doesn't resend it.
    await act(async () => {
      input.blur();
    });
    expect(fetchCallsWithMethod("POST")).toHaveLength(1);
  });

  it("shows the network error under the rename field when the PATCH fails to send", async () => {
    const { user } = await renderSidebarWith(mockNotebooks);
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url === "/api/notebooks/nb-1") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await user.dblClick(screen.getByText("Notes"));
    const input = screen.getByDisplayValue("Notes");
    await user.clear(input);
    await user.type(input, "Journal{Enter}");

    const error = await screen.findByTestId("notebook-name-error");
    expect(error).toHaveTextContent(NETWORK_ERROR);
    expect(error).toHaveAttribute("id", "notebook-rename-name-error");
    expect(input).toHaveAttribute("aria-describedby", "notebook-rename-name-error");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByDisplayValue("Journal")).toBeInTheDocument();

    await act(async () => {
      input.blur();
    });
    expect(fetchCallsWithMethod("PATCH")).toHaveLength(1);
  });
});

describe("NotebooksSidebar — newest-first order (issue 480)", () => {
  // As `GET /api/notebooks` and the layout prefetch return them: `updated_at` desc, in
  // PostgREST's `+00:00` microsecond format. Alphabetically they'd be Alpha, Beta, Zeta.
  const ORDERED_NOTEBOOKS: SidebarNotebook[] = [
    {
      id: "nb-z",
      name: "Zeta",
      created_at: "2026-01-03T09:00:00.000000+00:00",
      updated_at: "2026-03-01T10:00:00.123456+00:00",
      note_count: 2,
    },
    {
      id: "nb-b",
      name: "Beta",
      created_at: "2026-01-02T09:00:00.000000+00:00",
      updated_at: "2026-02-15T10:00:00.654321+00:00",
      note_count: 1,
    },
    {
      id: "nb-a",
      name: "Alpha",
      created_at: "2026-01-01T09:00:00.000000+00:00",
      updated_at: "2026-02-01T10:00:00.000000+00:00",
      note_count: 0,
    },
  ];

  // A create's answer: the newest notebook, its name between the others alphabetically.
  const MIDDLE_CREATED: SidebarNotebook = {
    id: "nb-m",
    name: "Middle",
    created_at: "2026-04-01T08:00:00.000000+00:00",
    updated_at: "2026-04-01T08:00:00.000000+00:00",
  };

  function answerCreateWith(created: SidebarNotebook) {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url === "/api/notebooks") {
        return Promise.resolve(jsonResponse(created));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  }

  function answerRenameWith(id: string, renamed: SidebarNotebook) {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url === `/api/notebooks/${id}`) {
        return Promise.resolve(jsonResponse(renamed));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  }

  it("puts a created notebook first by its updated_at, not by its name", async () => {
    const { user, onNotebooksChange } = await renderSidebarWith(ORDERED_NOTEBOOKS);
    expect(renderedNotebookNames()).toEqual(["Zeta", "Beta", "Alpha"]);
    answerCreateWith(MIDDLE_CREATED);

    await user.click(screen.getByLabelText("New notebook"));
    await user.type(screen.getByPlaceholderText("Notebook name"), "Middle{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Middle")).toBeInTheDocument();
    });
    expect(renderedNotebookNames()).toEqual(["Middle", "Zeta", "Beta", "Alpha"]);
    expect(onNotebooksChange).toHaveBeenLastCalledWith([
      { id: "nb-m", name: "Middle" },
      { id: "nb-z", name: "Zeta" },
      { id: "nb-b", name: "Beta" },
      { id: "nb-a", name: "Alpha" },
    ]);
  });

  it("moves a renamed notebook to the top when the rename bumps its updated_at", async () => {
    const { user, onNotebooksChange } = await renderSidebarWith(ORDERED_NOTEBOOKS);
    // The PATCH answer has no count; the row keeps its own.
    answerRenameWith("nb-a", {
      id: "nb-a",
      name: "Omega",
      created_at: ORDERED_NOTEBOOKS[2].created_at,
      updated_at: "2026-04-01T08:00:00.000000+00:00",
    });

    await user.dblClick(screen.getByText("Alpha"));
    const input = screen.getByDisplayValue("Alpha");
    await user.clear(input);
    await user.type(input, "Omega{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Omega")).toBeInTheDocument();
    });
    expect(renderedNotebookNames()).toEqual(["Omega", "Zeta", "Beta"]);
    expect(screen.getByText("Omega").closest("[role='button']")).toHaveTextContent("0 notes");
    expect(onNotebooksChange).toHaveBeenLastCalledWith([
      { id: "nb-a", name: "Omega" },
      { id: "nb-z", name: "Zeta" },
      { id: "nb-b", name: "Beta" },
    ]);
  });

  it("compares a Z timestamp with PostgREST's +00:00 ones as instants", async () => {
    const { user } = await renderSidebarWith(ORDERED_NOTEBOOKS);
    // 10:00:00Z is 0.123456s before Zeta's 10:00:00.123456+00:00, though it sorts after it
    // as a string ('Z' > '.').
    answerRenameWith("nb-b", {
      id: "nb-b",
      name: "Gamma",
      created_at: ORDERED_NOTEBOOKS[1].created_at,
      updated_at: "2026-03-01T10:00:00Z",
    });

    await user.dblClick(screen.getByText("Beta"));
    const input = screen.getByDisplayValue("Beta");
    await user.clear(input);
    await user.type(input, "Gamma{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Gamma")).toBeInTheDocument();
    });
    expect(renderedNotebookNames()).toEqual(["Zeta", "Gamma", "Alpha"]);
  });

  it("keeps the order a create gave the list when the next refetch lands", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const sidebar = (refreshTrigger: number) => (
      <NotebooksSidebar
        selectedNotebookId="nb-z"
        onSelectNotebook={onSelect}
        initialNotebooks={ORDERED_NOTEBOOKS}
        refreshTrigger={refreshTrigger}
      />
    );
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(sidebar(0));
    });

    let answerRefetch: (response: FakeResponse) => void = () => {};
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url === "/api/notebooks") {
        return Promise.resolve(jsonResponse(MIDDLE_CREATED));
      }
      if (init === undefined && url === "/api/notebooks") {
        return new Promise<FakeResponse>((resolve) => {
          answerRefetch = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await user.click(screen.getByLabelText("New notebook"));
    await user.type(screen.getByPlaceholderText("Notebook name"), "Middle{Enter}");
    await waitFor(() => {
      expect(screen.getByText("Middle")).toBeInTheDocument();
    });
    const afterCreate = renderedNotebookNames();
    expect(afterCreate).toEqual(["Middle", "Zeta", "Beta", "Alpha"]);

    view?.rerender(sidebar(1));
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/notebooks");
    });
    // The server's answer: the same rows, `updated_at` desc. Zeta's count changed meanwhile,
    // which shows when the refetch has landed.
    await act(async () => {
      answerRefetch(
        jsonResponse([
          { ...MIDDLE_CREATED, note_count: 0 },
          { ...ORDERED_NOTEBOOKS[0], note_count: 3 },
          ORDERED_NOTEBOOKS[1],
          ORDERED_NOTEBOOKS[2],
        ]),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Zeta").closest("[role='button']")).toHaveTextContent("3 notes");
    });

    expect(renderedNotebookNames()).toEqual(afterCreate);
  });
});
