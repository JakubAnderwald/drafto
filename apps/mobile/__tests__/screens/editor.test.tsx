import React from "react";
import * as ReactNative from "react-native";

import { serializeEditorContent, type TipTapDoc } from "@drafto/shared";

import { render, fireEvent, act } from "../helpers/test-utils";
import EditorScreen from "../../app/notes/[id]";
import { semanticDark } from "@/theme/tokens";

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

const mockSetContent = jest.fn();
const mockInjectCSS = jest.fn();
const mockUseEditorBridge = jest.fn();
const mockGetJSON = jest.fn().mockResolvedValue({ type: "doc", content: [] });
let mockEditorFocused = false;
// Subscribers to the bridge's editor-state updates (focus changes, etc.).
const mockStateSubscribers: ((state: { isFocused: boolean }) => void)[] = [];

jest.mock("@10play/tentap-editor", () => ({
  useEditorBridge: (options: unknown) => {
    mockUseEditorBridge(options);
    return {
      getJSON: mockGetJSON,
      setContent: mockSetContent,
      injectCSS: mockInjectCSS,
      getEditorState: () => ({ isReady: true, isFocused: mockEditorFocused }),
      _subscribeToEditorStateUpdate: (listener: (state: { isFocused: boolean }) => void) => {
        mockStateSubscribers.push(listener);
        return () => {
          mockStateSubscribers.splice(mockStateSubscribers.indexOf(listener), 1);
        };
      },
    };
  },
  useBridgeState: () => ({ isReady: true }),
  TenTapStartKit: [],
  CoreBridge: { configureCSS: (css: string) => ({ name: "core", extendCSS: css }) },
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

jest.mock("@/lib/data/attachments", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://signed.test/url"),
}));

type SaveHandler = (value: unknown) => Promise<boolean | void>;
const mockAutoSaveHandlers: SaveHandler[] = [];

jest.mock("@/hooks/use-auto-save", () => ({
  useAutoSave: ({ onSave }: { onSave: SaveHandler }) => {
    mockAutoSaveHandlers.push(onSave);
    return {
      trigger: jest.fn(),
      cancel: jest.fn(),
      flush: jest.fn(),
      status: "idle" as const,
    };
  },
}));

/** The latest render's handlers: the title save is created first, then content. */
function latestSaveHandlers(): { saveTitle: SaveHandler; saveContent: SaveHandler } {
  const count = mockAutoSaveHandlers.length;
  return {
    saveTitle: mockAutoSaveHandlers[count - 2],
    saveContent: mockAutoSaveHandlers[count - 1],
  };
}

describe("EditorScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNote = null;
    mockNoteLoading = true;
    mockNoteError = null;
    mockEditorFocused = false;
    mockStateSubscribers.length = 0;
    mockAutoSaveHandlers.length = 0;
    mockGetJSON.mockResolvedValue({ type: "doc", content: [] });
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

  it("styles the note body with the system sans font, like desktop", () => {
    mockNoteLoading = false;
    mockNote = {
      id: "note-1",
      title: "Test Note",
      content: null,
      updatedAt: new Date(),
    };

    render(<EditorScreen />);

    const [{ bridgeExtensions }] = mockUseEditorBridge.mock.calls[0] as [
      { bridgeExtensions: { name: string; extendCSS?: string }[] },
    ];
    const core = bridgeExtensions.find((ext) => ext.name === "core");
    expect(core?.extendCSS).toMatch(/\.ProseMirror \{ font-family: -apple-system/);
  });

  it("ships the dark-mode text colour with the editor's initial load", () => {
    const colorSchemeSpy = jest.spyOn(ReactNative, "useColorScheme").mockReturnValue("dark");
    mockNoteLoading = false;
    mockNote = {
      id: "note-1",
      title: "Test Note",
      content: null,
      updatedAt: new Date(),
    };

    render(<EditorScreen />);

    const [{ bridgeExtensions }] = mockUseEditorBridge.mock.calls[0] as [
      { bridgeExtensions: { name: string; extendCSS?: string }[] },
    ];
    const core = bridgeExtensions.find((ext) => ext.name === "core");
    expect(core?.extendCSS).toContain(`color: ${semanticDark.fg}`);
    expect(core?.extendCSS).toContain(`background-color: ${semanticDark.bg}`);
    expect(mockInjectCSS).toHaveBeenCalledWith(
      expect.stringContaining(`color: ${semanticDark.fg}`),
      "dark-mode",
    );
    colorSchemeSpy.mockRestore();
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

  describe("no-op saves (issue #654)", () => {
    type StoredNote = {
      id: string;
      title: string;
      content: string | null;
      updatedAt: Date;
      update: jest.Mock;
    };

    const LOADED_DOC: TipTapDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    };
    const EDITED_DOC: TipTapDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
    };
    // Stored content authored elsewhere with two adjacent unmarked text runs.
    // ProseMirror merges them on load, so the editor reads back LOADED_DOC,
    // which the converter's own serialisation of the stored doc does not match.
    const SPLIT_DOC: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hel" },
            { type: "text", text: "lo" },
          ],
        },
      ],
    };

    function storeNote(title: string, content: string | null): StoredNote {
      const record: StoredNote = {
        id: "note-1",
        title,
        content,
        updatedAt: new Date(),
        update: jest.fn(async (apply: (r: StoredNote) => void) => apply(record)),
      };
      mockNoteLoading = false;
      mockNote = record;
      mockDatabaseGet.mockReturnValue({ find: jest.fn().mockResolvedValue(record) });
      mockDatabaseWrite.mockImplementation((work: () => Promise<unknown>) => work());
      return record;
    }

    /** Mounts the editor and lets its post-ready read-back settle. */
    async function renderEditor(readBack: TipTapDoc): Promise<void> {
      mockGetJSON.mockResolvedValue(readBack);
      render(<EditorScreen />);
      await act(async () => {
        await Promise.resolve();
      });
    }

    it("does not write or sync a new note's load echo, so it never shows Saved", async () => {
      const record = storeNote("", null);
      // ProseMirror fills an empty doc with one empty paragraph.
      await renderEditor({ type: "doc", content: [{ type: "paragraph" }] });

      const { saveContent } = latestSaveHandlers();
      await act(async () => {
        await expect(saveContent(undefined)).resolves.toBe(false);
      });

      expect(record.update).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
    });

    it("does not write an unchanged doc after the editor is ready", async () => {
      const record = storeNote("Note", serializeEditorContent(LOADED_DOC));
      await renderEditor(LOADED_DOC);

      const { saveContent } = latestSaveHandlers();
      await act(async () => {
        await expect(saveContent(undefined)).resolves.toBe(false);
      });

      expect(record.update).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
    });

    it("adds the editor's read-back to the baseline, covering what the editor normalises", async () => {
      const record = storeNote("Note", serializeEditorContent(SPLIT_DOC));
      expect(serializeEditorContent(LOADED_DOC)).not.toBe(record.content); // precondition
      await renderEditor(LOADED_DOC);

      const { saveContent } = latestSaveHandlers();
      await act(async () => {
        await expect(saveContent(undefined)).resolves.toBe(false);
      });
      expect(record.update).not.toHaveBeenCalled();
    });

    it("skips the read-back once the user has focused the editor", async () => {
      const record = storeNote("Note", serializeEditorContent(SPLIT_DOC));
      mockEditorFocused = true;
      await renderEditor(LOADED_DOC);

      const { saveContent } = latestSaveHandlers();
      await act(async () => {
        await expect(saveContent(undefined)).resolves.toBe(true);
      });
      expect(record.content).toBe(serializeEditorContent(LOADED_DOC));
    });

    it("skips the read-back if the editor was focused before the reply, even if blurred again", async () => {
      // The user taps in (the reply could hold their typing) and away again
      // before the read-back's reply arrives.
      const record = storeNote("Note", serializeEditorContent(SPLIT_DOC));
      let reply!: (doc: TipTapDoc) => void;
      mockGetJSON.mockReturnValueOnce(new Promise<TipTapDoc>((resolve) => (reply = resolve)));
      render(<EditorScreen />);

      await act(async () => {
        for (const listener of [...mockStateSubscribers]) listener({ isFocused: true });
        for (const listener of [...mockStateSubscribers]) listener({ isFocused: false });
        reply(LOADED_DOC);
      });

      mockGetJSON.mockResolvedValue(LOADED_DOC);
      const { saveContent } = latestSaveHandlers();
      await act(async () => {
        await expect(saveContent(undefined)).resolves.toBe(true);
      });
      expect(record.content).toBe(serializeEditorContent(LOADED_DOC));
      expect(mockStateSubscribers).toHaveLength(0); // unsubscribed once answered
    });

    it("skips a read-back whose text differs from the loaded note, so a typed edit is saved", async () => {
      const record = storeNote("Note", serializeEditorContent(SPLIT_DOC));
      await renderEditor(EDITED_DOC);

      const { saveContent } = latestSaveHandlers();
      mockGetJSON.mockResolvedValue(EDITED_DOC);
      await act(async () => {
        await expect(saveContent(undefined)).resolves.toBe(true);
      });
      expect(record.content).toBe(serializeEditorContent(EDITED_DOC));
    });

    it("writes and syncs a real edit", async () => {
      const record = storeNote("Note", serializeEditorContent(LOADED_DOC));
      await renderEditor(LOADED_DOC);
      mockGetJSON.mockResolvedValue(EDITED_DOC);

      const { saveContent } = latestSaveHandlers();
      await act(async () => {
        await expect(saveContent(undefined)).resolves.toBe(true);
      });

      expect(record.update).toHaveBeenCalledTimes(1);
      expect(record.content).toBe(serializeEditorContent(EDITED_DOC));
      expect(mockSync).toHaveBeenCalledTimes(1);
    });

    it("skips an unchanged title and writes and syncs a changed one", async () => {
      const record = storeNote("Groceries", null);
      await renderEditor({ type: "doc", content: [{ type: "paragraph" }] });

      const { saveTitle } = latestSaveHandlers();
      await act(async () => {
        await expect(saveTitle("  Groceries ")).resolves.toBe(false);
      });
      expect(record.update).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();

      await act(async () => {
        await expect(saveTitle("Shopping")).resolves.toBe(true);
      });
      expect(record.title).toBe("Shopping");
      expect(mockSync).toHaveBeenCalledTimes(1);
    });

    it("never writes a blank title", async () => {
      const record = storeNote("Groceries", null);
      await renderEditor({ type: "doc", content: [{ type: "paragraph" }] });

      const { saveTitle } = latestSaveHandlers();
      await act(async () => {
        await expect(saveTitle("   ")).resolves.toBe(false);
      });
      expect(record.update).not.toHaveBeenCalled();
    });
  });
});
