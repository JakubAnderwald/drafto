import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { act } from "react";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockNotebooks = [
  { id: "nb-1", name: "Personal" },
  { id: "nb-2", name: "Work" },
];

const mockTrashedNotes = [
  {
    id: "note-1",
    title: "Deleted Note A",
    notebook_id: "nb-1",
    trashed_at: new Date().toISOString(),
  },
  {
    id: "note-2",
    title: "Deleted Note B",
    notebook_id: "nb-2",
    trashed_at: new Date().toISOString(),
  },
];

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let TrashList: typeof import("@/components/notes/trash-list").TrashList;

let refreshCounter = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  refreshCounter++;

  mockFetch.mockImplementation((url: string) => {
    if (url === "/api/notes/trash") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockTrashedNotes),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });

  const mod = await import("@/components/notes/trash-list");
  TrashList = mod.TrashList;
});

describe("TrashList", () => {
  it("renders trashed notes with notebook names and trashed dates", async () => {
    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <TrashList
            notebooks={mockNotebooks}
            onRestore={vi.fn()}
            onPermanentDelete={vi.fn()}
            refreshTrigger={refreshCounter}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Deleted Note A")).toBeInTheDocument();
      expect(screen.getByText("Deleted Note B")).toBeInTheDocument();
    });

    // Should show notebook names
    expect(screen.getByText(/Personal/)).toBeInTheDocument();
    expect(screen.getByText(/Work/)).toBeInTheDocument();
  });

  it("shows empty state when trash is empty", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/notes/trash") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <TrashList
            notebooks={mockNotebooks}
            onRestore={vi.fn()}
            onPermanentDelete={vi.fn()}
            refreshTrigger={refreshCounter}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Trash is empty.")).toBeInTheDocument();
    });
  });

  it("calls onRestore when Restore button is clicked", async () => {
    const onRestore = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <TrashList
            notebooks={mockNotebooks}
            onRestore={onRestore}
            onPermanentDelete={vi.fn()}
            refreshTrigger={refreshCounter}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Deleted Note A")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const restoreButtons = screen.getAllByText("Restore");
    await act(async () => {
      await user.click(restoreButtons[0]);
    });

    expect(onRestore).toHaveBeenCalledWith("note-1");
    // Note should be optimistically removed from the list
    expect(screen.queryByText("Deleted Note A")).not.toBeInTheDocument();
  });

  it("calls onPermanentDelete when Delete forever button is clicked", async () => {
    const onPermanentDelete = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <TrashList
            notebooks={mockNotebooks}
            onRestore={vi.fn()}
            onPermanentDelete={onPermanentDelete}
            refreshTrigger={refreshCounter}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Deleted Note B")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const deleteButtons = screen.getAllByText("Delete forever");
    await act(async () => {
      await user.click(deleteButtons[1]);
    });

    expect(onPermanentDelete).toHaveBeenCalledWith("note-2");
    // Note should be optimistically removed
    expect(screen.queryByText("Deleted Note B")).not.toBeInTheDocument();
  });

  it("displays the Trash heading", async () => {
    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <TrashList
            notebooks={mockNotebooks}
            onRestore={vi.fn()}
            onPermanentDelete={vi.fn()}
            refreshTrigger={refreshCounter}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Trash")).toBeInTheDocument();
    });
  });
});
