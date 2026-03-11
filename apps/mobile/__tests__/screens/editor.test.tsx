import React from "react";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import EditorScreen from "../../app/notes/[id]";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "note-1" }),
  Stack: { Screen: () => null },
  Link: ({ children, ...props }: { children: React.ReactNode }) => {
    const { Text } = require("react-native");
    return <Text {...props}>{children}</Text>;
  },
}));

const mockSync = jest.fn().mockResolvedValue(undefined);
const mockDatabaseWrite = jest.fn();
const mockDatabaseGet = jest.fn();

jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => ({
    database: {
      write: mockDatabaseWrite,
      get: mockDatabaseGet,
    },
    sync: mockSync,
    isSyncing: false,
  }),
}));

let mockNote: {
  id: string;
  title: string;
  content: string | null;
  updatedAt: Date;
} | null = null;
let mockNoteLoading = true;
let mockNoteError: string | null = null;

jest.mock("@/hooks/use-note", () => ({
  useNote: () => ({
    note: mockNote,
    loading: mockNoteLoading,
    error: mockNoteError,
  }),
}));

jest.mock("@/hooks/use-attachments", () => ({
  useAttachments: () => ({
    attachments: [],
    loading: false,
  }),
}));

const mockSetContent = jest.fn();
const mockGetJSON = jest.fn().mockResolvedValue({ type: "doc", content: [] });

jest.mock("@10play/tentap-editor", () => ({
  useEditorBridge: () => ({
    getJSON: mockGetJSON,
    setContent: mockSetContent,
    injectCSS: jest.fn(),
  }),
  useBridgeState: () => ({ isReady: true }),
  TenTapStartKit: [],
  RichText: () => null,
  Toolbar: () => null,
  DEFAULT_TOOLBAR_ITEMS: [],
  darkEditorTheme: { toolbar: {}, webview: {}, webviewContainer: {} },
}));

jest.mock("@/components/editor/note-editor", () => ({
  NoteEditor: () => null,
}));

jest.mock("@/components/editor/attachment-picker", () => ({
  AttachmentPicker: () => null,
}));

jest.mock("@/components/editor/attachment-list", () => ({
  AttachmentList: () => null,
}));

jest.mock("@/hooks/use-auto-save", () => ({
  useAutoSave: () => ({
    trigger: jest.fn(),
    cancel: jest.fn(),
    status: "idle" as const,
  }),
}));

describe("EditorScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNote = null;
    mockNoteLoading = true;
    mockNoteError = null;
  });

  it("shows error state when note is not found", () => {
    mockNoteLoading = false;
    mockNoteError = "Note not found";

    const { getByText } = render(<EditorScreen />);

    expect(getByText("Note not found")).toBeTruthy();
    expect(getByText("Retry")).toBeTruthy();
  });

  it("renders title input when note is loaded", () => {
    mockNoteLoading = false;
    mockNote = {
      id: "note-1",
      title: "Test Note",
      content: null,
      updatedAt: new Date(),
    };

    const { getByDisplayValue } = render(<EditorScreen />);

    expect(getByDisplayValue("Test Note")).toBeTruthy();
  });

  it("allows editing the title", () => {
    mockNoteLoading = false;
    mockNote = {
      id: "note-1",
      title: "Test Note",
      content: null,
      updatedAt: new Date(),
    };

    const { getByDisplayValue } = render(<EditorScreen />);

    fireEvent.changeText(getByDisplayValue("Test Note"), "Updated Title");

    expect(getByDisplayValue("Updated Title")).toBeTruthy();
  });

  it("calls sync when retry is pressed on error", () => {
    mockNoteLoading = false;
    mockNoteError = "Network error";

    const { getByText } = render(<EditorScreen />);

    fireEvent.press(getByText("Retry"));

    expect(mockSync).toHaveBeenCalled();
  });

  it("shows placeholder when title is empty", () => {
    mockNoteLoading = false;
    mockNote = {
      id: "note-1",
      title: "",
      content: null,
      updatedAt: new Date(),
    };

    const { getByPlaceholderText } = render(<EditorScreen />);

    expect(getByPlaceholderText("Untitled")).toBeTruthy();
  });
});
