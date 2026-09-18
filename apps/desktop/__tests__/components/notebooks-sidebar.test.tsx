import { Alert } from "react-native";
import { Q } from "@nozbe/watermelondb";
import { describeAccountDeletionFailure, type AccountDeletionResult } from "@drafto/shared";

import { render, waitFor, fireEvent, act } from "../helpers/test-utils";
import { NotebooksSidebar } from "@/components/sidebar/notebooks-sidebar";
import {
  DELETE_ACCOUNT_OFFLINE_NOTE,
  DELETE_ACCOUNT_WARNING,
} from "@/components/sidebar/delete-account-panel";
import { spacing } from "@/theme/tokens";

// SyncStatus pulls in useDatabase/useNetworkStatus providers we don't render here. The stub
// renders a host view so the "nothing below the user section" check can see where it sits.
jest.mock("@/components/sync-status", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  return { SyncStatus: () => React.createElement(View, { testID: "sync-status" }) };
});

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

describe("NotebooksSidebar — app menu and delete account", () => {
  type TestInstance = ReturnType<ReturnType<typeof render>["getByTestId"]>;
  const isDisabled = (node: TestInstance) => node.props.accessibilityState?.disabled === true;

  // Sign out and Delete account live behind the ⋯ app menu; open it, then pick an item.
  function openAppMenu(utils: ReturnType<typeof render>) {
    fireEvent.press(utils.getByTestId("app-menu-trigger"));
  }

  function chooseDeleteAccount(utils: ReturnType<typeof render>) {
    openAppMenu(utils);
    fireEvent.press(utils.getByTestId("delete-account-menu-item"));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotebooks.length = 0;
    mockLoading = false;
    mockIsConnected = true;
    mockIsInternetReachable = true;
    mockDeleteAccount.mockResolvedValue({ status: "ok" });
  });

  it("shows the email and the App menu, but no account actions until the menu is opened", () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);
    const { getByText, getByLabelText, queryByLabelText, queryByTestId } = utils;

    expect(getByText("user@example.com")).toBeTruthy();
    expect(getByLabelText("App menu")).toBeTruthy();
    expect(queryByLabelText("Sign out")).toBeNull();
    expect(queryByLabelText("Delete account")).toBeNull();
    expect(queryByTestId("delete-account-menu-item")).toBeNull();
    expect(queryByTestId("delete-account-input")).toBeNull();

    openAppMenu(utils);

    expect(getByLabelText("Sign out")).toBeTruthy();
    const item = utils.getByTestId("delete-account-menu-item");
    expect(item.props.accessibilityLabel).toBe("Delete account");
    expect(isDisabled(item)).toBe(false);
    expect(queryByTestId("delete-account-input")).toBeNull();
  });

  it("signs out from the app menu", () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    openAppMenu(utils);
    fireEvent.press(utils.getByTestId("logout-button"));

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(utils.queryByTestId("app-menu")).toBeNull();
  });

  it("opens the app menu just above the measured user section", () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    fireEvent(utils.getByTestId("sidebar-user-section"), "layout", {
      nativeEvent: { layout: { x: 0, y: 500, width: 220, height: 60 } },
    });
    openAppMenu(utils);

    const menuStyle = Object.assign(
      {},
      ...[utils.getByTestId("app-menu").props.style].flat(Infinity).filter(Boolean),
    );
    expect(menuStyle).toMatchObject({ position: "absolute", bottom: 60 + spacing.xs });
  });

  it("renders nothing below the user section, which the menu position relies on", () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);
    const isInside = (node: TestInstance | null, ancestor: TestInstance): boolean =>
      node === null ? false : node === ancestor || isInside(node.parent, ancestor);

    // findAll walks the tree in document order, so the last host view is the bottom-most one.
    const hostViews = utils.UNSAFE_root.findAll((node) => typeof node.type === "string");
    const lastHostView = hostViews[hostViews.length - 1];
    expect(isInside(lastHostView, utils.getByTestId("sidebar-user-section"))).toBe(true);
  });

  it("opens the confirmation panel when Delete account… is chosen", () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    chooseDeleteAccount(utils);

    expect(utils.getByText(DELETE_ACCOUNT_WARNING)).toBeTruthy();
    expect(utils.getByTestId("delete-account-input")).toBeTruthy();
    expect(utils.queryByTestId("app-menu")).toBeNull();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it("keeps the panel open when Delete account… is chosen again and closes it from Cancel", () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    chooseDeleteAccount(utils);
    chooseDeleteAccount(utils);
    expect(utils.getByTestId("delete-account-input")).toBeTruthy();

    fireEvent.press(utils.getByTestId("delete-account-cancel"));
    expect(utils.queryByTestId("delete-account-input")).toBeNull();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it("keeps the panel and its result on screen when Delete account… is chosen mid-request", async () => {
    let resolveDeletion: (result: AccountDeletionResult) => void = () => {};
    mockDeleteAccount.mockImplementationOnce(
      () =>
        new Promise<AccountDeletionResult>((resolve) => {
          resolveDeletion = resolve;
        }),
    );
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    chooseDeleteAccount(utils);
    fireEvent.changeText(utils.getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(utils.getByTestId("delete-account-confirm"));
    chooseDeleteAccount(utils);

    await act(async () => {
      resolveDeletion({ status: "network" });
    });

    expect(utils.getByTestId("delete-account-input")).toBeTruthy();
    expect(utils.getByText(describeAccountDeletionFailure({ status: "network" }))).toBeTruthy();
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it("disables Delete account… and explains why while offline", () => {
    mockIsConnected = false;
    mockIsInternetReachable = false;
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    // The offline note lives inside the menu now, not in the sidebar.
    expect(utils.queryByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeNull();
    openAppMenu(utils);

    const item = utils.getByTestId("delete-account-menu-item");
    expect(isDisabled(item)).toBe(true);
    expect(utils.getByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeTruthy();

    fireEvent.press(item);
    expect(utils.queryByTestId("delete-account-input")).toBeNull();
  });

  it("disables Delete account… when connected but the internet is known to be unreachable", () => {
    mockIsInternetReachable = false;
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    openAppMenu(utils);

    expect(isDisabled(utils.getByTestId("delete-account-menu-item"))).toBe(true);
    expect(utils.getByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeTruthy();
  });

  it("keeps Delete account… enabled while internet reachability is still unknown", () => {
    mockIsInternetReachable = null;
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    openAppMenu(utils);

    expect(isDisabled(utils.getByTestId("delete-account-menu-item"))).toBe(false);
    expect(utils.queryByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeNull();
  });

  it("does not show the offline note while online", () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    openAppMenu(utils);

    expect(utils.queryByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeNull();
  });

  it("passes the offline state to an already open panel", () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    chooseDeleteAccount(utils);
    fireEvent.changeText(utils.getByTestId("delete-account-input"), "DELETE");
    expect(isDisabled(utils.getByTestId("delete-account-confirm"))).toBe(false);

    mockIsConnected = false;
    utils.rerender(<NotebooksSidebar {...defaultProps} />);

    expect(isDisabled(utils.getByTestId("delete-account-confirm"))).toBe(true);
    expect(utils.getByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeTruthy();
  });

  it("confirms through useAuth().deleteAccount once DELETE is typed", async () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    chooseDeleteAccount(utils);
    fireEvent.changeText(utils.getByTestId("delete-account-input"), "DELETE");
    await act(async () => {
      fireEvent.press(utils.getByTestId("delete-account-confirm"));
    });

    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
