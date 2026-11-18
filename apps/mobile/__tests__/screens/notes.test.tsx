import React from "react";
import { Alert, Animated, FlatList, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import { swipeActionLabels, triggerSwipeAction } from "../helpers/swipe-actions";
import NotesListScreen from "../../app/notebooks/[id]";
import { FAB_MARGIN, FAB_SIZE, LIST_RESTING_PADDING } from "@/components/ui/fab";
import { spacing } from "@/theme/tokens";

const mockedInsets = jest.mocked(useSafeAreaInsets);
const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

const mockPush = jest.fn();
const mockStackScreen = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: "nb-1" }),
  Stack: {
    Screen: (props: unknown) => {
      mockStackScreen(props);
      return null;
    },
  },
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

const mockNotes: Array<{
  id: string;
  title: string;
  updatedAt: Date;
}> = [];
let mockLoading = false;

jest.mock("@/hooks/use-notes", () => ({
  useNotes: () => ({
    notes: mockNotes,
    loading: mockLoading,
  }),
}));

let mockNotebookName: string | null = "Work";
jest.mock("@/hooks/use-notebook-name", () => ({
  useNotebookName: () => mockNotebookName,
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
  generateId: () => "generated-note-id-1",
}));

describe("NotesListScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotes.length = 0;
    mockLoading = false;
    mockIsSyncing = false;
    mockNotebookName = "Work";
    mockSync.mockResolvedValue(undefined);
    mockedInsets.mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0 });
    mockSecureStore.getItemAsync.mockResolvedValue(null);
  });

  describe("swipe hint (PrimeTestLab 10668 S-03)", () => {
    beforeEach(() => {
      mockNotes.push(
        { id: "note-1", title: "First Note", updatedAt: new Date() },
        { id: "note-2", title: "Second Note", updatedAt: new Date() },
      );
    });

    it("tells a first-time user that notes swipe to Trash", async () => {
      const { findByTestId, getByText } = render(<NotesListScreen />);

      expect(await findByTestId("swipe-hint")).toBeTruthy();
      expect(getByText(/Swipe left on a note to move it to Trash/)).toBeTruthy();
      expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("drafto_swipe_hint_seen_notes");
    });

    it("hides the hint for good once dismissed", async () => {
      const { findByTestId, queryByTestId } = render(<NotesListScreen />);

      fireEvent.press(await findByTestId("swipe-hint-dismiss"));

      expect(queryByTestId("swipe-hint")).toBeNull();
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        "drafto_swipe_hint_seen_notes",
        "1",
      );
    });

    it("stays hidden once dismissed on this device", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("1");
      const { queryByTestId } = render(<NotesListScreen />);

      await act(async () => {});

      expect(queryByTestId("swipe-hint")).toBeNull();
    });

    it("leaves the empty state alone", async () => {
      mockNotes.length = 0;
      const { queryByTestId, getByText } = render(<NotesListScreen />);

      await act(async () => {});

      expect(getByText("No notes yet")).toBeTruthy();
      expect(queryByTestId("swipe-hint")).toBeNull();
    });

    it("offers Move note to Trash to screen readers, through the usual confirm", () => {
      const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
      const { getByText } = render(<NotesListScreen />);

      expect(swipeActionLabels(getByText("First Note"))).toEqual(["Move note to Trash"]);
      triggerSwipeAction(getByText("First Note"), "Move note to Trash");

      expect(alertSpy).toHaveBeenCalledWith(
        "Move to Trash",
        'Are you sure you want to trash "First Note"?',
        expect.any(Array),
      );
      alertSpy.mockRestore();
    });

    it("keeps long-press as rename", () => {
      const { getByText, getByDisplayValue } = render(<NotesListScreen />);

      fireEvent(getByText("First Note"), "longPress");

      expect(getByDisplayValue("First Note")).toBeTruthy();
    });

    it("slides only the row that was first, once, even after a new note lands on top", async () => {
      const start = jest.fn();
      const sequence = jest.spyOn(Animated, "sequence").mockImplementation(
        () =>
          ({
            start,
            stop: jest.fn(),
            reset: jest.fn(),
          }) as unknown as Animated.CompositeAnimation,
      );
      const { findByTestId, getByText, rerender } = render(<NotesListScreen />);
      await findByTestId("swipe-hint");
      await waitFor(() => expect(sequence).toHaveBeenCalledTimes(1));

      mockNotes.unshift({ id: "note-new", title: "Brand New", updatedAt: new Date() });
      rerender(<NotesListScreen />);
      await act(async () => {});

      expect(getByText("Brand New")).toBeTruthy();
      expect(sequence).toHaveBeenCalledTimes(1);
      expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("drafto_swipe_hint_peeked_notes");
      sequence.mockRestore();
    });

    it("doesn't slide a row on a device where the peek already played", async () => {
      mockSecureStore.getItemAsync.mockImplementation(async (key: string) =>
        key === "drafto_swipe_hint_peeked_notes" ? "1" : null,
      );
      const sequence = jest.spyOn(Animated, "sequence");
      const { findByTestId } = render(<NotesListScreen />);

      expect(await findByTestId("swipe-hint")).toBeTruthy();
      await act(async () => {});

      expect(sequence).not.toHaveBeenCalled();
      sequence.mockRestore();
    });
  });

  function lastHeaderTitle(): unknown {
    const calls = mockStackScreen.mock.calls;
    return (calls[calls.length - 1][0] as { options: { title: unknown } }).options.title;
  }

  it("titles the header with the notebook's name", () => {
    render(<NotesListScreen />);

    expect(lastHeaderTitle()).toBe("Work");
  });

  it("titles the header while the notes are still loading", () => {
    mockLoading = true;

    render(<NotesListScreen />);

    expect(lastHeaderTitle()).toBe("Work");
  });

  it("follows a rename of the notebook", () => {
    const { rerender } = render(<NotesListScreen />);
    mockNotebookName = "Work (2026)";
    rerender(<NotesListScreen />);

    expect(lastHeaderTitle()).toBe("Work (2026)");
  });

  it("passes the same header options while the name is unchanged", () => {
    const { rerender } = render(<NotesListScreen />);
    rerender(<NotesListScreen />);

    const options = mockStackScreen.mock.calls.map(
      ([props]) => (props as { options: object }).options,
    );
    expect(options.length).toBeGreaterThan(1);
    expect(new Set(options).size).toBe(1);
  });

  it("leaves the header blank until the notebook loads, never 'Notes'", () => {
    mockNotebookName = null;

    render(<NotesListScreen />);

    expect(lastHeaderTitle()).toBe("");
  });

  it("does not show the refresh spinner for a background sync", () => {
    mockIsSyncing = true;
    mockNotes.push({ id: "note-1", title: "First Note", updatedAt: new Date() });

    const { UNSAFE_getByType } = render(<NotesListScreen />);

    expect(UNSAFE_getByType(FlatList).props.refreshControl.props.refreshing).toBe(false);
  });

  it("shows the refresh spinner after a pull until the sync finishes", async () => {
    let finishSync!: () => void;
    mockSync.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSync = resolve;
      }),
    );
    mockNotes.push({ id: "note-1", title: "First Note", updatedAt: new Date() });
    const { UNSAFE_getByType } = render(<NotesListScreen />);
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

  it("renders empty state when no notes", () => {
    const { getByText } = render(<NotesListScreen />);

    expect(getByText("No notes yet")).toBeTruthy();
    expect(getByText("Tap + to create one")).toBeTruthy();
  });

  it("renders list of notes with titles and dates", () => {
    const testDate = new Date("2025-06-15");
    mockNotes.push(
      { id: "note-1", title: "First Note", updatedAt: testDate },
      { id: "note-2", title: "Second Note", updatedAt: testDate },
    );

    const { getByText } = render(<NotesListScreen />);

    expect(getByText("First Note")).toBeTruthy();
    expect(getByText("Second Note")).toBeTruthy();
  });

  it("navigates to note editor when note is pressed", () => {
    mockNotes.push({
      id: "note-1",
      title: "First Note",
      updatedAt: new Date(),
    });

    const { getByText } = render(<NotesListScreen />);

    fireEvent.press(getByText("First Note"));

    expect(mockPush).toHaveBeenCalledWith("/notes/note-1");
  });

  it("shows create input when FAB is pressed", () => {
    const { getByText, getByPlaceholderText } = render(<NotesListScreen />);

    fireEvent.press(getByText("add"));

    expect(getByPlaceholderText("Note title (optional)")).toBeTruthy();
  });

  it("creates a note when submitted", async () => {
    mockDatabaseWrite.mockImplementation(async (fn: () => Promise<void>) => {
      await fn();
    });
    mockDatabaseGet.mockReturnValue({
      create: jest.fn(),
    });

    const { getByText, getByPlaceholderText } = render(<NotesListScreen />);

    fireEvent.press(getByText("add"));
    fireEvent.changeText(getByPlaceholderText("Note title (optional)"), "My New Note");
    fireEvent(getByPlaceholderText("Note title (optional)"), "submitEditing");

    await waitFor(() => {
      expect(mockDatabaseWrite).toHaveBeenCalled();
    });
  });

  describe("system navigation bar (PrimeTestLab 10668 M-01)", () => {
    // A 3-button Android nav bar: this stack screen has no tab bar under it,
    // and the app is edge-to-edge, so the bar overlaps the screen's bottom.
    beforeEach(() => {
      mockedInsets.mockReturnValue({ top: 24, bottom: 48, left: 0, right: 0 });
      mockNotes.push({ id: "note-1", title: "First Note", updatedAt: new Date() });
    });

    it("keeps the add button above the system navigation bar", () => {
      const { getByTestId } = render(<NotesListScreen />);

      expect(StyleSheet.flatten(getByTestId("add").props.style).bottom).toBe(spacing.xl + 48);
    });

    it("labels the add button for screen readers", () => {
      const { getByRole } = render(<NotesListScreen />);

      expect(getByRole("button", { name: "New note" })).toBeTruthy();
    });

    it("pads the list so the last note clears the add button and the nav bar", () => {
      const { UNSAFE_getByType } = render(<NotesListScreen />);

      const content = StyleSheet.flatten(UNSAFE_getByType(FlatList).props.contentContainerStyle);
      // FAB margin + system inset under the button, the button, then a FAB
      // margin of breathing room above it.
      expect(content.paddingBottom).toBe(FAB_SIZE + FAB_MARGIN * 2 + 48);
      expect(content.paddingTop ?? content.paddingVertical).toBe(spacing.sm);
    });

    it("keeps only the nav-bar clearance while the create bar hides the button", () => {
      const { getByTestId, queryByTestId, UNSAFE_getByType } = render(<NotesListScreen />);

      fireEvent.press(getByTestId("add"));

      expect(queryByTestId("add")).toBeNull();
      const content = StyleSheet.flatten(UNSAFE_getByType(FlatList).props.contentContainerStyle);
      expect(content.paddingBottom).toBe(LIST_RESTING_PADDING + 48);
    });
  });
});
