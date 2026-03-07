import React from "react";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import NotesListScreen from "../../app/notebooks/[id]";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: "nb-1" }),
  Link: ({ children, ...props }: { children: React.ReactNode }) => {
    const { Text } = require("react-native");
    return <Text {...props}>{children}</Text>;
  },
}));

const mockSync = jest.fn().mockResolvedValue(undefined);
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
    isSyncing: false,
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
});
