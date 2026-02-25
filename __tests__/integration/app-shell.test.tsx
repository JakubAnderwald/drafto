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

// Mock BlockNote — the real editor requires canvas support that jsdom lacks
vi.mock("@blocknote/react", () => ({
  useCreateBlockNote: () => ({
    document: [],
  }),
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

// Mock useAutoSave to avoid real save calls
vi.mock("@/hooks/use-auto-save", () => ({
  useAutoSave: () => ({
    saveStatus: "idle" as const,
    debouncedSave: vi.fn(),
  }),
}));

const mockNotebooks = [
  { id: "nb-1", name: "Personal", created_at: "2026-01-01", updated_at: "2026-01-01" },
  { id: "nb-2", name: "Work", created_at: "2026-01-02", updated_at: "2026-01-02" },
];

const mockNotes = [
  { id: "note-1", title: "My First Note", updated_at: new Date().toISOString() },
  { id: "note-2", title: "My Second Note", updated_at: new Date().toISOString() },
];

const mockNote = {
  id: "note-1",
  title: "My First Note",
  content: null,
};

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Must re-import to reset the hasFetched ref in NotebooksSidebar and
// the module-level caches in NoteList / NoteEditorPanel
let AppShell: typeof import("@/components/layout/app-shell").AppShell;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();

  mockFetch.mockImplementation((url: string) => {
    if (url === "/api/notebooks") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockNotebooks),
      });
    }
    if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockNotes),
      });
    }
    if (typeof url === "string" && url.match(/\/api\/notes\//)) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockNote),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });

  const mod = await import("@/components/layout/app-shell");
  AppShell = mod.AppShell;
});

describe("AppShell", () => {
  it("renders the three-panel layout", async () => {
    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByText("Notebooks")).toBeInTheDocument();
    });
  });

  it("renders children", async () => {
    await act(async () => {
      render(
        <AppShell>
          <div>children content</div>
        </AppShell>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("children content")).toBeInTheDocument();
    });
  });

  it("shows 'Select a notebook' initially before any notebook is selected", async () => {
    // When notebooks load and one is selected, this text will disappear.
    // But if there are no notebooks, it should remain.
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/notebooks") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByText("Select a notebook")).toBeInTheDocument();
    });
  });

  it("shows 'Select a note' when a notebook is selected but no note is selected", async () => {
    await act(async () => {
      render(<AppShell />);
    });

    // After notebooks load, the first one gets auto-selected and notes load
    await waitFor(() => {
      expect(screen.getByText("Personal")).toBeInTheDocument();
    });

    // Notes panel should show the notes, and the main panel should show "Select a note"
    await waitFor(() => {
      expect(screen.getByText("Select a note")).toBeInTheDocument();
    });
  });

  it("loads notes when a notebook is selected", async () => {
    await act(async () => {
      render(<AppShell />);
    });

    // The NotebooksSidebar auto-selects the first notebook, triggering NoteList
    await waitFor(() => {
      expect(screen.getByText("My First Note")).toBeInTheDocument();
      expect(screen.getByText("My Second Note")).toBeInTheDocument();
    });
  });

  it("loads the editor when a note is clicked", async () => {
    const user = userEvent.setup();

    await act(async () => {
      render(<AppShell />);
    });

    // Wait for notes to load
    await waitFor(() => {
      expect(screen.getByText("My First Note")).toBeInTheDocument();
    });

    // Click on a note — this triggers a state update + Suspense for the editor
    await act(async () => {
      await user.click(screen.getByText("My First Note"));
    });

    // The editor panel should load with the note title in an input
    await waitFor(
      () => {
        expect(screen.getByDisplayValue("My First Note")).toBeInTheDocument();
        expect(screen.getByTestId("blocknote-editor")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it("has a sidebar, middle panel, and main area", async () => {
    const { container } = await act(async () => {
      return render(<AppShell />);
    });

    // The layout has aside, section, and main elements
    expect(container.querySelector("aside")).toBeInTheDocument();
    expect(container.querySelector("section")).toBeInTheDocument();
    expect(container.querySelector("main")).toBeInTheDocument();
  });

  it("creates a note when 'New note' button is clicked", async () => {
    const user = userEvent.setup();

    await act(async () => {
      render(<AppShell />);
    });

    // Wait for notes to load (notebook auto-selected → NoteList renders)
    await waitFor(() => {
      expect(screen.getByText("My First Note")).toBeInTheDocument();
    });

    // Mock the POST response for creating a note
    const createdNote = { id: "note-new", title: "Untitled", content: null };
    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === "POST" && typeof url === "string" && url.includes("/notes")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(createdNote),
        });
      }
      if (typeof url === "string" && url.match(/\/api\/notes\//)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(createdNote),
        });
      }
      if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([...mockNotes, createdNote]),
        });
      }
      if (url === "/api/notebooks") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockNotebooks),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    // Click the "New note" button
    await act(async () => {
      await user.click(screen.getByLabelText("New note"));
    });

    // Verify the POST was made to the notes endpoint
    await waitFor(() => {
      const postCalls = mockFetch.mock.calls.filter(
        (args) => (args[1] as { method?: string } | undefined)?.method === "POST",
      );
      expect(postCalls.length).toBeGreaterThan(0);
    });
  });

  it("handles failed note creation gracefully", async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByText("My First Note")).toBeInTheDocument();
    });

    // Mock a failed POST
    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        return Promise.resolve({ ok: false, status: 500 });
      }
      if (url === "/api/notebooks") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockNotebooks),
        });
      }
      if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockNotes),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      await user.click(screen.getByLabelText("New note"));
    });

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith("Failed to create note:", 500);
    });

    consoleSpy.mockRestore();
  });

  it("shows notebook loading state in the sidebar", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/notebooks") {
        return new Promise(() => {}); // never resolves
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<AppShell />);
    });

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });
});
