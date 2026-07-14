import React from "react";
import { Alert } from "react-native";
import { Q } from "@nozbe/watermelondb";

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

    const { getByTestId } = render(<NotebooksScreen />);
    fireEvent.press(getByTestId("action-trash"));

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

    const { getByTestId } = render(<NotebooksScreen />);
    fireEvent.press(getByTestId("action-trash"));

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

    const { getByTestId } = render(<NotebooksScreen />);
    fireEvent.press(getByTestId("action-trash"));
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
});
