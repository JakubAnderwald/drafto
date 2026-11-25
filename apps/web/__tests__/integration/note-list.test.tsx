import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, Component, StrictMode, Suspense, type ComponentProps, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";

import type { NoteListPatch } from "@/lib/note-patch";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockNotes = [
  { id: "note-1", title: "First Note", updated_at: new Date().toISOString() },
  { id: "note-2", title: "Second Note", updated_at: new Date().toISOString() },
];

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { NoteList } = await import("@/components/notes/note-list");

// Stands in for `global-error.tsx`: records what `use()` rethrows instead of rendering it.
class ErrorBoundary extends Component<
  { onError: (error: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? <p>Something went wrong!</p> : this.props.children;
  }
}

// The component caches fetched lists in a module-level Map (`notesCache`). We
// need to bust it by varying the `refreshTrigger` prop between tests so each
// test gets a fresh fetch. `initialNotes` never enters the cache.
let triggerCounter = 100;

function nextTrigger() {
  return triggerCounter++;
}

describe("NoteList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockNotes),
    });
  });

  it("renders notes after loading", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
      expect(screen.getByText("Second Note")).toBeInTheDocument();
    });
  });

  it("shows the Notes heading", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Notes")).toBeInTheDocument();
    });
  });

  it("has a new note button", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText("New note")).toBeInTheDocument();
    });
  });

  it("calls onCreateNote when the new note button is clicked", async () => {
    const trigger = nextTrigger();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText("New note")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("New note"));

    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("calls onSelectNote when a note is clicked", async () => {
    const trigger = nextTrigger();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    await user.click(screen.getByText("First Note"));

    expect(onSelect).toHaveBeenCalledWith("note-1");
  });

  it("highlights the selected note", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId="note-1"
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    const selectedButton = screen.getByText("First Note").closest("button");
    expect(selectedButton).toHaveAttribute("data-testid", "note-item-active");
  });

  it("shows empty state when there are no notes", async () => {
    const trigger = nextTrigger();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("No notes yet. Create one to get started.")).toBeInTheDocument();
    });
  });

  // An expired session (#460): middleware answers the notes fetch with 401 JSON. Before, it
  // redirected to /login, `fetch()` followed it, and `res.json()` on the login page's HTML
  // rejected into the global error boundary instead of sending the user to log in.
  describe("when the session has expired", () => {
    const originalLocation = window.location;
    let locationMock: { href: string; origin: string };

    beforeEach(() => {
      locationMock = { href: "http://localhost:3000/", origin: "http://localhost:3000" };
      Object.defineProperty(window, "location", { writable: true, value: locationMock });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", { writable: true, value: originalLocation });
    });

    async function renderExpired(response: Partial<Response>) {
      mockFetch.mockResolvedValue(response);
      const onError = vi.fn();

      await act(async () => {
        render(
          <ErrorBoundary onError={onError}>
            <Suspense fallback={<Skeleton height="2.5rem" />}>
              <NoteList
                notebookId="nb-expired"
                selectedNoteId={null}
                onSelectNote={vi.fn()}
                onCreateNote={vi.fn()}
                refreshTrigger={nextTrigger()}
              />
            </Suspense>
          </ErrorBoundary>,
        );
      });

      return { onError };
    }

    it("sends the browser to /login on a 401 instead of throwing into the error boundary", async () => {
      const json = vi.fn(() => Promise.resolve({ error: "Unauthorized" }));
      const { onError } = await renderExpired({ ok: false, status: 401, json });

      await waitFor(() => {
        expect(screen.getByText("No notes yet. Create one to get started.")).toBeInTheDocument();
      });
      expect(locationMock.href).toBe("/login");
      expect(onError).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
    });

    it("sends the browser to /login when the fetch was redirected to the login page", async () => {
      const json = vi.fn(() => Promise.reject(new SyntaxError("Unexpected token '<'")));
      const { onError } = await renderExpired({
        ok: true,
        status: 200,
        redirected: true,
        url: "http://localhost:3000/login",
        json,
      });

      await waitFor(() => {
        expect(screen.getByText("No notes yet. Create one to get started.")).toBeInTheDocument();
      });
      expect(locationMock.href).toBe("/login");
      expect(onError).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
    });
  });

  it("shows Suspense fallback while loading", async () => {
    const trigger = nextTrigger();
    // Create a promise that never resolves to keep the component suspended
    mockFetch.mockReturnValue(new Promise(() => {}));

    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("displays relative time for notes updated hours ago", async () => {
    const trigger = nextTrigger();
    const hoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: "note-h", title: "Hours Ago", updated_at: hoursAgo }]),
    });

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("3h ago")).toBeInTheDocument();
    });
  });

  it("displays relative time for notes updated days ago", async () => {
    const trigger = nextTrigger();
    const daysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: "note-d", title: "Days Ago", updated_at: daysAgo }]),
    });

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("5d ago")).toBeInTheDocument();
    });
  });

  it("displays date string for notes updated over 30 days ago", async () => {
    const trigger = nextTrigger();
    const oldDate = new Date(Date.now() - 60 * 86400000).toISOString();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: "note-old", title: "Old Note", updated_at: oldDate }]),
    });

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    // Should show a date string (locale-dependent), not "Xd ago"
    await waitFor(() => {
      expect(screen.getByText("Old Note")).toBeInTheDocument();
      const timeText = screen
        .getByText("Old Note")
        .closest("button")
        ?.querySelector("p:last-child");
      expect(timeText?.textContent).not.toMatch(/d ago/);
    });
  });

  it("shows move button on hover with other notebooks available", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onMove = vi.fn();
    const notebooks = [
      { id: "nb-1", name: "Current" },
      { id: "nb-2", name: "Work" },
      { id: "nb-3", name: "Personal" },
    ];

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            onMoveNote={onMove}
            notebooks={notebooks}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    // Move buttons should be rendered (hidden by CSS, but present in DOM)
    expect(screen.getByLabelText("Actions for First Note")).toBeInTheDocument();
    expect(screen.getByLabelText("Actions for Second Note")).toBeInTheDocument();
  });

  describe("row actions and the title's padding", () => {
    // jsdom applies no CSS, so these check the classes. The Playwright projects check
    // the result: e2e/responsive.spec.ts the touch opacity, e2e/notes.spec.ts (chromium)
    // that a long title stays clear of the ⋮ while a row is hovered or focused.
    const TOUCH_VISIBLE = "[@media(hover:none)]:opacity-100";
    const ACTIONS_PADDING = ["pl-3", "pr-10"];

    async function renderList(props: Partial<ComponentProps<typeof NoteList>>) {
      await act(async () => {
        render(
          <Suspense fallback={<Skeleton height="2.5rem" />}>
            <NoteList
              notebookId="nb-1"
              selectedNoteId={null}
              onSelectNote={vi.fn()}
              onCreateNote={vi.fn()}
              refreshTrigger={nextTrigger()}
              {...props}
            />
          </Suspense>,
        );
      });
      await waitFor(() => {
        expect(screen.getByText("First Note")).toBeInTheDocument();
      });
    }

    function rowButton(title: string): HTMLElement {
      const button = screen.getByText(title).closest("button");
      if (!button) throw new Error(`No row button for ${title}`);
      return button;
    }

    it("shows the actions button without hover on a touch-only pointer", async () => {
      await renderList({ onDeleteNote: vi.fn() });

      expect(screen.getByLabelText("Actions for First Note")).toHaveClass(TOUCH_VISIBLE);
    });

    it("reserves the actions button's width on every pointer, whether or not the row is hovered", async () => {
      await renderList({ onDeleteNote: vi.fn() });

      const button = rowButton("First Note");
      expect(button).toHaveClass(...ACTIONS_PADDING);
      // The padding must not depend on the pointer, hover or focus, or the title would
      // run under the ⋮ on a mouse or move when the ⋮ appears.
      expect(button).not.toHaveClass("px-3");
      expect(button.className).not.toMatch(/(?:hover|focus|group-[\w-]+|\[@media[^\]]*\]):pr-/);
    });

    it("reserves the width when the only action is a move to another notebook", async () => {
      await renderList({
        onMoveNote: vi.fn(),
        notebooks: [
          { id: "nb-1", name: "Current" },
          { id: "nb-2", name: "Other" },
        ],
      });

      expect(screen.getByLabelText("Actions for First Note")).toBeInTheDocument();
      expect(rowButton("First Note")).toHaveClass(...ACTIONS_PADDING);
    });

    it("leaves the title its full width when a row has no actions", async () => {
      await renderList({});

      expect(screen.queryByLabelText("Actions for First Note")).not.toBeInTheDocument();
      const button = rowButton("First Note");
      expect(button).toHaveClass("px-3");
      expect(button).not.toHaveClass("pr-10");
    });
  });

  it("shows an empty-titled note as Untitled, in the row and its actions label", async () => {
    const trigger = nextTrigger();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([{ id: "note-blank", title: "", updated_at: new Date().toISOString() }]),
    });

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            onDeleteNote={vi.fn()}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Untitled")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Actions for Untitled")).toBeInTheDocument();
  });

  it("opens move menu and shows other notebooks", async () => {
    const trigger = nextTrigger();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onMove = vi.fn();
    const notebooks = [
      { id: "nb-1", name: "Current" },
      { id: "nb-2", name: "Work" },
      { id: "nb-3", name: "Personal" },
    ];

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            onMoveNote={onMove}
            notebooks={notebooks}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    // Click the move button for the first note
    await user.click(screen.getByLabelText("Actions for First Note"));

    // Should show menu with other notebooks (not Current which is nb-1)
    expect(screen.getByText("Move to...")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Work" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Personal" })).toBeInTheDocument();
    // Should NOT show the current notebook
    expect(screen.queryByRole("menuitem", { name: "Current" })).not.toBeInTheDocument();
  });

  it("calls onMoveNote when a target notebook is clicked", async () => {
    const trigger = nextTrigger();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onMove = vi.fn();
    const notebooks = [
      { id: "nb-1", name: "Current" },
      { id: "nb-2", name: "Work" },
    ];

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            onMoveNote={onMove}
            notebooks={notebooks}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    // Open move menu
    await user.click(screen.getByLabelText("Actions for First Note"));

    // Click the target notebook
    await user.click(screen.getByRole("menuitem", { name: "Work" }));

    // Should call onMoveNote with the note ID, the target notebook ID and the notes
    // left in the list, which the parent picks the next selection from
    expect(onMove).toHaveBeenCalledWith("note-1", "nb-2", ["note-2"]);

    // Note should be removed from the list
    expect(screen.queryByText("First Note")).not.toBeInTheDocument();
  });

  // #461: selecting the next note from inside the list refetched the list while the
  // DELETE was still in flight, and that response could bring the note back. The
  // list now only removes the row and tells the parent what to select afterwards.
  describe("delete and move leave the selection to the parent", () => {
    const otherNotebooks = [
      { id: "nb-1", name: "Current" },
      { id: "nb-2", name: "Work" },
    ];

    async function renderList(
      props: Partial<ComponentProps<typeof NoteList>>,
      { strict = false }: { strict?: boolean } = {},
    ) {
      const list = (
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId="note-1"
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            notebooks={otherNotebooks}
            refreshTrigger={nextTrigger()}
            {...props}
          />
        </Suspense>
      );
      await act(async () => {
        render(strict ? <StrictMode>{list}</StrictMode> : list);
      });
    }

    async function chooseAction(user: ReturnType<typeof userEvent.setup>, action: string) {
      await user.click(screen.getByLabelText("Actions for First Note"));
      await user.click(screen.getByRole("menuitem", { name: action }));
    }

    it("removes the deleted selected note and passes the remaining notes to onDeleteNote", async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onDelete = vi.fn();
      await renderList({ onSelectNote: onSelect, onDeleteNote: onDelete });
      await waitFor(() => expect(screen.getByText("First Note")).toBeInTheDocument());

      await chooseAction(user, "Delete");

      expect(onDelete).toHaveBeenCalledOnce();
      expect(onDelete).toHaveBeenCalledWith("note-1", ["note-2"]);
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.queryByText("First Note")).not.toBeInTheDocument();
      expect(screen.getByText("Second Note")).toBeInTheDocument();
    });

    it("selects nothing and fetches nothing on delete under StrictMode", async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onDelete = vi.fn();
      await renderList({ onSelectNote: onSelect, onDeleteNote: onDelete }, { strict: true });
      await waitFor(() => expect(screen.getByText("First Note")).toBeInTheDocument());
      const fetchesBeforeDelete = mockFetch.mock.calls.length;

      await chooseAction(user, "Delete");

      // StrictMode runs state updaters twice, which double-fired the selection change
      // when it was made from inside one.
      expect(onDelete).toHaveBeenCalledOnce();
      expect(onDelete).toHaveBeenCalledWith("note-1", ["note-2"]);
      expect(onSelect).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(fetchesBeforeDelete);
      expect(screen.queryByText("First Note")).not.toBeInTheDocument();
    });

    it("passes no remaining notes when the deleted note was the last one", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([mockNotes[0]]),
      });
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onDelete = vi.fn();
      await renderList({ onSelectNote: onSelect, onDeleteNote: onDelete });
      await waitFor(() => expect(screen.getByText("First Note")).toBeInTheDocument());

      await chooseAction(user, "Delete");

      expect(onDelete).toHaveBeenCalledWith("note-1", []);
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByText("No notes yet. Create one to get started.")).toBeInTheDocument();
    });

    it("moves the selected note without selecting another itself", async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onMove = vi.fn();
      await renderList({ onSelectNote: onSelect, onMoveNote: onMove }, { strict: true });
      await waitFor(() => expect(screen.getByText("First Note")).toBeInTheDocument());

      await chooseAction(user, "Work");

      expect(onMove).toHaveBeenCalledOnce();
      expect(onMove).toHaveBeenCalledWith("note-1", "nb-2", ["note-2"]);
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.queryByText("First Note")).not.toBeInTheDocument();
    });

    it("passes no remaining notes when the moved note was the last one", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([mockNotes[0]]),
      });
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onMove = vi.fn();
      await renderList({ onSelectNote: onSelect, onMoveNote: onMove });
      await waitFor(() => expect(screen.getByText("First Note")).toBeInTheDocument());

      await chooseAction(user, "Work");

      expect(onMove).toHaveBeenCalledWith("note-1", "nb-2", []);
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByText("No notes yet. Create one to get started.")).toBeInTheDocument();
    });
  });

  it("does not show move button when no other notebooks exist", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const notebooks = [{ id: "nb-1", name: "Current" }];

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            notebooks={notebooks}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    // No move buttons should exist when only one notebook
    expect(screen.queryByLabelText("Actions for First Note")).not.toBeInTheDocument();
  });

  it("closes the actions menu when clicking outside", async () => {
    const trigger = nextTrigger();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onMove = vi.fn();
    const notebooks = [
      { id: "nb-1", name: "Current" },
      { id: "nb-2", name: "Work" },
    ];

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            onMoveNote={onMove}
            notebooks={notebooks}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    // Open menu
    await user.click(screen.getByLabelText("Actions for First Note"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Click outside to close
    await user.click(document.body);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  // The menu used to close on the trigger's mousedown, and the trigger's click then
  // opened it again, so the ⋮ could never close its own menu. The open row's trigger
  // is now passed to its DropdownMenu as `triggerRef`, and a mousedown on it no
  // longer counts as an outside click.
  describe("the row actions button toggles its menu", () => {
    async function renderList() {
      await act(async () => {
        render(
          <Suspense fallback={<Skeleton height="2.5rem" />}>
            <NoteList
              notebookId="nb-1"
              selectedNoteId={null}
              onSelectNote={vi.fn()}
              onCreateNote={vi.fn()}
              onDeleteNote={vi.fn()}
              refreshTrigger={nextTrigger()}
            />
          </Suspense>,
        );
      });
      await waitFor(() => {
        expect(screen.getByText("First Note")).toBeInTheDocument();
      });
    }

    function actionsButton(title: string): HTMLElement {
      return screen.getByLabelText(`Actions for ${title}`);
    }

    function row(title: string): HTMLElement {
      const li = actionsButton(title).closest("li");
      if (!li) throw new Error(`No row for ${title}`);
      return li;
    }

    function expectNoMenu() {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
    }

    it("closes the open menu on a second click of its actions button, and keeps it closed", async () => {
      const user = userEvent.setup();
      await renderList();

      await user.click(actionsButton("First Note"));
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();

      await user.click(actionsButton("First Note"));
      expectNoMenu();

      // Nothing reopens it once pending work has flushed.
      await act(async () => {});
      expectNoMenu();
    });

    it("reopens the menu on a third click of the actions button", async () => {
      const user = userEvent.setup();
      await renderList();

      await user.click(actionsButton("First Note"));
      await user.click(actionsButton("First Note"));
      expectNoMenu();

      await user.click(actionsButton("First Note"));
      expect(within(row("First Note")).getByRole("menu")).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    });

    it("still closes the menu on a click outside it", async () => {
      const user = userEvent.setup();
      await renderList();

      await user.click(actionsButton("First Note"));
      expect(screen.getByRole("menu")).toBeInTheDocument();

      await user.click(document.body);
      expectNoMenu();
    });

    it("still closes the menu on Escape", async () => {
      const user = userEvent.setup();
      await renderList();

      await user.click(actionsButton("First Note"));
      expect(screen.getByRole("menu")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      expectNoMenu();
    });

    it("closes one row's menu when another row's actions button is clicked, and opens that row's", async () => {
      const user = userEvent.setup();
      await renderList();

      await user.click(actionsButton("First Note"));
      expect(within(row("First Note")).getByRole("menu")).toBeInTheDocument();

      await user.click(actionsButton("Second Note"));
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      expect(within(row("Second Note")).getByRole("menu")).toBeInTheDocument();
      expect(within(row("First Note")).queryByRole("menu")).not.toBeInTheDocument();

      // The trigger exemption follows the open menu: the second row's button now closes it.
      await user.click(actionsButton("Second Note"));
      expectNoMenu();
    });
  });

  it("updates a note's timestamp in-place when lastNoteUpdate changes", async () => {
    const trigger = nextTrigger();
    const oldDate = new Date(Date.now() - 60 * 60000).toISOString(); // 1h ago
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([{ id: "note-ts", title: "Timestamp Note", updated_at: oldDate }]),
    });

    const { rerender } = await act(async () =>
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={trigger}
            lastNoteUpdate={null}
          />
        </Suspense>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByText("1h ago")).toBeInTheDocument();
    });

    // Simulate a save that updates the timestamp to now
    const newDate = new Date().toISOString();
    await act(async () => {
      rerender(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={trigger}
            lastNoteUpdate={{ noteId: "note-ts", updatedAt: newDate, title: "Timestamp Note" }}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("just now")).toBeInTheDocument();
    });
  });

  // The list is patched in place rather than refetched, because the open editor
  // shares `refreshTrigger` with it and a refetch would re-suspend the editor.
  describe("external-change patches", () => {
    function renderList(trigger: number, lastNoteUpdate: NoteListPatch | null) {
      return (
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-1"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={trigger}
            lastNoteUpdate={lastNoteUpdate}
          />
        </Suspense>
      );
    }

    async function mountWith(notes: { id: string; title: string; updated_at: string }[]) {
      const trigger = nextTrigger();
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(notes) });
      const { rerender } = await act(async () => render(renderList(trigger, null)));
      return {
        trigger,
        patch: async (update: NoteListPatch) => {
          await act(async () => {
            rerender(renderList(trigger, update));
          });
        },
      };
    }

    it("renames a row when an external edit changed the title", async () => {
      const { patch } = await mountWith([
        {
          id: "note-x",
          title: "Old title",
          updated_at: new Date(Date.now() - 3600_000).toISOString(),
        },
      ]);
      await waitFor(() => expect(screen.getByText("Old title")).toBeInTheDocument());

      await patch({
        noteId: "note-x",
        updatedAt: new Date().toISOString(),
        title: "Renamed elsewhere",
      });

      await waitFor(() => expect(screen.getByText("Renamed elsewhere")).toBeInTheDocument());
      expect(screen.queryByText("Old title")).not.toBeInTheDocument();
    });

    it("applies the title carried by a local-save patch", async () => {
      // Nothing but the patch updates the list's copy of the title, so the row would
      // otherwise keep the title it was fetched with.
      const { patch } = await mountWith([
        {
          id: "note-y",
          title: "Untitled",
          updated_at: new Date(Date.now() - 3600_000).toISOString(),
        },
      ]);
      await waitFor(() => expect(screen.getByText("1h ago")).toBeInTheDocument());

      await patch({ noteId: "note-y", updatedAt: new Date().toISOString(), title: "Typed here" });

      await waitFor(() => expect(screen.getByText("Typed here")).toBeInTheDocument());
      expect(screen.queryByText("Untitled")).not.toBeInTheDocument();
      expect(screen.getByText("just now")).toBeInTheDocument();
    });

    it("drops a row that was trashed or deleted elsewhere", async () => {
      const now = new Date().toISOString();
      const { patch } = await mountWith([
        { id: "note-gone", title: "Removed elsewhere", updated_at: now },
        { id: "note-stays", title: "Still here", updated_at: now },
      ]);
      await waitFor(() => expect(screen.getByText("Removed elsewhere")).toBeInTheDocument());

      await patch({ noteId: "note-gone", removed: true });

      await waitFor(() => expect(screen.queryByText("Removed elsewhere")).not.toBeInTheDocument());
      expect(screen.getByText("Still here")).toBeInTheDocument();
    });

    it("ignores a patch for a note that is not in this notebook", async () => {
      const { patch } = await mountWith([
        { id: "note-here", title: "Only note", updated_at: new Date().toISOString() },
      ]);
      await waitFor(() => expect(screen.getByText("Only note")).toBeInTheDocument());

      await patch({ noteId: "note-elsewhere", removed: true });

      expect(screen.getByText("Only note")).toBeInTheDocument();
    });
  });

  it("fetches notes for the given notebook ID", async () => {
    const trigger = nextTrigger();
    const onSelect = vi.fn();
    const onCreate = vi.fn();

    await act(async () => {
      render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-42"
            selectedNoteId={null}
            onSelectNote={onSelect}
            onCreateNote={onCreate}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-42/notes");
    });
  });

  it("uses initialNotes to skip client fetch on first render", async () => {
    mockFetch.mockReset();

    const serverNotes = [
      { id: "server-1", title: "Server Note", updated_at: new Date().toISOString() },
    ];

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-prefetched"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={0}
            initialNotes={serverNotes}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Server Note")).toBeInTheDocument();
    });

    // Should NOT have made a client-side fetch — data came from server
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not cache initialNotes", async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(mockNotes) });
    const serverNotes = [
      { id: "server-2", title: "Uncached Server Note", updated_at: new Date().toISOString() },
    ];

    const { unmount } = await act(async () =>
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-uncached"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={0}
            initialNotes={serverNotes}
          />
        </Suspense>,
      ),
    );
    expect(screen.getByText("Uncached Server Note")).toBeInTheDocument();
    unmount();

    // The same key without the server notes finds nothing cached, so it fetches.
    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-uncached"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={0}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });
    expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-uncached/notes");
    expect(screen.queryByText("Uncached Server Note")).not.toBeInTheDocument();
  });

  it("fetches fresh data on refreshTrigger > 0 even with initialNotes", async () => {
    const trigger = nextTrigger();
    const serverNotes = [
      { id: "stale-1", title: "Stale Server Note", updated_at: new Date().toISOString() },
    ];

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <NoteList
            notebookId="nb-refresh"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={trigger}
            initialNotes={serverNotes}
          />
        </Suspense>,
      );
    });

    // Should fetch fresh data since refreshTrigger > 0
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-refresh/notes");
    });
  });

  // #475: `notesCache` must not keep a failed fetch, nor a list a newer refresh replaced.
  describe("notes cache eviction", () => {
    function listFor(notebookId: string, refreshTrigger: number, onError = vi.fn()) {
      return (
        <ErrorBoundary onError={onError}>
          <Suspense fallback={<Skeleton height="2.5rem" />}>
            <NoteList
              notebookId={notebookId}
              selectedNoteId={null}
              onSelectNote={vi.fn()}
              onCreateNote={vi.fn()}
              refreshTrigger={refreshTrigger}
            />
          </Suspense>
        </ErrorBoundary>
      );
    }

    function fetchesFor(notebookId: string) {
      return mockFetch.mock.calls.filter(([url]) => url === `/api/notebooks/${notebookId}/notes`)
        .length;
    }

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("fetches again after a failed fetch instead of rethrowing the cached rejection", async () => {
      // React logs the error the boundary catches.
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
      const trigger = nextTrigger();
      const onError = vi.fn();

      const { unmount } = await act(async () => render(listFor("nb-retry", trigger, onError)));

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Failed to fetch notes: 500" }),
        );
      });
      // The render React schedules on the rejection still throws it, rather than
      // missing the cache and fetching again.
      expect(fetchesFor("nb-retry")).toBe(1);
      unmount();

      // The network is back. The same key must fetch again, not serve the rejection.
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(mockNotes) });
      const fetchesBeforeRetry = fetchesFor("nb-retry");
      const onRetryError = vi.fn();

      await act(async () => {
        render(listFor("nb-retry", trigger, onRetryError));
      });

      await waitFor(() => {
        expect(screen.getByText("First Note")).toBeInTheDocument();
      });
      expect(fetchesFor("nb-retry")).toBeGreaterThan(fetchesBeforeRetry);
      expect(onRetryError).not.toHaveBeenCalled();
    });

    it("shows a lasting failure's error under StrictMode instead of refetching", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockFetch.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) });
      const onError = vi.fn();

      await act(async () => {
        render(<StrictMode>{listFor("nb-strict-fail", nextTrigger(), onError)}</StrictMode>);
      });

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Failed to fetch notes: 503" }),
        );
      });
      expect(fetchesFor("nb-strict-fail")).toBe(1);
      expect(screen.getByText("Something went wrong!")).toBeInTheDocument();
    });

    it("expires a failure no render read, so a later mount with the same key fetches", async () => {
      let rejectFetch: (error: Error) => void = () => {};
      mockFetch.mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectFetch = reject;
        }),
      );
      const trigger = nextTrigger();

      // The list unmounts while its fetch is in flight, so nothing reads the failure.
      const { unmount } = await act(async () => render(listFor("nb-unread", trigger)));
      unmount();
      vi.useFakeTimers();
      await act(async () => {
        rejectFetch(new Error("offline"));
      });
      vi.advanceTimersByTime(10_000);
      vi.useRealTimers();

      const onError = vi.fn();
      await act(async () => {
        render(listFor("nb-unread", trigger, onError));
      });

      await waitFor(() => {
        expect(screen.getByText("First Note")).toBeInTheDocument();
      });
      expect(fetchesFor("nb-unread")).toBe(2);
      expect(onError).not.toHaveBeenCalled();
    });

    it("evicts a notebook's older list when a newer refresh fetches it", async () => {
      const first = nextTrigger();
      const second = nextTrigger();

      const { rerender } = await act(async () => render(listFor("nb-evict", first)));
      await waitFor(() => {
        expect(screen.getByText("First Note")).toBeInTheDocument();
      });

      await act(async () => {
        rerender(listFor("nb-evict", second));
      });
      await waitFor(() => {
        expect(fetchesFor("nb-evict")).toBe(2);
      });

      // The first key was evicted by the second fetch, so asking for it fetches again.
      await act(async () => {
        rerender(listFor("nb-evict", first));
      });
      await waitFor(() => {
        expect(fetchesFor("nb-evict")).toBe(3);
      });
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    it("keeps other notebooks' cached lists", async () => {
      const trigger = nextTrigger();
      const otherTrigger = nextTrigger();

      const { rerender } = await act(async () => render(listFor("nb-keep", trigger)));
      await waitFor(() => {
        expect(screen.getByText("First Note")).toBeInTheDocument();
      });

      await act(async () => {
        rerender(listFor("nb-other", otherTrigger));
      });
      await waitFor(() => {
        expect(fetchesFor("nb-other")).toBe(1);
      });

      // Fetching another notebook left this notebook's entry alone: a cache hit.
      await act(async () => {
        rerender(listFor("nb-keep", trigger));
      });
      await waitFor(() => {
        expect(screen.getByText("First Note")).toBeInTheDocument();
      });
      expect(fetchesFor("nb-keep")).toBe(1);
    });
  });

  // Regression guard for #536: a long note list must scroll. The scrollable
  // `<nav>` carries `overflow-y-auto`, but it only gains a constrained height
  // to scroll within if its flex ancestors can shrink below their content
  // height. The root container must therefore keep `min-h-0` (its default
  // `min-height: auto` would otherwise force it to grow to the list's
  // intrinsic height and the inner scroll would never engage).
  it("keeps the height-constraining classes so the list can scroll", async () => {
    const trigger = nextTrigger();

    const { container } = await act(async () => {
      return render(
        <Suspense fallback={<Skeleton height="2.5rem" />}>
          <NoteList
            notebookId="nb-scroll"
            selectedNoteId={null}
            onSelectNote={vi.fn()}
            onCreateNote={vi.fn()}
            refreshTrigger={trigger}
          />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("First Note")).toBeInTheDocument();
    });

    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.className).toContain("min-h-0");
    expect(root.className).toContain("flex-1");

    const scrollContainer = container.querySelector("nav");
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer?.className).toContain("overflow-y-auto");
    expect(scrollContainer?.className).toContain("flex-1");
  });
});
