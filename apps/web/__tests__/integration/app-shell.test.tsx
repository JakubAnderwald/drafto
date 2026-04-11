import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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

// Mock useTheme to avoid localStorage/matchMedia issues in jsdom
vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({
    theme: "system" as const,
    resolvedTheme: "light" as const,
    setTheme: vi.fn(),
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

  it("moves a note via the move menu", async () => {
    const user = userEvent.setup();

    await act(async () => {
      render(<AppShell />);
    });

    // Wait for notebooks and notes to load
    await waitFor(() => {
      expect(screen.getByText("My First Note")).toBeInTheDocument();
    });

    // Click the move button on the first note
    await act(async () => {
      await user.click(screen.getByLabelText("Actions for My First Note"));
    });

    // Select the target notebook "Work"
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "Work" }));
    });

    // Verify the PATCH request was made with the notebook_id
    await waitFor(() => {
      const patchCalls = mockFetch.mock.calls.filter(
        (args) => (args[1] as { method?: string } | undefined)?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const [url, options] = patchCalls[0];
      expect(url).toContain("/api/notes/note-1");
      expect(JSON.parse((options as { body: string }).body)).toEqual({
        notebook_id: "nb-2",
      });
    });
  });

  it("handles failed note move gracefully", async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByText("My First Note")).toBeInTheDocument();
    });

    // Mock a failed PATCH
    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === "PATCH") {
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

    // Open move menu and click target
    await act(async () => {
      await user.click(screen.getByLabelText("Actions for My First Note"));
    });
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "Work" }));
    });

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith("Failed to move note:", 500);
    });

    consoleSpy.mockRestore();
  });

  it("deletes a note via the action menu", async () => {
    const user = userEvent.setup();

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByText("My First Note")).toBeInTheDocument();
    });

    // Click the actions button on the first note
    await act(async () => {
      await user.click(screen.getByLabelText("Actions for My First Note"));
    });

    // Click "Delete" in the menu
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    });

    // Verify the DELETE request was made
    await waitFor(() => {
      const deleteCalls = mockFetch.mock.calls.filter(
        (args) => (args[1] as { method?: string } | undefined)?.method === "DELETE",
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
      expect(deleteCalls[0][0]).toContain("/api/notes/note-1");
    });
  });

  it("shows trash button in sidebar", async () => {
    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByText("Notebooks")).toBeInTheDocument();
    });

    // Trash button should be visible
    expect(screen.getByRole("button", { name: /Trash/i })).toBeInTheDocument();
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

    expect(screen.getByTestId("sidebar-skeleton")).toBeInTheDocument();
  });

  it("switches to trash view when trash button is clicked", async () => {
    const user = userEvent.setup();
    const mockTrashedNotes = [
      {
        id: "t-1",
        title: "Trashed Note",
        notebook_id: "nb-1",
        trashed_at: new Date().toISOString(),
      },
    ];

    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/notebooks") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotebooks) });
      }
      if (url === "/api/notes/trash") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTrashedNotes) });
      }
      if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotes) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Trash/i })).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Trash/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("Trashed Note")).toBeInTheDocument();
    });
  });

  it("restores a note from trash via the trash view", async () => {
    const user = userEvent.setup();
    const mockTrashedNotes = [
      {
        id: "t-1",
        title: "Trashed Note",
        notebook_id: "nb-1",
        trashed_at: new Date().toISOString(),
      },
    ];

    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === "PATCH") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      if (url === "/api/notebooks") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotebooks) });
      }
      if (url === "/api/notes/trash") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTrashedNotes) });
      }
      if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotes) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Trash/i })).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Trash/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("Trashed Note")).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByText("Restore"));
    });

    // The PATCH request should have been made to restore the note
    await waitFor(() => {
      const patchCalls = mockFetch.mock.calls.filter(
        (args) => (args[1] as { method?: string } | undefined)?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      expect(JSON.parse((patchCalls[0][1] as { body: string }).body)).toEqual({
        is_trashed: false,
      });
    });
  });

  it("permanently deletes a note from trash", async () => {
    const user = userEvent.setup();
    const mockTrashedNotes = [
      {
        id: "t-1",
        title: "Trashed Note",
        notebook_id: "nb-1",
        trashed_at: new Date().toISOString(),
      },
    ];

    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === "DELETE") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      if (url === "/api/notebooks") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotebooks) });
      }
      if (url === "/api/notes/trash") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTrashedNotes) });
      }
      if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotes) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Trash/i })).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Trash/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("Trashed Note")).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByText("Delete forever"));
    });

    // The DELETE request should have been made for permanent deletion
    await waitFor(() => {
      const deleteCalls = mockFetch.mock.calls.filter(
        (args) => (args[1] as { method?: string } | undefined)?.method === "DELETE",
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
      expect(deleteCalls[0][0]).toContain("/api/notes/t-1/permanent");
    });
  });

  it("handles network error on restore with rollback", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const mockTrashedNotes = [
      {
        id: "t-1",
        title: "Trashed Note",
        notebook_id: "nb-1",
        trashed_at: new Date().toISOString(),
      },
    ];

    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === "PATCH") {
        return Promise.reject(new Error("Network error"));
      }
      if (url === "/api/notebooks") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotebooks) });
      }
      if (url === "/api/notes/trash") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTrashedNotes) });
      }
      if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotes) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Trash/i })).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Trash/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("Trashed Note")).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByText("Restore"));
    });

    // Note should be rolled back (reappear) after failed restore
    await waitFor(() => {
      expect(screen.getByText("Trashed Note")).toBeInTheDocument();
    });

    vi.restoreAllMocks();
  });

  it("handles network error on permanent delete with rollback", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const mockTrashedNotes = [
      {
        id: "t-1",
        title: "Trashed Note",
        notebook_id: "nb-1",
        trashed_at: new Date().toISOString(),
      },
    ];

    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === "DELETE") {
        return Promise.reject(new Error("Network error"));
      }
      if (url === "/api/notebooks") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotebooks) });
      }
      if (url === "/api/notes/trash") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTrashedNotes) });
      }
      if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotes) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Trash/i })).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Trash/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("Trashed Note")).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByText("Delete forever"));
    });

    // Note should be rolled back (reappear) after failed permanent delete
    await waitFor(() => {
      expect(screen.getByText("Trashed Note")).toBeInTheDocument();
    });

    vi.restoreAllMocks();
  });

  it("handles network error on note move gracefully", async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByText("My First Note")).toBeInTheDocument();
    });

    // Mock a network error on PATCH
    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === "PATCH") {
        return Promise.reject(new Error("Network error"));
      }
      if (url === "/api/notebooks") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotebooks) });
      }
      if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotes) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    // Open move menu and click target
    await act(async () => {
      await user.click(screen.getByLabelText("Actions for My First Note"));
    });
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "Work" }));
    });

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith("Failed to move note:", expect.any(Error));
    });

    consoleSpy.mockRestore();
  });

  it("handles network error on note delete gracefully", async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByText("My First Note")).toBeInTheDocument();
    });

    // Mock a network error on DELETE
    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === "DELETE") {
        return Promise.reject(new Error("Network error"));
      }
      if (url === "/api/notebooks") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotebooks) });
      }
      if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotes) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      await user.click(screen.getByLabelText("Actions for My First Note"));
    });
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    });

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith("Failed to delete note:", expect.any(Error));
    });

    consoleSpy.mockRestore();
  });

  it("handles failed restore (non-ok response) with rollback", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const mockTrashedNotes = [
      {
        id: "t-1",
        title: "Trashed Note",
        notebook_id: "nb-1",
        trashed_at: new Date().toISOString(),
      },
    ];

    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === "PATCH") {
        return Promise.resolve({ ok: false, status: 500 });
      }
      if (url === "/api/notebooks") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotebooks) });
      }
      if (url === "/api/notes/trash") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTrashedNotes) });
      }
      if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotes) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Trash/i })).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Trash/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("Trashed Note")).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByText("Restore"));
    });

    // Note should be rolled back (reappear) after failed restore
    await waitFor(() => {
      expect(screen.getByText("Trashed Note")).toBeInTheDocument();
    });

    vi.restoreAllMocks();
  });

  it("handles failed permanent delete (non-ok response) with rollback", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const mockTrashedNotes = [
      {
        id: "t-1",
        title: "Trashed Note",
        notebook_id: "nb-1",
        trashed_at: new Date().toISOString(),
      },
    ];

    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === "DELETE") {
        return Promise.resolve({ ok: false, status: 500 });
      }
      if (url === "/api/notebooks") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotebooks) });
      }
      if (url === "/api/notes/trash") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTrashedNotes) });
      }
      if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotes) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<AppShell />);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Trash/i })).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Trash/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("Trashed Note")).toBeInTheDocument();
    });

    await act(async () => {
      await user.click(screen.getByText("Delete forever"));
    });

    // Note should be rolled back (reappear) after failed permanent delete
    await waitFor(() => {
      expect(screen.getByText("Trashed Note")).toBeInTheDocument();
    });

    vi.restoreAllMocks();
  });

  describe("tablet layout — collapsible sidebar", () => {
    it("renders a sidebar toggle button", async () => {
      await act(async () => {
        render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("Notebooks")).toBeInTheDocument();
      });

      expect(screen.getByLabelText("Toggle sidebar")).toBeInTheDocument();
    });

    it("shows backdrop when sidebar toggle is clicked", async () => {
      const user = userEvent.setup();

      const { container } = await act(async () => {
        return render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("Notebooks")).toBeInTheDocument();
      });

      // Backdrop should not be visible initially
      expect(container.querySelector("[data-testid='sidebar-backdrop']")).not.toBeInTheDocument();

      // Click the toggle button to open sidebar
      await act(async () => {
        await user.click(screen.getByLabelText("Toggle sidebar"));
      });

      // Backdrop should now be visible
      expect(screen.getByTestId("sidebar-backdrop")).toBeInTheDocument();
    });

    it("closes sidebar when backdrop is clicked", async () => {
      const user = userEvent.setup();

      await act(async () => {
        render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("Notebooks")).toBeInTheDocument();
      });

      // Open sidebar
      await act(async () => {
        await user.click(screen.getByLabelText("Toggle sidebar"));
      });

      expect(screen.getByTestId("sidebar-backdrop")).toBeInTheDocument();

      // Click backdrop to close
      await act(async () => {
        await user.click(screen.getByTestId("sidebar-backdrop"));
      });

      // Backdrop should disappear
      expect(screen.queryByTestId("sidebar-backdrop")).not.toBeInTheDocument();
    });

    it("closes sidebar when a notebook is selected", async () => {
      const user = userEvent.setup();

      await act(async () => {
        render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("Personal")).toBeInTheDocument();
      });

      // Open sidebar
      await act(async () => {
        await user.click(screen.getByLabelText("Toggle sidebar"));
      });

      expect(screen.getByTestId("sidebar-backdrop")).toBeInTheDocument();

      // Click a notebook — sidebar should close
      await act(async () => {
        await user.click(screen.getByText("Work"));
      });

      expect(screen.queryByTestId("sidebar-backdrop")).not.toBeInTheDocument();
    });

    it("closes sidebar when trash is selected", async () => {
      const user = userEvent.setup();
      const mockTrashedNotes = [
        {
          id: "t-1",
          title: "Trashed Note",
          notebook_id: "nb-1",
          trashed_at: new Date().toISOString(),
        },
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/notebooks") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotebooks) });
        }
        if (url === "/api/notes/trash") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTrashedNotes) });
        }
        if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotes) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      await act(async () => {
        render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Trash/i })).toBeInTheDocument();
      });

      // Open sidebar
      await act(async () => {
        await user.click(screen.getByLabelText("Toggle sidebar"));
      });

      expect(screen.getByTestId("sidebar-backdrop")).toBeInTheDocument();

      // Click Trash — sidebar should close
      await act(async () => {
        await user.click(screen.getByRole("button", { name: /Trash/i }));
      });

      expect(screen.queryByTestId("sidebar-backdrop")).not.toBeInTheDocument();
    });

    it("sidebar has responsive CSS classes for tablet overlay", async () => {
      const { container } = await act(async () => {
        return render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("Notebooks")).toBeInTheDocument();
      });

      const aside = container.querySelector("aside");
      expect(aside).toBeInTheDocument();

      // Sidebar should have fixed positioning on tablet (sm:fixed) and lg:static on desktop
      expect(aside?.className).toContain("sm:fixed");
      expect(aside?.className).toContain("lg:static");
      expect(aside?.className).toContain("lg:translate-x-0");
      expect(aside?.className).toContain("sm:transition-transform");
    });

    it("toggles sidebar translate class when opened and closed", async () => {
      const user = userEvent.setup();

      const { container } = await act(async () => {
        return render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("Notebooks")).toBeInTheDocument();
      });

      const aside = container.querySelector("aside");

      // Initially closed — should have -translate-x-full
      expect(aside?.className).toContain("-translate-x-full");
      expect(aside?.className).not.toContain(" translate-x-0");

      // Open sidebar
      await act(async () => {
        await user.click(screen.getByLabelText("Toggle sidebar"));
      });

      // Now open — should have translate-x-0 (not the -translate-x-full)
      expect(aside?.className).toContain("translate-x-0");
      expect(aside?.className).not.toContain("-translate-x-full");
    });
  });

  describe("mobile layout — single-panel navigation", () => {
    it("renders 'Back to notebooks' button in the note list panel", async () => {
      await act(async () => {
        render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("Notebooks")).toBeInTheDocument();
      });

      // After notebooks auto-select, the note list shows with a mobile back button
      expect(screen.getByLabelText("Back to notebooks")).toBeInTheDocument();
    });

    it("renders 'Back to notes' button when editor is open", async () => {
      const user = userEvent.setup();

      await act(async () => {
        render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("My First Note")).toBeInTheDocument();
      });

      // Click a note to open the editor
      await act(async () => {
        await user.click(screen.getByText("My First Note"));
      });

      await waitFor(() => {
        expect(screen.getByTestId("blocknote-editor")).toBeInTheDocument();
      });

      expect(screen.getByLabelText("Back to notes")).toBeInTheDocument();
    });

    it("clicking 'Back to notebooks' clears notebook selection", async () => {
      const user = userEvent.setup();

      const { container } = await act(async () => {
        return render(<AppShell />);
      });

      // Wait for notebooks to auto-select
      await waitFor(() => {
        expect(screen.getByText("My First Note")).toBeInTheDocument();
      });

      const aside = container.querySelector("aside");
      const section = container.querySelector("section");

      // After auto-select, mobileView is "notes":
      // sidebar should be hidden, note list should be flex
      expect(aside?.className).toContain("hidden");
      expect(section?.className).toContain("flex");

      // Click back to notebooks
      await act(async () => {
        await user.click(screen.getByLabelText("Back to notebooks"));
      });

      // After going back, mobileView is "notebooks":
      // sidebar should be flex, note list should be hidden
      expect(aside?.className).toMatch(/(?:^|\s)flex(?:\s|$)/);
      expect(section?.className).toContain("hidden");
    });

    it("clicking 'Back to notes' clears note selection and returns to notes view", async () => {
      const user = userEvent.setup();

      const { container } = await act(async () => {
        return render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("My First Note")).toBeInTheDocument();
      });

      // Click a note to go to editor
      await act(async () => {
        await user.click(screen.getByText("My First Note"));
      });

      await waitFor(() => {
        expect(screen.getByTestId("blocknote-editor")).toBeInTheDocument();
      });

      const section = container.querySelector("section");
      const main = container.querySelector("main");

      // mobileView is "editor": note list hidden, editor visible
      expect(section?.className).toContain("hidden");
      expect(main?.className).toMatch(/(?:^|\s)flex(?:\s|$)/);

      // Click back to notes
      await act(async () => {
        await user.click(screen.getByLabelText("Back to notes"));
      });

      // mobileView is "notes": note list visible, editor hidden
      expect(section?.className).toMatch(/(?:^|\s)flex(?:\s|$)/);
      expect(main?.className).toContain("hidden");
    });

    it("sidebar has mobile-responsive CSS (w-full on mobile, sm:w-60 on tablet)", async () => {
      const { container } = await act(async () => {
        return render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("Notebooks")).toBeInTheDocument();
      });

      const aside = container.querySelector("aside");
      expect(aside?.className).toContain("w-full");
      expect(aside?.className).toContain("sm:w-60");
    });

    it("note list section has mobile-responsive CSS (w-full on mobile, sm:w-[300px] on tablet)", async () => {
      const { container } = await act(async () => {
        return render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("Notebooks")).toBeInTheDocument();
      });

      const section = container.querySelector("section");
      expect(section?.className).toContain("w-full");
      expect(section?.className).toContain("sm:w-[300px]");
    });

    it("editor has mobile-responsive CSS (sm:flex for tablet+)", async () => {
      const { container } = await act(async () => {
        return render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByText("Notebooks")).toBeInTheDocument();
      });

      const main = container.querySelector("main");
      expect(main?.className).toContain("sm:flex");
    });

    it("mobile back button shows 'Trash' label when viewing trash", async () => {
      const user = userEvent.setup();
      const mockTrashedNotes = [
        {
          id: "t-1",
          title: "Trashed Note",
          notebook_id: "nb-1",
          trashed_at: new Date().toISOString(),
        },
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/notebooks") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotebooks) });
        }
        if (url === "/api/notes/trash") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTrashedNotes) });
        }
        if (typeof url === "string" && url.match(/\/api\/notebooks\/[^/]+\/notes$/)) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(mockNotes) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      await act(async () => {
        render(<AppShell />);
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Trash/i })).toBeInTheDocument();
      });

      await act(async () => {
        await user.click(screen.getByRole("button", { name: /Trash/i }));
      });

      await waitFor(() => {
        expect(screen.getByText("Trashed Note")).toBeInTheDocument();
      });

      // The mobile back button header should show "Trash" label
      const backButton = screen.getByLabelText("Back to notebooks");
      expect(backButton.parentElement?.textContent).toContain("Trash");
    });

    it("navigates full mobile stack: notebooks → notes → editor → back to notes → back to notebooks", async () => {
      const user = userEvent.setup();

      // Start with empty notebooks to prevent auto-selection
      mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
        if (url === "/api/notebooks" && !options?.method) {
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

      const { container } = await act(async () => {
        return render(<AppShell />);
      });

      // Wait for notebooks to load and auto-select
      await waitFor(() => {
        expect(screen.getByText("My First Note")).toBeInTheDocument();
      });

      // State: notes view (notebook auto-selected)
      const aside = container.querySelector("aside");
      const section = container.querySelector("section");
      const main = container.querySelector("main");

      expect(aside?.className).toContain("hidden");
      expect(section?.className).toMatch(/(?:^|\s)flex(?:\s|$)/);
      expect(main?.className).toContain("hidden");

      // Navigate to editor by clicking a note
      await act(async () => {
        await user.click(screen.getByText("My First Note"));
      });

      await waitFor(() => {
        expect(screen.getByTestId("blocknote-editor")).toBeInTheDocument();
      });

      // State: editor view
      expect(aside?.className).toContain("hidden");
      expect(section?.className).toContain("hidden");
      expect(main?.className).toMatch(/(?:^|\s)flex(?:\s|$)/);

      // Navigate back to notes
      await act(async () => {
        await user.click(screen.getByLabelText("Back to notes"));
      });

      // State: notes view
      expect(aside?.className).toContain("hidden");
      expect(section?.className).toMatch(/(?:^|\s)flex(?:\s|$)/);
      expect(main?.className).toContain("hidden");

      // Navigate back to notebooks
      await act(async () => {
        await user.click(screen.getByLabelText("Back to notebooks"));
      });

      // State: notebooks view
      expect(aside?.className).toMatch(/(?:^|\s)flex(?:\s|$)/);
      expect(section?.className).toContain("hidden");
      expect(main?.className).toContain("hidden");
    });
  });
});
