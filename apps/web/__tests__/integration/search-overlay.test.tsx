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
    expect(screen.getByPlaceholderText("Search notes and notebooks...")).toBeInTheDocument();
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

    await user.type(screen.getByPlaceholderText("Search notes and notebooks..."), "meeting");

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

    await user.type(screen.getByPlaceholderText("Search notes and notebooks..."), "nonexistent");
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

    await user.type(screen.getByPlaceholderText("Search notes and notebooks..."), "meeting");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("Meeting Notes")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Meeting Notes"));
    expect(onSelectNote).toHaveBeenCalledWith("note-1", "nb-1", false);

    vi.useRealTimers();
  });

  it("navigates results with keyboard arrows and selects with Enter", async () => {
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

    await user.type(screen.getByPlaceholderText("Search notes and notebooks..."), "meeting");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("Meeting Notes")).toBeInTheDocument();
    });

    // Arrow down to second result
    await user.keyboard("{ArrowDown}");
    // Arrow up back to first
    await user.keyboard("{ArrowUp}");
    // Select with Enter
    await user.keyboard("{Enter}");

    expect(onSelectNote).toHaveBeenCalledWith("note-1", "nb-1", false);

    vi.useRealTimers();
  });

  it("closes overlay on Escape key", async () => {
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

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("handles fetch error gracefully", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockFetch.mockRejectedValue(new Error("Network error"));

    render(
      <SearchOverlay
        open={true}
        onClose={vi.fn()}
        onSelectNote={vi.fn()}
        notebooks={mockNotebooks}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search notes and notebooks..."), "test");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("No notes found")).toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it("handles non-ok response gracefully", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    render(
      <SearchOverlay
        open={true}
        onClose={vi.fn()}
        onSelectNote={vi.fn()}
        notebooks={mockNotebooks}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search notes and notebooks..."), "test");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("No notes found")).toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it("selects second result with ArrowDown + Enter", async () => {
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

    await user.type(screen.getByPlaceholderText("Search notes and notebooks..."), "meeting");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("Meeting Notes")).toBeInTheDocument();
    });

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(onSelectNote).toHaveBeenCalledWith("note-2", "nb-2", true);

    vi.useRealTimers();
  });

  it("shows 'Untitled' for notes without title and 'Unknown' for missing notebooks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: "note-x",
            title: "",
            notebook_id: "nb-unknown",
            is_trashed: false,
            trashed_at: null,
            updated_at: "2026-03-14T00:00:00Z",
            content_snippet: "",
          },
        ]),
    });

    render(
      <SearchOverlay
        open={true}
        onClose={vi.fn()}
        onSelectNote={vi.fn()}
        notebooks={mockNotebooks}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search notes and notebooks..."), "test");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("Untitled")).toBeInTheDocument();
    });
    expect(screen.getByText("Unknown")).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("does not go below index 0 on ArrowUp at first result", async () => {
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

    await user.type(screen.getByPlaceholderText("Search notes and notebooks..."), "meeting");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("Meeting Notes")).toBeInTheDocument();
    });

    // ArrowUp at index 0 should stay at 0
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Enter}");

    expect(onSelectNote).toHaveBeenCalledWith("note-1", "nb-1", false);

    vi.useRealTimers();
  });

  it("does not go beyond last index on ArrowDown at last result", async () => {
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

    await user.type(screen.getByPlaceholderText("Search notes and notebooks..."), "meeting");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("Meeting Notes")).toBeInTheDocument();
    });

    // Move to last result
    await user.keyboard("{ArrowDown}");
    // ArrowDown again should stay at last
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    // Should select the second (last) result
    expect(onSelectNote).toHaveBeenCalledWith("note-2", "nb-2", true);

    vi.useRealTimers();
  });

  it("closes overlay when clicking backdrop", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    const { container } = render(
      <SearchOverlay
        open={true}
        onClose={onClose}
        onSelectNote={vi.fn()}
        notebooks={mockNotebooks}
      />,
    );

    // Click the backdrop (aria-hidden div)
    const backdrop = container.querySelector("[aria-hidden='true']");
    if (backdrop) await user.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });
});
