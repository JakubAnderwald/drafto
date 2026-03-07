import React from "react";
import { Alert } from "react-native";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import NotebooksScreen from "../../app/(tabs)/index";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
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

describe("NotebooksScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotebooks.length = 0;
    mockLoading = false;
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
});
