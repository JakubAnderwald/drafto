import { Alert } from "react-native";
import { Q } from "@nozbe/watermelondb";
import { describeAccountDeletionFailure, type AccountDeletionResult } from "@drafto/shared";

import { render, waitFor, fireEvent, act } from "../helpers/test-utils";
import { NotebooksSidebar } from "@/components/sidebar/notebooks-sidebar";
import {
  DELETE_ACCOUNT_OFFLINE_NOTE,
  DELETE_ACCOUNT_WARNING,
} from "@/components/sidebar/delete-account-panel";

// SyncStatus pulls in useDatabase/useNetworkStatus providers we don't render here.
jest.mock("@/components/sync-status", () => ({ SyncStatus: () => null }));

const mockSignOut = jest.fn();
const mockDeleteAccount = jest.fn();
jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "user@example.com" },
    signOut: mockSignOut,
    deleteAccount: mockDeleteAccount,
  }),
}));

let mockIsConnected = true;
let mockIsInternetReachable: boolean | null = true;
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({
    isConnected: mockIsConnected,
    isInternetReachable: mockIsInternetReachable,
  }),
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

describe("NotebooksSidebar — delete account", () => {
  type TestInstance = ReturnType<ReturnType<typeof render>["getByTestId"]>;
  const isDisabled = (node: TestInstance) => node.props.accessibilityState?.disabled === true;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotebooks.length = 0;
    mockLoading = false;
    mockIsConnected = true;
    mockIsInternetReachable = true;
    mockDeleteAccount.mockResolvedValue({ status: "ok" });
  });

  it("offers Delete account next to Sign out, with the panel closed", () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(
      <NotebooksSidebar {...defaultProps} />,
    );

    const row = getByTestId("delete-account-row");
    expect(row.props.accessibilityLabel).toBe("Delete account");
    expect(isDisabled(row)).toBe(false);
    expect(getByLabelText("Sign out")).toBeTruthy();
    expect(queryByTestId("delete-account-input")).toBeNull();
  });

  it("opens the confirmation panel on the first click", () => {
    const { getByTestId, getByText } = render(<NotebooksSidebar {...defaultProps} />);

    fireEvent.press(getByTestId("delete-account-row"));

    expect(getByText(DELETE_ACCOUNT_WARNING)).toBeTruthy();
    expect(getByTestId("delete-account-input")).toBeTruthy();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it("keeps the panel open on a second click on the row and closes it from Cancel", () => {
    const { getByTestId, queryByTestId } = render(<NotebooksSidebar {...defaultProps} />);

    fireEvent.press(getByTestId("delete-account-row"));
    fireEvent.press(getByTestId("delete-account-row"));
    expect(getByTestId("delete-account-input")).toBeTruthy();

    fireEvent.press(getByTestId("delete-account-cancel"));
    expect(queryByTestId("delete-account-input")).toBeNull();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it("keeps the panel and its result on screen when the row is clicked mid-request", async () => {
    let resolveDeletion: (result: AccountDeletionResult) => void = () => {};
    mockDeleteAccount.mockImplementationOnce(
      () =>
        new Promise<AccountDeletionResult>((resolve) => {
          resolveDeletion = resolve;
        }),
    );
    const { getByTestId, getByText } = render(<NotebooksSidebar {...defaultProps} />);

    fireEvent.press(getByTestId("delete-account-row"));
    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(getByTestId("delete-account-confirm"));
    fireEvent.press(getByTestId("delete-account-row"));

    await act(async () => {
      resolveDeletion({ status: "network" });
    });

    expect(getByTestId("delete-account-input")).toBeTruthy();
    expect(getByText(describeAccountDeletionFailure({ status: "network" }))).toBeTruthy();
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it("disables Delete account and explains why while offline", () => {
    mockIsConnected = false;
    mockIsInternetReachable = false;
    const { getByTestId, getByText, queryByTestId } = render(
      <NotebooksSidebar {...defaultProps} />,
    );

    const row = getByTestId("delete-account-row");
    expect(isDisabled(row)).toBe(true);
    expect(getByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeTruthy();

    fireEvent.press(row);
    expect(queryByTestId("delete-account-input")).toBeNull();
  });

  it("disables Delete account when connected but the internet is known to be unreachable", () => {
    mockIsInternetReachable = false;
    const { getByTestId, getByText } = render(<NotebooksSidebar {...defaultProps} />);

    expect(isDisabled(getByTestId("delete-account-row"))).toBe(true);
    expect(getByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeTruthy();
  });

  it("keeps Delete account enabled while internet reachability is still unknown", () => {
    mockIsInternetReachable = null;
    const { getByTestId, queryByText } = render(<NotebooksSidebar {...defaultProps} />);

    expect(isDisabled(getByTestId("delete-account-row"))).toBe(false);
    expect(queryByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeNull();
  });

  it("does not show the offline note while online", () => {
    const { queryByText } = render(<NotebooksSidebar {...defaultProps} />);

    expect(queryByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeNull();
  });

  it("confirms through useAuth().deleteAccount once DELETE is typed", async () => {
    const { getByTestId } = render(<NotebooksSidebar {...defaultProps} />);

    fireEvent.press(getByTestId("delete-account-row"));
    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    await act(async () => {
      fireEvent.press(getByTestId("delete-account-confirm"));
    });

    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
