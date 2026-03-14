import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchOverlay } from "@/components/search/search-overlay";

vi.mock("@/lib/handle-auth-error", () => ({
  handleAuthError: () => false,
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const mockNotebooks = [
  { id: "nb-1", name: "Personal" },
  { id: "nb-2", name: "Work" },
];

const mockResults = [
  {
    id: "note-1",
    title: "Meeting Notes",
    notebook_id: "nb-1",
    is_trashed: false,
    trashed_at: null,
    updated_at: "2026-03-14T00:00:00Z",
    content_snippet: "discussed the project roadmap",
  },
  {
    id: "note-2",
    title: "Deleted Draft",
    notebook_id: "nb-2",
    is_trashed: true,
    trashed_at: "2026-03-13T00:00:00Z",
    updated_at: "2026-03-13T00:00:00Z",
    content_snippet: "old draft content",
  },
];

describe("SearchOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResults),
    });
  });

  it("renders nothing when not open", () => {
    const { container } = render(
      <SearchOverlay open={false} onClose={vi.fn()} onSelectNote={vi.fn()} notebooks={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders input when open", () => {
    render(
      <SearchOverlay
        open={true}
        onClose={vi.fn()}
        onSelectNote={vi.fn()}
        notebooks={mockNotebooks}
      />,
    );
    expect(screen.getByPlaceholderText("Search notes...")).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SearchOverlay
        open={true}
        onClose={onClose}
        onSelectNote={vi.fn()}
        notebooks={mockNotebooks}
      />,
    );
    await user.click(screen.getByLabelText("Close search"));
    expect(onClose).toHaveBeenCalled();
  });

  it("fetches and displays search results after debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <SearchOverlay
        open={true}
        onClose={vi.fn()}
        onSelectNote={vi.fn()}
        notebooks={mockNotebooks}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search notes..."), "meeting");

    // Advance past debounce
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("Meeting Notes")).toBeInTheDocument();
    });

    // Notebook badge
    expect(screen.getByText("Personal")).toBeInTheDocument();

    // Trash badge on trashed note
    expect(screen.getByText("Trash")).toBeInTheDocument();
    expect(screen.getByText("Deleted Draft")).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("shows 'No notes found' when results are empty", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    render(
      <SearchOverlay
        open={true}
        onClose={vi.fn()}
        onSelectNote={vi.fn()}
        notebooks={mockNotebooks}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search notes..."), "nonexistent");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("No notes found")).toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it("calls onSelectNote when a result is clicked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSelectNote = vi.fn();

    render(
      <SearchOverlay
        open={true}
        onClose={vi.fn()}
        onSelectNote={onSelectNote}
        notebooks={mockNotebooks}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search notes..."), "meeting");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("Meeting Notes")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Meeting Notes"));
    expect(onSelectNote).toHaveBeenCalledWith("note-1", "nb-1", false);

    vi.useRealTimers();
  });
});
