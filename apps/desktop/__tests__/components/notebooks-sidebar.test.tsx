import { Alert } from "react-native";
import { Q } from "@nozbe/watermelondb";

import { render, waitFor } from "../helpers/test-utils";
import { NotebooksSidebar } from "@/components/sidebar/notebooks-sidebar";

// SyncStatus pulls in useDatabase/useNetworkStatus providers we don't render here.
jest.mock("@/components/sync-status", () => ({ SyncStatus: () => null }));

jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { id: "user-1", email: "user@example.com" }, signOut: jest.fn() }),
}));

const mockNotebooks: Array<{ id: string; name: string; markAsDeleted: jest.Mock }> = [];
let mockLoading = false;
jest.mock("@/hooks/use-notebooks", () => ({
  useNotebooks: () => ({ notebooks: mockNotebooks, loading: mockLoading }),
}));

const mockGet = jest.fn();
const mockWrite = jest.fn(async (fn: () => Promise<void>) => {
  await fn();
});
jest.mock("@/db", () => ({
  database: {
    get: (...args: unknown[]) => mockGet(...args),
    write: (...args: unknown[]) => mockWrite(...args),
  },
}));

const mockNoteFetchCount = jest.fn();
const mockNoteFetch = jest.fn();
// A real jest.fn so we can assert the guard queries with the is_trashed=false predicate.
const mockNotesQuery = jest.fn(() => ({ fetchCount: mockNoteFetchCount, fetch: mockNoteFetch }));

const defaultProps = {
  selectedNotebookId: undefined,
  onSelectNotebook: jest.fn(),
  showTrash: false,
  onToggleTrash: jest.fn(),
  onOpenSearch: jest.fn(),
};

type PressableNode = { props: { onPress: () => void | Promise<void> } };

// The delete "×" is a hover-revealed Pressable (disabled until hovered); grab the
// composite element that carries both the accessibility label and the onPress
// handler and invoke it directly — that is exactly what a click wires up.
function findDeleteButton(root: ReturnType<typeof render>["UNSAFE_root"]): PressableNode {
  const matches = root.findAll(
    (node) =>
      node.props?.accessibilityLabel === "Delete notebook" &&
      typeof node.props?.onPress === "function",
  );
  return matches[0] as unknown as PressableNode;
}

function confirmDelete() {
  const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)?.[2] as Array<{
    text: string;
    onPress?: () => void | Promise<void>;
  }>;
  return buttons.find((b) => b.text === "Delete")?.onPress?.();
}

describe("NotebooksSidebar — delete guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotebooks.length = 0;
    mockLoading = false;
    mockNoteFetch.mockResolvedValue([]);
    mockGet.mockImplementation((table: string) => {
      if (table === "notes") return { query: mockNotesQuery };
      if (table === "attachments")
        return { query: () => ({ fetch: jest.fn().mockResolvedValue([]) }) };
      return {};
    });
    jest.spyOn(Alert, "alert").mockImplementation(() => {});
  });

  it("blocks deletion (filtering on non-trashed notes) and never writes", async () => {
    mockNotebooks.push({ id: "nb-1", name: "Work Notes", markAsDeleted: jest.fn() });
    mockNoteFetchCount.mockResolvedValue(3);

    const { UNSAFE_root } = render(<NotebooksSidebar {...defaultProps} />);
    await findDeleteButton(UNSAFE_root).props.onPress();

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        "Cannot Delete Notebook",
        "Cannot delete notebook with notes. Move or delete notes first.",
      ),
    );
    // The guard must count NON-trashed notes only, not all notes.
    expect(mockNotesQuery).toHaveBeenCalledWith(
      Q.where("notebook_id", "nb-1"),
      Q.where("is_trashed", false),
    );
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockNotebooks[0].markAsDeleted).not.toHaveBeenCalled();
  });

  it("requires confirmation, then cascades trashed notes and deletes the notebook", async () => {
    const markAsDeleted = jest.fn();
    const trashedNoteMarkAsDeleted = jest.fn();
    const attachmentMarkAsDeleted = jest.fn();
    mockNotebooks.push({ id: "nb-1", name: "Empty NB", markAsDeleted });
    mockNoteFetchCount.mockResolvedValue(0);
    mockNoteFetch.mockResolvedValue([
      { id: "t1", isTrashed: true, markAsDeleted: trashedNoteMarkAsDeleted },
    ]);
    mockGet.mockImplementation((table: string) => {
      if (table === "notes") return { query: mockNotesQuery };
      if (table === "attachments")
        return {
          query: () => ({
            fetch: jest
              .fn()
              .mockResolvedValue([{ id: "a1", markAsDeleted: attachmentMarkAsDeleted }]),
          }),
        };
      return {};
    });

    const { UNSAFE_root } = render(<NotebooksSidebar {...defaultProps} />);
    await findDeleteButton(UNSAFE_root).props.onPress();

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        "Delete Notebook",
        expect.stringContaining("permanently deleted"),
        expect.any(Array),
      ),
    );
    // Regression guard: the old code deleted immediately on click; nothing may be
    // written until the user confirms.
    expect(mockWrite).not.toHaveBeenCalled();
    expect(markAsDeleted).not.toHaveBeenCalled();

    await confirmDelete();

    await waitFor(() => expect(markAsDeleted).toHaveBeenCalled());
    expect(mockWrite).toHaveBeenCalled();
    expect(trashedNoteMarkAsDeleted).toHaveBeenCalled();
    expect(attachmentMarkAsDeleted).toHaveBeenCalled();
  });

  it("aborts at confirm time if a note raced into the notebook after the guard passed", async () => {
    const markAsDeleted = jest.fn();
    mockNotebooks.push({ id: "nb-1", name: "Empty NB", markAsDeleted });
    mockNoteFetchCount.mockResolvedValue(0); // guard passes...
    mockNoteFetch.mockResolvedValue([{ id: "n1", isTrashed: false, markAsDeleted: jest.fn() }]); // ...but a note raced in

    const { UNSAFE_root } = render(<NotebooksSidebar {...defaultProps} />);
    await findDeleteButton(UNSAFE_root).props.onPress();
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    await confirmDelete();

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        "Cannot Delete Notebook",
        "Cannot delete notebook with notes. Move or delete notes first.",
      ),
    );
    expect(mockWrite).not.toHaveBeenCalled();
    expect(markAsDeleted).not.toHaveBeenCalled();
  });
});
