import { render, act } from "../helpers/test-utils";
import { setEnabledMenuActions, type MenuAction } from "@/lib/native/menu-manager";
import { MenuProvider } from "@/providers/menu-provider";
import { MainScreen } from "@/screens/main";

// The real MainScreen renders panels backed by WatermelonDB and the editor bridge. These tests
// cover the screen's own menu wiring, so the panels are stubs that expose the props it passes.

let mockEmitMenuAction: (action: MenuAction) => void = () => {
  throw new Error("menu action listener not registered");
};
jest.mock("@/lib/native/menu-manager", () => ({
  setupMenus: jest.fn(),
  updateMenuState: jest.fn(),
  setEnabledMenuActions: jest.fn(),
  addMenuActionListener: jest.fn((callback: (action: MenuAction) => void) => {
    mockEmitMenuAction = callback;
    return jest.fn();
  }),
}));

jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
}));

let mockNotebooks: Array<{ id: string }> = [];
jest.mock("@/hooks/use-notebooks", () => ({
  useNotebooks: () => ({ notebooks: mockNotebooks, loading: false, error: null }),
}));

type CreatedNote = Record<string, unknown> & { _raw: Record<string, unknown> };
const mockCreatedNotes: CreatedNote[] = [];
jest.mock("@/db", () => ({
  database: {
    write: async (work: () => Promise<void>) => work(),
    get: () => ({
      create: async (build: (note: CreatedNote) => void) => {
        const note: CreatedNote = { _raw: {} };
        build(note);
        mockCreatedNotes.push(note);
      },
    }),
  },
}));

jest.mock("@/lib/generate-id", () => ({ generateId: () => "new-note-id" }));

let mockSidebarProps: { onSelectNotebook: (id: string) => void; onToggleTrash: () => void };
jest.mock("@/components/sidebar/notebooks-sidebar", () => ({
  NotebooksSidebar: (props: typeof mockSidebarProps) => {
    mockSidebarProps = props;
    return null;
  },
}));

let mockNoteListProps: { notebookId: string | undefined; selectedNoteId: string | undefined };
jest.mock("@/components/notes/note-list", () => ({
  NoteList: (props: typeof mockNoteListProps) => {
    mockNoteListProps = props;
    return null;
  },
}));

jest.mock("@/components/notes/note-editor-panel", () => ({ NoteEditorPanel: () => null }));
jest.mock("@/components/notes/trash-list", () => ({ TrashList: () => null }));
jest.mock("@/components/search/search-overlay", () => ({ SearchOverlay: () => null }));
jest.mock("@/components/offline-banner", () => ({ OfflineBanner: () => null }));

function newNoteEnabled(): boolean {
  const calls = jest.mocked(setEnabledMenuActions).mock.calls;
  return (calls[calls.length - 1]?.[0] ?? []).includes("newNote");
}

const app = () => (
  <MenuProvider>
    <MainScreen />
  </MenuProvider>
);

describe("MainScreen menu actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatedNotes.length = 0;
    mockNotebooks = [{ id: "notebook-1" }, { id: "notebook-2" }];
  });

  it("keeps New Note disabled until a notebook is selected, then creates the note there", async () => {
    render(app());
    expect(newNoteEnabled()).toBe(false);

    act(() => mockSidebarProps.onSelectNotebook("notebook-2"));
    expect(newNoteEnabled()).toBe(true);

    await act(async () => mockEmitMenuAction("newNote"));

    expect(mockCreatedNotes).toHaveLength(1);
    expect(mockCreatedNotes[0]).toMatchObject({
      notebookId: "notebook-2",
      userId: "user-1",
      title: "Untitled",
      isTrashed: false,
    });
    expect(mockNoteListProps.selectedNoteId).toBe("new-note-id");
  });

  it("uses the notebook selected most recently, not the first one", async () => {
    render(app());
    act(() => mockSidebarProps.onSelectNotebook("notebook-1"));
    act(() => mockSidebarProps.onSelectNotebook("notebook-2"));

    await act(async () => mockEmitMenuAction("newNote"));

    expect(mockCreatedNotes.map((note) => note.notebookId)).toEqual(["notebook-2"]);
  });

  it("treats a deleted notebook as unselected", async () => {
    const { rerender } = render(app());
    act(() => mockSidebarProps.onSelectNotebook("notebook-1"));
    expect(newNoteEnabled()).toBe(true);

    mockNotebooks = [{ id: "notebook-2" }];
    rerender(app());

    expect(newNoteEnabled()).toBe(false);
    expect(mockNoteListProps.notebookId).toBeUndefined();
    await act(async () => mockEmitMenuAction("newNote"));
    expect(mockCreatedNotes).toHaveLength(0);
  });

  it("disables New Note while Trash is showing", () => {
    render(app());
    act(() => mockSidebarProps.onSelectNotebook("notebook-1"));

    act(() => mockSidebarProps.onToggleTrash());

    expect(newNoteEnabled()).toBe(false);
  });
});
