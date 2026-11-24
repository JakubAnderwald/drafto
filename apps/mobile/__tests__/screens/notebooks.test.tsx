import React from "react";
import { Alert, FlatList, Keyboard, StyleSheet } from "react-native";
import { BottomTabBarHeightContext } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Q } from "@nozbe/watermelondb";

import * as SecureStore from "expo-secure-store";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import { swipeActionLabels, triggerSwipeAction } from "../helpers/swipe-actions";
import NotebooksScreen from "../../app/(tabs)/index";
import { FAB_MARGIN, FAB_SIZE, LIST_RESTING_PADDING } from "@/components/ui/fab";
import { spacing } from "@/theme/tokens";

const mockedInsets = jest.mocked(useSafeAreaInsets);
const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  Link: ({ children, ...props }: { children: React.ReactNode }) => {
    const { Text } = require("react-native");
    return <Text {...props}>{children}</Text>;
  },
}));

const mockSync = jest.fn().mockResolvedValue(undefined);
let mockIsSyncing = false;
const mockDatabaseWrite = jest.fn();
const mockDatabaseGet = jest.fn();

jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    session: {},
    isApproved: true,
    isLoading: false,
  }),
}));

jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => ({
    database: {
      write: mockDatabaseWrite,
      get: mockDatabaseGet,
    },
    sync: mockSync,
    isSyncing: mockIsSyncing,
    hasPendingChanges: false,
    pendingChangesCount: 0,
    lastSyncedAt: null,
  }),
}));

const mockNotebooks: Array<{
  id: string;
  name: string;
  updatedAt: Date;
}> = [];
let mockLoading = false;

jest.mock("@/hooks/use-notebooks", () => ({
  useNotebooks: () => ({
    notebooks: mockNotebooks,
    loading: mockLoading,
  }),
}));

jest.mock("@/hooks/use-haptics", () => ({
  useHaptics: () => ({
    light: jest.fn(),
    medium: jest.fn(),
    heavy: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    selection: jest.fn(),
  }),
}));

jest.mock("@/lib/generate-id", () => ({
  generateId: () => "generated-id-1",
}));

// Each row's note count (PrimeTestLab 11035 S-03), by notebook id; unknown (null) unless a test sets one.
const mockNoteCounts: Record<string, number> = {};
jest.mock("@/hooks/use-notebook-note-count", () => ({
  useNotebookNoteCount: (id: string) => mockNoteCounts[id] ?? null,
}));

// The notebooks stored in WatermelonDB, as the in-writer name check reads them
// (PrimeTestLab 11035 CodeRabbit). Defaults to what the list shows; a test can store more.
let mockStoredNotebooks: { id: string; name: string }[] | null = null;
const storedNotebooksQuery = () => ({
  fetch: jest.fn(async () => mockStoredNotebooks ?? [...mockNotebooks]),
});

describe("NotebooksScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotebooks.length = 0;
    for (const id of Object.keys(mockNoteCounts)) delete mockNoteCounts[id];
    mockLoading = false;
    mockStoredNotebooks = null;
    mockIsSyncing = false;
    mockSync.mockResolvedValue(undefined);
    mockedInsets.mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0 });
    mockSecureStore.getItemAsync.mockResolvedValue(null);
  });

  describe("swipe hint (PrimeTestLab 10668 S-03)", () => {
    it("shows the notebooks hint until it is dismissed, and remembers that", async () => {
      mockNotebooks.push({ id: "nb-1", name: "Work Notes", updatedAt: new Date() });
      const { findByTestId, getByTestId, queryByTestId, getByText } = render(<NotebooksScreen />);

      expect(await findByTestId("swipe-hint")).toBeTruthy();
      expect(getByText(/Swipe left on a notebook to delete it/)).toBeTruthy();
      expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("drafto_swipe_hint_seen_notebooks");

      fireEvent.press(getByTestId("swipe-hint-dismiss"));

      expect(queryByTestId("swipe-hint")).toBeNull();
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        "drafto_swipe_hint_seen_notebooks",
        "1",
      );
    });

    it("stays hidden once dismissed on this device", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("1");
      mockNotebooks.push({ id: "nb-1", name: "Work Notes", updatedAt: new Date() });
      const { queryByTestId } = render(<NotebooksScreen />);

      await act(async () => {});

      expect(queryByTestId("swipe-hint")).toBeNull();
    });

    it("leaves the empty state alone", async () => {
      const { queryByTestId, getByText } = render(<NotebooksScreen />);

      await act(async () => {});

      expect(getByText("No notebooks yet")).toBeTruthy();
      expect(queryByTestId("swipe-hint")).toBeNull();
    });

    it("offers Delete notebook to screen readers", () => {
      mockNotebooks.push({ id: "nb-1", name: "Work Notes", updatedAt: new Date() });
      const { getByText } = render(<NotebooksScreen />);

      expect(swipeActionLabels(getByText("Work Notes"))).toEqual(["Delete notebook"]);
    });

    it("keeps long-press as rename", () => {
      mockNotebooks.push({ id: "nb-1", name: "Work Notes", updatedAt: new Date() });
      const { getByText, getByDisplayValue } = render(<NotebooksScreen />);

      fireEvent(getByText("Work Notes"), "longPress");

      expect(getByDisplayValue("Work Notes")).toBeTruthy();
    });
  });

  describe("bottom tab bar (PrimeTestLab 10668 M-01)", () => {
    // The tab bar already takes the system inset, so adding it again here
    // would float the button a nav-bar's height above the tab bar. The tab
    // navigator provides BottomTabBarHeightContext, which is how the FAB
    // knows it is on a tab screen.
    function renderInTabs() {
      return render(
        <BottomTabBarHeightContext.Provider value={49}>
          <NotebooksScreen />
        </BottomTabBarHeightContext.Provider>,
      );
    }

    beforeEach(() => {
      mockedInsets.mockReturnValue({ top: 24, bottom: 48, left: 0, right: 0 });
      mockNotebooks.push({ id: "nb-1", name: "Work Notes", updatedAt: new Date() });
    });

    it("does not add the system inset under the tab bar", () => {
      const { getByTestId } = renderInTabs();

      expect(StyleSheet.flatten(getByTestId("add").props.style).bottom).toBe(spacing.xl);
    });

    it("labels the add button for screen readers", () => {
      const { getByRole } = renderInTabs();

      expect(getByRole("button", { name: "New notebook" })).toBeTruthy();
    });

    it("pads the list so the last notebook clears the add button only", () => {
      const { UNSAFE_getByType } = renderInTabs();

      const content = StyleSheet.flatten(UNSAFE_getByType(FlatList).props.contentContainerStyle);
      expect(content.paddingBottom).toBe(FAB_SIZE + FAB_MARGIN * 2);
    });

    it("drops back to the resting padding while the create bar hides the button", () => {
      const { getByTestId, queryByTestId, UNSAFE_getByType } = renderInTabs();

      fireEvent.press(getByTestId("add"));

      expect(queryByTestId("add")).toBeNull();
      const content = StyleSheet.flatten(UNSAFE_getByType(FlatList).props.contentContainerStyle);
      expect(content.paddingBottom).toBe(LIST_RESTING_PADDING);
    });
  });

  it("does not show the refresh spinner for a background sync", () => {
    mockIsSyncing = true;
    mockNotebooks.push({ id: "nb-1", name: "Work Notes", updatedAt: new Date() });

    const { UNSAFE_getByType } = render(<NotebooksScreen />);

    expect(UNSAFE_getByType(FlatList).props.refreshControl.props.refreshing).toBe(false);
  });

  it("shows the refresh spinner after a pull until the sync finishes", async () => {
    let finishSync!: () => void;
    mockSync.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSync = resolve;
      }),
    );
    mockNotebooks.push({ id: "nb-1", name: "Work Notes", updatedAt: new Date() });
    const { UNSAFE_getByType } = render(<NotebooksScreen />);
    const refreshControl = () => UNSAFE_getByType(FlatList).props.refreshControl;

    act(() => {
      refreshControl().props.onRefresh();
    });

    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(refreshControl().props.refreshing).toBe(true);

    await act(async () => {
      finishSync();
    });

    expect(refreshControl().props.refreshing).toBe(false);
  });

  it("renders empty state when no notebooks", () => {
    const { getByText } = render(<NotebooksScreen />);

    expect(getByText("No notebooks yet")).toBeTruthy();
    expect(getByText("Tap + to create one")).toBeTruthy();
  });

  it("renders list of notebooks", () => {
    mockNotebooks.push(
      { id: "nb-1", name: "Work Notes", updatedAt: new Date() },
      { id: "nb-2", name: "Personal", updatedAt: new Date() },
    );

    const { getByText } = render(<NotebooksScreen />);

    expect(getByText("Work Notes")).toBeTruthy();
    expect(getByText("Personal")).toBeTruthy();
  });

  it("shows create input when FAB is pressed", () => {
    const { getByText, getByPlaceholderText } = render(<NotebooksScreen />);

    // Press the FAB (the "add" icon text rendered by our mock)
    fireEvent.press(getByText("add"));

    expect(getByPlaceholderText("Notebook name")).toBeTruthy();
  });

  it("navigates to notebook when pressed", () => {
    mockNotebooks.push({
      id: "nb-1",
      name: "Work Notes",
      updatedAt: new Date(),
    });

    const { getByText } = render(<NotebooksScreen />);

    fireEvent.press(getByText("Work Notes"));

    expect(mockPush).toHaveBeenCalledWith("/notebooks/nb-1");
  });

  it("creates a notebook when name is submitted", async () => {
    mockDatabaseWrite.mockImplementation(async (fn: () => Promise<void>) => {
      await fn();
    });
    mockDatabaseGet.mockReturnValue({
      create: jest.fn(),
      query: storedNotebooksQuery,
    });

    const { getByText, getByPlaceholderText } = render(<NotebooksScreen />);

    // Open create bar
    fireEvent.press(getByText("add"));

    // Type name and submit
    fireEvent.changeText(getByPlaceholderText("Notebook name"), "New Notebook");
    fireEvent(getByPlaceholderText("Notebook name"), "submitEditing");

    await waitFor(() => {
      expect(mockDatabaseWrite).toHaveBeenCalled();
    });
  });

  it("blocks deleting a notebook with non-trashed notes (filtered) and writes nothing", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    mockNotebooks.push({ id: "nb-1", name: "Work Notes", updatedAt: new Date() });
    const notesQuery = jest.fn(() => ({
      fetchCount: jest.fn().mockResolvedValue(2),
      fetch: jest.fn().mockResolvedValue([]),
    }));
    mockDatabaseGet.mockImplementation((table: string) => {
      if (table === "notes") return { query: notesQuery };
      return {};
    });

    const { getByText } = render(<NotebooksScreen />);
    triggerSwipeAction(getByText("Work Notes"), "Delete notebook");

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "Cannot Delete Notebook",
        "Cannot delete notebook with notes. Move or delete notes first.",
      ),
    );
    // The guard must count NON-trashed notes only, not all notes.
    expect(notesQuery).toHaveBeenCalledWith(
      Q.where("notebook_id", "nb-1"),
      Q.where("is_trashed", false),
    );
    expect(mockDatabaseWrite).not.toHaveBeenCalled();
  });

  it("deletes an empty notebook and cascades its trashed notes after the user confirms", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const notebookMarkAsDeleted = jest.fn();
    const trashedNoteMarkAsDeleted = jest.fn();
    const attachmentMarkAsDeleted = jest.fn();
    mockNotebooks.push({ id: "nb-1", name: "Empty NB", updatedAt: new Date() });
    mockDatabaseWrite.mockImplementation(async (fn: () => Promise<void>) => {
      await fn();
    });
    mockDatabaseGet.mockImplementation((table: string) => {
      if (table === "notes") {
        return {
          query: () => ({
            fetchCount: jest.fn().mockResolvedValue(0),
            fetch: jest
              .fn()
              .mockResolvedValue([
                { id: "t1", isTrashed: true, markAsDeleted: trashedNoteMarkAsDeleted },
              ]),
          }),
        };
      }
      if (table === "notebooks") {
        return { find: jest.fn().mockResolvedValue({ markAsDeleted: notebookMarkAsDeleted }) };
      }
      if (table === "attachments") {
        return {
          query: () => ({
            fetch: jest
              .fn()
              .mockResolvedValue([{ id: "a1", markAsDeleted: attachmentMarkAsDeleted }]),
          }),
        };
      }
      return {};
    });

    const { getByText } = render(<NotebooksScreen />);
    triggerSwipeAction(getByText("Empty NB"), "Delete notebook");

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "Delete Notebook",
        expect.stringContaining("permanently deleted"),
        expect.any(Array),
      ),
    );
    // Nothing is deleted until the user confirms.
    expect(mockDatabaseWrite).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls.at(-1)?.[2] as Array<{
      text: string;
      onPress?: () => void | Promise<void>;
    }>;
    await buttons.find((b) => b.text === "Delete")?.onPress?.();

    await waitFor(() => expect(notebookMarkAsDeleted).toHaveBeenCalled());
    expect(trashedNoteMarkAsDeleted).toHaveBeenCalled();
    expect(attachmentMarkAsDeleted).toHaveBeenCalled();
    expect(mockDatabaseWrite).toHaveBeenCalled();
  });

  it("aborts at confirm time if a note raced into the notebook after the guard passed", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const notebookMarkAsDeleted = jest.fn();
    mockNotebooks.push({ id: "nb-1", name: "Empty NB", updatedAt: new Date() });
    mockDatabaseWrite.mockImplementation(async (fn: () => Promise<void>) => {
      await fn();
    });
    mockDatabaseGet.mockImplementation((table: string) => {
      if (table === "notes") {
        return {
          query: () => ({
            fetchCount: jest.fn().mockResolvedValue(0), // guard passes...
            fetch: jest
              .fn()
              .mockResolvedValue([{ id: "n1", isTrashed: false, markAsDeleted: jest.fn() }]), // ...but a note raced in
          }),
        };
      }
      if (table === "notebooks") {
        return { find: jest.fn().mockResolvedValue({ markAsDeleted: notebookMarkAsDeleted }) };
      }
      return {};
    });

    const { getByText } = render(<NotebooksScreen />);
    triggerSwipeAction(getByText("Empty NB"), "Delete notebook");
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());

    const buttons = alertSpy.mock.calls.at(-1)?.[2] as Array<{
      text: string;
      onPress?: () => void | Promise<void>;
    }>;
    await buttons.find((b) => b.text === "Delete")?.onPress?.();

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "Cannot Delete Notebook",
        "Cannot delete notebook with notes. Move or delete notes first.",
      ),
    );
    expect(mockDatabaseWrite).not.toHaveBeenCalled();
    expect(notebookMarkAsDeleted).not.toHaveBeenCalled();
  });
  describe("duplicate names (PrimeTestLab 11035 M-01)", () => {
    const DUPLICATE_MESSAGE =
      'A notebook named "Project Ideas" already exists. Choose a different name.';

    function openCreateBar(utils: ReturnType<typeof render>) {
      fireEvent.press(utils.getByTestId("add"));
      return utils.getByTestId("notebook-name-input");
    }

    beforeEach(() => {
      mockNotebooks.push(
        { id: "nb-1", name: "Project Ideas", updatedAt: new Date() },
        { id: "nb-2", name: "Recipes", updatedAt: new Date() },
      );
      mockDatabaseWrite.mockImplementation(async (fn: () => Promise<void>) => {
        await fn();
      });
    });

    it("refuses to create a notebook whose name is taken, and keeps the field open", async () => {
      const create = jest.fn();
      mockDatabaseGet.mockReturnValue({ create, query: storedNotebooksQuery });
      const utils = render(<NotebooksScreen />);

      const input = openCreateBar(utils);
      fireEvent.changeText(input, "Project Ideas");
      await act(async () => {
        fireEvent(input, "submitEditing");
      });

      expect(utils.getByTestId("notebook-name-error").props.children).toBe(DUPLICATE_MESSAGE);
      expect(utils.getByTestId("notebook-name-input")).toBeTruthy();
      expect(mockDatabaseWrite).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
    });

    it("ignores case and spacing when comparing names", async () => {
      const utils = render(<NotebooksScreen />);

      const input = openCreateBar(utils);
      fireEvent.changeText(input, "  project   IDEAS ");
      await act(async () => {
        fireEvent.press(utils.getAllByTestId("checkmark")[0]);
      });

      expect(utils.getByTestId("notebook-name-error").props.children).toBe(DUPLICATE_MESSAGE);
      expect(mockDatabaseWrite).not.toHaveBeenCalled();
    });

    it("clears the error once the name is edited, and then creates", async () => {
      const create = jest.fn();
      mockDatabaseGet.mockReturnValue({ create, query: storedNotebooksQuery });
      const utils = render(<NotebooksScreen />);

      const input = openCreateBar(utils);
      fireEvent.changeText(input, "Project Ideas");
      await act(async () => {
        fireEvent(input, "submitEditing");
      });
      expect(utils.getByTestId("notebook-name-error")).toBeTruthy();

      fireEvent.changeText(input, "Project Ideas 2");
      expect(utils.queryByTestId("notebook-name-error")).toBeNull();

      await act(async () => {
        fireEvent(input, "submitEditing");
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(utils.queryByTestId("notebook-name-input")).toBeNull();
    });

    it("caps the name at the shared maximum length", () => {
      const utils = render(<NotebooksScreen />);

      expect(openCreateBar(utils).props.maxLength).toBe(100);
    });

    it("refuses to rename a notebook to another notebook's name", async () => {
      const update = jest.fn();
      const find = jest.fn().mockResolvedValue({ update });
      mockDatabaseGet.mockReturnValue({ find, query: storedNotebooksQuery });
      const utils = render(<NotebooksScreen />);

      fireEvent(utils.getByText("Recipes"), "longPress");
      const input = utils.getByDisplayValue("Recipes");
      fireEvent.changeText(input, "project ideas");
      await act(async () => {
        fireEvent(input, "submitEditing");
      });

      expect(utils.getByTestId("notebook-name-error").props.children).toBe(DUPLICATE_MESSAGE);
      // The field stays open with the typed name, so it can be corrected.
      expect(utils.getByDisplayValue("project ideas")).toBeTruthy();
      expect(find).not.toHaveBeenCalled();
      expect(mockDatabaseWrite).not.toHaveBeenCalled();
    });

    it("lets a notebook change only the case of its own name", async () => {
      const draft = { name: "Project Ideas" };
      const update = jest.fn(async (fn: (record: { name: string }) => void) => fn(draft));
      mockDatabaseGet.mockReturnValue({
        find: jest.fn().mockResolvedValue({ update }),
        query: storedNotebooksQuery,
      });
      const utils = render(<NotebooksScreen />);

      fireEvent(utils.getByText("Project Ideas"), "longPress");
      const input = utils.getByDisplayValue("Project Ideas");
      fireEvent.changeText(input, "PROJECT IDEAS");
      await act(async () => {
        fireEvent(input, "submitEditing");
      });

      expect(utils.queryByTestId("notebook-name-error")).toBeNull();
      expect(update).toHaveBeenCalledTimes(1);
      expect(draft.name).toBe("PROJECT IDEAS");
    });
  });

  describe("duplicate names checked inside the write (PrimeTestLab 11035 CodeRabbit)", () => {
    const DUPLICATE_MESSAGE =
      'A notebook named "Project Ideas" already exists. Choose a different name.';

    beforeEach(() => {
      // The list is stale: a sync stored "Project Ideas" after it was read.
      mockNotebooks.push({ id: "nb-2", name: "Recipes", updatedAt: new Date() });
      mockStoredNotebooks = [
        { id: "nb-1", name: "Project Ideas" },
        { id: "nb-2", name: "Recipes" },
      ];
      mockDatabaseWrite.mockImplementation(async (fn: () => Promise<void>) => {
        await fn();
      });
    });

    it("refuses to create a name only the stored notebooks hold, and keeps the field open", async () => {
      const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
      const create = jest.fn();
      mockDatabaseGet.mockReturnValue({ create, query: storedNotebooksQuery });
      const utils = render(<NotebooksScreen />);

      fireEvent.press(utils.getByTestId("add"));
      const input = utils.getByTestId("notebook-name-input");
      fireEvent.changeText(input, "project ideas");
      await act(async () => {
        fireEvent(input, "submitEditing");
      });

      expect(mockDatabaseWrite).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      expect(utils.getByTestId("notebook-name-error").props.children).toBe(DUPLICATE_MESSAGE);
      expect(utils.getByTestId("notebook-name-input")).toBeTruthy();
      expect(alertSpy).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
      alertSpy.mockRestore();
    });

    it("refuses to rename to a name only the stored notebooks hold", async () => {
      const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
      const update = jest.fn();
      mockDatabaseGet.mockReturnValue({
        find: jest.fn().mockResolvedValue({ update }),
        query: storedNotebooksQuery,
      });
      const utils = render(<NotebooksScreen />);

      fireEvent(utils.getByText("Recipes"), "longPress");
      fireEvent.changeText(utils.getByDisplayValue("Recipes"), "Project Ideas");
      await act(async () => {
        fireEvent.press(utils.getByTestId("checkmark"));
      });

      expect(update).not.toHaveBeenCalled();
      expect(utils.getByTestId("notebook-name-error").props.children).toBe(DUPLICATE_MESSAGE);
      expect(utils.getByDisplayValue("Project Ideas")).toBeTruthy();
      expect(alertSpy).not.toHaveBeenCalled();
      alertSpy.mockRestore();
    });

    it("still creates a free name", async () => {
      const create = jest.fn();
      mockDatabaseGet.mockReturnValue({ create, query: storedNotebooksQuery });
      const utils = render(<NotebooksScreen />);

      fireEvent.press(utils.getByTestId("add"));
      fireEvent.changeText(utils.getByTestId("notebook-name-input"), "Travel");
      await act(async () => {
        fireEvent(utils.getByTestId("notebook-name-input"), "submitEditing");
      });

      expect(create).toHaveBeenCalledTimes(1);
      expect(utils.queryByTestId("notebook-name-input")).toBeNull();
    });
  });

  describe("✓ saves on the first tap (PrimeTestLab 11035 E2E)", () => {
    beforeEach(() => {
      mockNotebooks.push(
        { id: "nb-1", name: "Project Ideas", updatedAt: new Date() },
        { id: "nb-2", name: "Recipes", updatedAt: new Date() },
      );
      mockDatabaseWrite.mockImplementation(async (fn: () => Promise<void>) => {
        await fn();
      });
    });

    it("lets taps on the rename row's buttons through while the keyboard is up", () => {
      const { UNSAFE_getByType } = render(<NotebooksScreen />);

      // "never" (the default) spends the first tap closing the keyboard.
      expect(UNSAFE_getByType(FlatList).props.keyboardShouldPersistTaps).toBe("handled");
    });

    it("renames on one tap of the checkmark, then puts the keyboard away", async () => {
      const dismiss = jest.spyOn(Keyboard, "dismiss");
      const draft = { name: "Recipes" };
      const update = jest.fn(async (fn: (record: { name: string }) => void) => fn(draft));
      mockDatabaseGet.mockReturnValue({
        find: jest.fn().mockResolvedValue({ update }),
        query: storedNotebooksQuery,
      });
      const utils = render(<NotebooksScreen />);

      fireEvent(utils.getByText("Recipes"), "longPress");
      fireEvent.changeText(utils.getByDisplayValue("Recipes"), "Cooking");
      await act(async () => {
        fireEvent.press(utils.getByTestId("checkmark"));
      });

      expect(update).toHaveBeenCalledTimes(1);
      expect(draft.name).toBe("Cooking");
      expect(utils.queryByDisplayValue("Cooking")).toBeNull();
      expect(dismiss).toHaveBeenCalled();
      expect(mockSync).toHaveBeenCalled();
      dismiss.mockRestore();
    });

    it("keeps the field and the keyboard up when the checkmark meets a taken name", async () => {
      const dismiss = jest.spyOn(Keyboard, "dismiss");
      const find = jest.fn();
      mockDatabaseGet.mockReturnValue({ find, query: storedNotebooksQuery });
      const utils = render(<NotebooksScreen />);

      fireEvent(utils.getByText("Recipes"), "longPress");
      fireEvent.changeText(utils.getByDisplayValue("Recipes"), "Project Ideas");
      await act(async () => {
        fireEvent.press(utils.getByTestId("checkmark"));
      });

      expect(utils.getByTestId("notebook-name-error")).toBeTruthy();
      expect(utils.getByDisplayValue("Project Ideas")).toBeTruthy();
      expect(find).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      dismiss.mockRestore();
    });

    it("puts the keyboard away when the rename is cancelled", () => {
      const dismiss = jest.spyOn(Keyboard, "dismiss");
      const utils = render(<NotebooksScreen />);

      fireEvent(utils.getByText("Recipes"), "longPress");
      fireEvent.press(utils.getByTestId("close"));

      expect(utils.queryByDisplayValue("Recipes")).toBeNull();
      expect(utils.getByText("Recipes")).toBeTruthy();
      expect(dismiss).toHaveBeenCalled();
      dismiss.mockRestore();
    });

    it("closes the keyboard before opening another notebook mid-rename", () => {
      const dismiss = jest.spyOn(Keyboard, "dismiss");
      const utils = render(<NotebooksScreen />);

      fireEvent(utils.getByText("Recipes"), "longPress");
      fireEvent.press(utils.getByText("Project Ideas"));

      expect(dismiss).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith("/notebooks/nb-1");
      dismiss.mockRestore();
    });

    it("creates on one tap of the checkmark in the create bar", async () => {
      const dismiss = jest.spyOn(Keyboard, "dismiss");
      const create = jest.fn();
      mockDatabaseGet.mockReturnValue({ create, query: storedNotebooksQuery });
      const utils = render(<NotebooksScreen />);

      fireEvent.press(utils.getByTestId("add"));
      fireEvent.changeText(utils.getByTestId("notebook-name-input"), "Travel");
      await act(async () => {
        fireEvent.press(utils.getByTestId("checkmark"));
      });

      expect(create).toHaveBeenCalledTimes(1);
      expect(utils.queryByTestId("notebook-name-input")).toBeNull();
      expect(dismiss).toHaveBeenCalled();
      dismiss.mockRestore();
    });
  });

  describe("note counts (PrimeTestLab 11035 S-03)", () => {
    it("shows each notebook's note count and reads it out after the name", () => {
      mockNotebooks.push(
        { id: "nb-1", name: "Project Ideas", updatedAt: new Date() },
        { id: "nb-2", name: "Recipes", updatedAt: new Date() },
      );
      mockNoteCounts["nb-1"] = 3;
      mockNoteCounts["nb-2"] = 1;

      const utils = render(<NotebooksScreen />);

      expect(utils.getByText("3 notes")).toBeTruthy();
      expect(utils.getByText("1 note")).toBeTruthy();
      // Read out after the name: "Project Ideas, 3 notes".
      expect(utils.getByLabelText("Project Ideas").props.accessibilityValue).toEqual({
        text: "3 notes",
      });
      expect(utils.getByLabelText("Recipes").props.accessibilityValue).toEqual({
        text: "1 note",
      });
    });

    it("shows no count until it is known", () => {
      mockNotebooks.push({ id: "nb-1", name: "Project Ideas", updatedAt: new Date() });

      const utils = render(<NotebooksScreen />);

      expect(utils.queryByTestId("notebook-note-count")).toBeNull();
      expect(utils.getByLabelText("Project Ideas").props.accessibilityValue?.text).toBeUndefined();
    });
  });
});
