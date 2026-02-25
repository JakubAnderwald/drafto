import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

// Mock fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { NotebooksSidebar } = await import("@/components/notebooks/notebooks-sidebar");

describe("NotebooksSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockNotebooks),
    });
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

  it("shows Notebooks heading", async () => {
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />);
    });

    expect(screen.getByText("Notebooks")).toBeInTheDocument();
  });

  it("has a new notebook button", async () => {
    const onSelect = vi.fn();

    await act(async () => {
      render(<NotebooksSidebar selectedNotebookId={null} onSelectNotebook={onSelect} />);
    });

    expect(screen.getByLabelText("New notebook")).toBeInTheDocument();
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
});
