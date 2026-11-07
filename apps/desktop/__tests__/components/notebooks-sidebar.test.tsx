import { ActivityIndicator, Alert, ScrollView, StyleSheet } from "react-native";
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

// Apple-linked only where a test says so; the Apple step is settled by hand.
const mockAppleState = { required: false, userId: "user-1" as string | null };
jest.mock("@/hooks/use-apple-deletion-confirmation", () => ({
  useAppleDeletionConfirmation: () => mockAppleState,
}));
const mockStartAppleConfirmation = jest.fn();
jest.mock("@/lib/apple-revocation", () => ({
  startAppleConfirmation: () => mockStartAppleConfirmation(),
}));

const mockSync = jest.fn();
jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => ({ database: {}, sync: mockSync }),
}));

const mockCountUnsyncedChanges = jest.fn();
jest.mock("@/lib/data/unsynced-changes", () => ({
  countUnsyncedChanges: (...args: unknown[]) => mockCountUnsyncedChanges(...args),
}));

let mockIsConnected = true;
let mockIsInternetReachable: boolean | null = true;
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({
    isConnected: mockIsConnected,
    isInternetReachable: mockIsInternetReachable,
  }),
}));

const mockNotebooks: Array<{
  id: string;
  name: string;
  markAsDeleted: jest.Mock;
  update?: jest.Mock;
}> = [];
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
    mockAppleState.required = false;
    mockDeleteAccount.mockResolvedValue({ status: "ok" });
    mockSignOut.mockResolvedValue(undefined);
    mockSync.mockResolvedValue(undefined);
    mockCountUnsyncedChanges.mockResolvedValue(0);
    jest.spyOn(Alert, "alert").mockImplementation(() => {});
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

  it("signs out from the app menu", async () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    openAppMenu(utils);
    fireEvent.press(utils.getByTestId("logout-button"));

    expect(utils.queryByTestId("app-menu")).toBeNull();
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("shows sign-out progress in the user row and hides the menu trigger meanwhile", async () => {
    let finishSync: () => void = () => {};
    mockSync.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSync = resolve;
      }),
    );
    mockCountUnsyncedChanges.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    openAppMenu(utils);
    fireEvent.press(utils.getByTestId("logout-button"));

    await waitFor(() => {
      expect(utils.getByTestId("sign-out-progress")).toBeTruthy();
    });
    expect(utils.getByText("Signing out…")).toBeTruthy();
    expect(utils.queryByTestId("app-menu-trigger")).toBeNull();

    await act(async () => {
      finishSync();
    });

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("keeps an open delete panel mounted but unconfirmable while a sign-out runs", async () => {
    let finishSync: () => void = () => {};
    mockSync.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSync = resolve;
      }),
    );
    mockCountUnsyncedChanges.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    chooseDeleteAccount(utils);
    fireEvent.changeText(utils.getByTestId("delete-account-input"), "DELETE");
    expect(isDisabled(utils.getByTestId("delete-account-confirm"))).toBe(false);
    openAppMenu(utils);
    fireEvent.press(utils.getByTestId("logout-button"));

    await waitFor(() => {
      expect(utils.getByTestId("sign-out-progress")).toBeTruthy();
    });
    // The panel stays (a deletion in flight keeps its progress), but none can start while the
    // device is being signed out and wiped.
    expect(utils.getByTestId("delete-account-input")).toBeTruthy();
    expect(isDisabled(utils.getByTestId("delete-account-confirm"))).toBe(true);
    expect(utils.queryByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeNull();

    await act(async () => {
      finishSync();
    });
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledWith({ skipFinalSync: true });
    });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it("never deletes from the Apple wait while a sign-out runs", async () => {
    mockAppleState.required = true;
    let answerApple: (
      grant: { authorizationCode: string; clientId: string } | null,
    ) => void = () => {};
    const skip = jest.fn(() => answerApple(null));
    mockStartAppleConfirmation.mockReturnValue({
      grant: new Promise((resolve) => {
        answerApple = resolve;
      }),
      skip,
    });
    let finishSync: () => void = () => {};
    mockSync.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSync = resolve;
      }),
    );
    mockCountUnsyncedChanges.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    chooseDeleteAccount(utils);
    fireEvent.changeText(utils.getByTestId("delete-account-input"), "DELETE");
    await act(async () => {
      fireEvent.press(utils.getByTestId("delete-account-confirm"));
    });
    expect(utils.getByTestId("delete-account-apple-waiting")).toBeTruthy();

    // Sign out still works during the wait, since no request is out yet.
    openAppMenu(utils);
    fireEvent.press(utils.getByTestId("logout-button"));
    await waitFor(() => {
      expect(utils.getByTestId("sign-out-progress")).toBeTruthy();
    });

    // Neither way out of the Apple step deletes while the sign-out's last sync runs.
    const skipButton = utils.getByTestId("delete-account-apple-skip");
    expect(isDisabled(skipButton)).toBe(true);
    fireEvent.press(skipButton);
    expect(skip).not.toHaveBeenCalled();
    await act(async () => {
      answerApple({ authorizationCode: "apple-code", clientId: "eu.drafto.web.auth" });
    });
    expect(mockDeleteAccount).not.toHaveBeenCalled();

    await act(async () => {
      finishSync();
    });
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledWith({ skipFinalSync: true });
    });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it("ignores Sign out while an account deletion is in flight", async () => {
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
    openAppMenu(utils);
    fireEvent.press(utils.getByTestId("logout-button"));

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockCountUnsyncedChanges).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();

    // After a failed deletion, Sign out works again.
    await act(async () => {
      resolveDeletion({ status: "network" });
    });
    openAppMenu(utils);
    fireEvent.press(utils.getByTestId("logout-button"));
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });
  });

  it("asks before signing out with changes a last sync could not push", async () => {
    mockCountUnsyncedChanges.mockResolvedValue(3);
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    openAppMenu(utils);
    fireEvent.press(utils.getByTestId("logout-button"));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith(
        "Sign out?",
        "3 changes haven't synced and will be lost.",
        expect.any(Array),
        expect.anything(),
      );
    });
    expect(mockSync).toHaveBeenCalledTimes(1);
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2] as Array<{
      text: string;
      style?: string;
      onPress?: () => void;
    }>;
    expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Sign out anyway"]);
    expect(buttons[1].style).toBe("destructive");

    await act(async () => {
      buttons[0].onPress?.();
    });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(utils.getByTestId("app-menu-trigger")).toBeTruthy();
    expect(utils.getByText("user@example.com")).toBeTruthy();

    openAppMenu(utils);
    fireEvent.press(utils.getByTestId("logout-button"));
    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      ((Alert.alert as jest.Mock).mock.calls[1][2] as typeof buttons)[1].onPress?.();
    });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
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

describe("NotebooksSidebar — notebook list scrolls", () => {
  type TestInstance = ReturnType<ReturnType<typeof render>["getByTestId"]>;
  const isInside = (node: TestInstance | null, ancestor: TestInstance): boolean =>
    node === null ? false : node === ancestor || isInside(node.parent, ancestor);
  // The nearest native view above a node, skipping composite components.
  const hostParent = (node: TestInstance): TestInstance | null => {
    let parent = node.parent;
    while (parent !== null && typeof parent.type !== "string") parent = parent.parent;
    return parent;
  };

  const NOTEBOOK_COUNT = 50;
  const LAST_NAME = `Notebook ${NOTEBOOK_COUNT}`;

  // The row is the Pressable labelled with the notebook's name; its delete "×" is the
  // hover-revealed Pressable inside it (see findDeleteButton above).
  function findRowDeleteButton(utils: ReturnType<typeof render>, name: string): PressableNode {
    const row = utils.getByLabelText(name);
    const matches = utils.UNSAFE_root.findAll(
      (node) =>
        node.props?.accessibilityLabel === "Delete notebook" &&
        typeof node.props?.onPress === "function" &&
        isInside(node, row),
    );
    return matches[0] as unknown as PressableNode;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotebooks.length = 0;
    for (let i = 1; i <= NOTEBOOK_COUNT; i++) {
      mockNotebooks.push({ id: `nb-${i}`, name: `Notebook ${i}`, markAsDeleted: jest.fn() });
    }
    mockLoading = false;
    mockIsConnected = true;
    mockIsInternetReachable = true;
    mockNoteFetch.mockResolvedValue([]);
    mockGet.mockImplementation((table: string) => {
      if (table === "notes") return { query: mockNotesQuery };
      return {};
    });
    jest.spyOn(Alert, "alert").mockImplementation(() => {});
  });

  it("puts every notebook row inside one vertical scroll container that fills the space", () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    const list = utils.getByTestId("notebook-list");
    const scrollView = utils.UNSAFE_getByType(ScrollView);
    expect(scrollView.props.testID).toBe("notebook-list");
    expect(isInside(list, scrollView)).toBe(true);
    expect(scrollView.props.horizontal).toBeFalsy();
    expect(StyleSheet.flatten(scrollView.props.style)).toMatchObject({ flex: 1 });

    for (const nb of mockNotebooks) {
      expect(isInside(utils.getByLabelText(nb.name), list)).toBe(true);
    }
  });

  it("keeps the headers and the footer (Trash, sync status, user section) outside the list", () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);
    const list = utils.getByTestId("notebook-list");

    for (const label of ["Search", "New notebook", "Trash", "App menu"]) {
      expect(isInside(utils.getByLabelText(label), list)).toBe(false);
    }
    expect(isInside(utils.getByText("NOTEBOOKS"), list)).toBe(false);
    expect(isInside(utils.getByTestId("sync-status"), list)).toBe(false);
    expect(isInside(utils.getByTestId("sidebar-user-section"), list)).toBe(false);

    // The list and the footer are siblings in the same column, so the list's flex: 1 takes
    // exactly the space the footer leaves.
    const footer = hostParent(utils.getByLabelText("Trash"));
    expect(footer).not.toBeNull();
    expect(isInside(utils.getByTestId("sidebar-user-section"), footer as TestInstance)).toBe(true);
    // A boolean, so a failure doesn't make jest print two whole render trees.
    expect(hostParent(list) === hostParent(footer as TestInstance)).toBe(true);
  });

  it("shows the loading spinner in place of the list while notebooks load", () => {
    mockLoading = true;
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    const spinners = utils.UNSAFE_getAllByType(ActivityIndicator);
    expect(spinners).toHaveLength(1);
    expect(utils.queryByTestId("notebook-list")).toBeNull();
    expect(utils.queryByLabelText(LAST_NAME)).toBeNull();

    // Same slot as the list: after the section header, before the footer, and nothing below
    // the user section.
    const hostNodes = utils.UNSAFE_root.findAll((node) => typeof node.type === "string");
    const spinnerAt = hostNodes.findIndex((node) => isInside(node, spinners[0]));
    expect(spinnerAt).toBeGreaterThan(hostNodes.indexOf(utils.getByText("NOTEBOOKS")));
    expect(spinnerAt).toBeLessThan(hostNodes.indexOf(utils.getByLabelText("Trash")));
    expect(
      isInside(hostNodes[hostNodes.length - 1], utils.getByTestId("sidebar-user-section")),
    ).toBe(true);
  });

  it("keeps the create-notebook input above the list, outside it, and still creates", async () => {
    const create = jest.fn();
    mockGet.mockImplementation((table: string) => {
      if (table === "notebooks") return { create };
      if (table === "notes") return { query: mockNotesQuery };
      return {};
    });
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    fireEvent.press(utils.getByLabelText("New notebook"));
    const input = utils.getByPlaceholderText("Notebook name");
    const list = utils.getByTestId("notebook-list");
    expect(isInside(input, list)).toBe(false);

    // Document order: the create row sits between the section header and the list.
    const hostNodes = utils.UNSAFE_root.findAll((node) => typeof node.type === "string");
    expect(hostNodes.indexOf(input)).toBeLessThan(hostNodes.indexOf(list));
    expect(hostNodes.indexOf(utils.getByText("NOTEBOOKS"))).toBeLessThan(hostNodes.indexOf(input));

    fireEvent.changeText(input, "Recipes");
    await act(async () => {
      fireEvent(input, "submitEditing");
    });

    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(utils.queryByPlaceholderText("Notebook name")).toBeNull();
  });

  it("selects a notebook you have to scroll to", () => {
    const onSelectNotebook = jest.fn();
    const utils = render(
      <NotebooksSidebar {...defaultProps} onSelectNotebook={onSelectNotebook} />,
    );

    fireEvent.press(utils.getByLabelText(LAST_NAME));

    expect(onSelectNotebook).toHaveBeenCalledWith(`nb-${NOTEBOOK_COUNT}`);
  });

  it("renames a notebook you have to scroll to, inline inside the list", async () => {
    const last = mockNotebooks[NOTEBOOK_COUNT - 1];
    const draft = { name: last.name };
    last.update = jest.fn(async (fn: (nb: { name: string }) => void) => fn(draft));
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    fireEvent(utils.getByLabelText(LAST_NAME), "longPress");
    const input = utils.getByDisplayValue(LAST_NAME);
    expect(isInside(input, utils.getByTestId("notebook-list"))).toBe(true);

    fireEvent.changeText(input, "Recipes");
    await act(async () => {
      fireEvent(input, "submitEditing");
    });

    expect(last.update).toHaveBeenCalledTimes(1);
    expect(draft.name).toBe("Recipes");
    expect(utils.queryByDisplayValue("Recipes")).toBeNull();
  });

  it("runs the delete guard for a notebook you have to scroll to", async () => {
    mockNoteFetchCount.mockResolvedValue(2);
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    await findRowDeleteButton(utils, LAST_NAME).props.onPress();

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        "Cannot Delete Notebook",
        "Cannot delete notebook with notes. Move or delete notes first.",
      ),
    );
    expect(mockNotesQuery).toHaveBeenCalledWith(
      Q.where("notebook_id", `nb-${NOTEBOOK_COUNT}`),
      Q.where("is_trashed", false),
    );
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockNotebooks[NOTEBOOK_COUNT - 1].markAsDeleted).not.toHaveBeenCalled();
  });

  it("still renders nothing below the user section with a long list", () => {
    const utils = render(<NotebooksSidebar {...defaultProps} />);

    const hostViews = utils.UNSAFE_root.findAll((node) => typeof node.type === "string");
    const lastHostView = hostViews[hostViews.length - 1];
    expect(isInside(lastHostView, utils.getByTestId("sidebar-user-section"))).toBe(true);
  });
});
