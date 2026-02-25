import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

// Re-import the module before each test to reset the internal `hasFetched` ref.
// The component guards fetching with `if (hasFetched.current) return;` so a
// single import shares that ref across all tests.
let NotebooksSidebar: typeof import("@/components/notebooks/notebooks-sidebar").NotebooksSidebar;

beforeEach(async () => {
  vi.clearAllMocks();
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

    expect(screen.getByText("Loading...")).toBeInTheDocument();
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
    expect(selectedItem).toHaveClass("bg-blue-100");
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

  it("deletes a notebook when the delete button is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockNotebooks),
      })
      .mockResolvedValueOnce({ ok: true });

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId="nb-1" onSelectNotebook={onSelect} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Notes")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Delete Notes"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-1", { method: "DELETE" });
    });

    // After deleting the selected notebook, onSelectNotebook(null) should be called
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(null);
    });
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
});
