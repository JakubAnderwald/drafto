import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchOverlay } from "@/components/search/search-overlay";
import { MAX_SEARCH_QUERY_LENGTH } from "@/lib/search-query";

vi.mock("@/lib/handle-auth-error", () => ({
  handleAuthError: () => false,
}));

vi.mock("@/lib/report-error", () => ({ reportError: vi.fn() }));

const { reportError } = await import("@/lib/report-error");

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

  it("caps a pasted query at the length the search route accepts", async () => {
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

    const input = screen.getByPlaceholderText<HTMLInputElement>("Search notes and notebooks...");
    expect(input.maxLength).toBe(MAX_SEARCH_QUERY_LENGTH);

    await user.click(input);
    await user.paste("a".repeat(MAX_SEARCH_QUERY_LENGTH + 50));
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/notes/search?q=${"a".repeat(MAX_SEARCH_QUERY_LENGTH)}`,
        expect.anything(),
      );
    });
    expect(input.value).toHaveLength(MAX_SEARCH_QUERY_LENGTH);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    vi.useRealTimers();
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

  it("says the search failed and reports it when the request throws", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    const networkError = new Error("Network error");
    mockFetch.mockRejectedValue(networkError);

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
      expect(screen.getByRole("alert")).toHaveTextContent("Search failed — try again");
    });
    expect(screen.queryByText("No notes found")).not.toBeInTheDocument();
    expect(reportError).toHaveBeenCalledWith(networkError, "search-overlay");

    vi.useRealTimers();
  });

  it("says the search failed and reports the status on a non-OK response", async () => {
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
      expect(screen.getByText("Search failed — try again")).toBeInTheDocument();
    });
    expect(screen.queryByText("No notes found")).not.toBeInTheDocument();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), "search-overlay", {
      extra: { status: 500 },
    });
    // The report carries the status, never the query text: not in `extra`, not in the message.
    expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toContain("test");
    expect((vi.mocked(reportError).mock.calls[0][0] as Error).message).not.toContain("test");

    vi.useRealTimers();
  });

  it("clears the failure once a later search succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    render(
      <SearchOverlay
        open={true}
        onClose={vi.fn()}
        onSelectNote={vi.fn()}
        notebooks={mockNotebooks}
      />,
    );

    const input = screen.getByPlaceholderText("Search notes and notebooks...");
    await user.type(input, "meet");
    vi.advanceTimersByTime(300);
    await waitFor(() => {
      expect(screen.getByText("Search failed — try again")).toBeInTheDocument();
    });

    await user.type(input, "ing");
    vi.advanceTimersByTime(300);
    await waitFor(() => {
      expect(screen.getByText("Meeting Notes")).toBeInTheDocument();
    });
    expect(screen.queryByText("Search failed — try again")).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it("runs the same search again from Retry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    render(
      <SearchOverlay
        open={true}
        onClose={vi.fn()}
        onSelectNote={vi.fn()}
        notebooks={mockNotebooks}
      />,
    );

    const input = screen.getByPlaceholderText("Search notes and notebooks...");
    await user.type(input, "meeting");
    vi.advanceTimersByTime(300);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Search failed — try again");
    const callsBeforeRetry = mockFetch.mock.calls.length;

    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("Meeting Notes")).toBeInTheDocument();
    });
    expect(screen.queryByText("Search failed — try again")).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    expect(mockFetch).toHaveBeenLastCalledWith("/api/notes/search?q=meeting", expect.anything());
    // Focus goes back to the input, so the user can keep typing.
    expect(input).toHaveFocus();

    vi.useRealTimers();
  });

  it("retries a failed search with Enter", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSelectNote = vi.fn();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

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
    await screen.findByText("Search failed — try again");

    await user.keyboard("{Enter}");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByText("Meeting Notes")).toBeInTheDocument();
    });
    expect(screen.queryByText("Search failed — try again")).not.toBeInTheDocument();
    expect(onSelectNote).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("lets Enter on the Close search and Retry buttons do what the button does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    render(
      <SearchOverlay
        open={true}
        onClose={onClose}
        onSelectNote={vi.fn()}
        notebooks={mockNotebooks}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search notes and notebooks..."), "meeting");
    vi.advanceTimersByTime(300);
    const alert = await screen.findByRole("alert");
    const callsAfterFailure = mockFetch.mock.calls.length;

    // Enter on Close search closes the overlay, and doesn't retry the search.
    screen.getByRole("button", { name: "Close search" }).focus();
    await user.keyboard("{Enter}");
    vi.advanceTimersByTime(300);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(callsAfterFailure);

    // Enter on Retry retries once.
    within(alert).getByRole("button", { name: "Retry" }).focus();
    await user.keyboard("{Enter}");
    vi.advanceTimersByTime(300);
    await waitFor(() => {
      expect(screen.getByText("Meeting Notes")).toBeInTheDocument();
    });
    expect(mockFetch).toHaveBeenCalledTimes(callsAfterFailure + 1);

    vi.useRealTimers();
  });

  it("does not report or show a failure for an aborted search", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockFetch.mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));

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
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(reportError).not.toHaveBeenCalled();
    expect(screen.queryByText("Search failed — try again")).not.toBeInTheDocument();

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
