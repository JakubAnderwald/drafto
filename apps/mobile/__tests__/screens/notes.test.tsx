import React from "react";
import { FlatList, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import NotesListScreen from "../../app/notebooks/[id]";
import { FAB_SIZE } from "@/components/ui/fab";
import { spacing } from "@/theme/tokens";

const mockedInsets = jest.mocked(useSafeAreaInsets);

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
      expect(content.paddingBottom).toBeGreaterThanOrEqual(spacing.xl + FAB_SIZE + 48);
      expect(content.paddingTop ?? content.paddingVertical).toBe(spacing.sm);
    });
  });
});
