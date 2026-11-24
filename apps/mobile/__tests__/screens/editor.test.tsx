import React from "react";
import * as ReactNative from "react-native";

import {
  IMAGE_RENDER_STATUS_MESSAGE_TYPE,
  serializeEditorContent,
  toAttachmentUrl,
  toLocalAttachmentSrc,
  type TipTapDoc,
} from "@drafto/shared";

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

let mockEditorOnMessage: ((event: { nativeEvent: { data: string } }) => void) | undefined;
jest.mock("@/components/editor/note-editor", () => ({
  NoteEditor: (props: {
    onMessage?: (event: { nativeEvent: { data: string } }) => void;
    accessory?: React.ReactNode;
  }) => {
    mockEditorOnMessage = props.onMessage;
    return props.accessory ?? null;
  },
}));

let mockOnAttachmentReady: ((attachment: unknown) => Promise<void>) | undefined;
jest.mock("@/components/editor/attachment-picker", () => ({
  AttachmentPicker: (props: { onAttachmentReady: (attachment: unknown) => Promise<void> }) => {
    mockOnAttachmentReady = props.onAttachmentReady;
    return null;
  },
}));

const mockGetSignedUrl = jest.fn().mockResolvedValue("https://signed.test/url");
jest.mock("@/lib/data/attachments", () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

let mockProbesEnabled = true;
jest.mock("@/lib/e2e-probes", () => ({
  areE2EProbesEnabled: () => mockProbesEnabled,
}));

const mockResolveAttachmentSrc = jest.fn();
const mockLocalAttachmentSrcFor = jest.fn();
jest.mock("@/lib/data/attachment-resolver", () => ({
  resolveAttachmentSrc: (...args: unknown[]) => mockResolveAttachmentSrc(...args),
  localAttachmentSrcFor: (...args: unknown[]) => mockLocalAttachmentSrcFor(...args),
}));

let mockAttachmentSizes: { filePath: string; fileSize: number; mimeType: string }[] = [];
jest.mock("@/hooks/use-note-attachment-sizes", () => ({
  useNoteAttachmentSizes: () => mockAttachmentSizes,
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
    mockAttachmentSizes = [];
    mockGetJSON.mockResolvedValue({ type: "doc", content: [] });
  });

  it("PrimeTestLab 11035 S-04 injects the note's file sizes as a stylesheet", () => {
    mockAttachmentSizes = [
      {
        filePath: "user-1/note-1/report-1700000000000-0a1b2c3d.pdf",
        fileSize: 1.2 * 1024 * 1024,
        mimeType: "application/pdf",
      },
    ];
    mockNoteLoading = false;
    mockNote = { id: "note-1", title: "Test Note", content: null, updatedAt: new Date() };

    render(<EditorScreen />);

    expect(mockInjectCSS).toHaveBeenCalledWith(
      expect.stringContaining('[href*="-1700000000000-0a1b2c3d"]::after { content: "1.2 MB"; }'),
      "attachment-sizes",
    );
  });

  it.each([
    ["no content", null],
    ["an empty BlockNote array", "[]"],
    ["an empty TipTap doc", JSON.stringify({ type: "doc", content: [] })],
  ])(
    "PrimeTestLab 11035 E2E hands a note with %s to the editor as one empty paragraph",
    (_case, content) => {
      // A doc with no blocks left the editor's selection at 0, where no
      // command applies: every toolbar button was disabled and iOS could not
      // focus the body of a new note.
      mockNoteLoading = false;
      mockNote = { id: "note-1", title: "Test Note", content, updatedAt: new Date() };

      render(<EditorScreen />);

      const calls = mockUseEditorBridge.mock.calls;
      const options = calls[calls.length - 1][0] as { initialContent: TipTapDoc };
      expect(options.initialContent).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    },
  );

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

describe("EditorScreen offline attachment images (ADR-0086)", () => {
  const FILE_PATH = "user-1/note-1/photo.jpg";
  const LOCAL_SRC = toLocalAttachmentSrc(
    "file:///docs/attachment-cache/user-1/note-1/photo.jpg",
    FILE_PATH,
  );
  const imageDoc = (src: string): TipTapDoc => ({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Trip" }] },
      { type: "image", attrs: { src, alt: "photo.jpg" } },
    ],
  });

  interface StoredNote {
    id: string;
    title: string;
    content: string | null;
    updatedAt: Date;
    update: jest.Mock;
  }

  function storeNote(content: string | null): StoredNote {
    const record: StoredNote = {
      id: "note-1",
      title: "Trip",
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

  async function settle(): Promise<void> {
    // The resolver is a dynamic import, which takes a macrotask to settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function lastBridgeOptions(): { initialContent: TipTapDoc; webviewBaseURL?: string } {
    const calls = mockUseEditorBridge.mock.calls;
    return calls[calls.length - 1][0] as { initialContent: TipTapDoc; webviewBaseURL?: string };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockAutoSaveHandlers.length = 0;
    mockStateSubscribers.length = 0;
    mockEditorFocused = false;
    mockEditorOnMessage = undefined;
    mockOnAttachmentReady = undefined;
    mockResolveAttachmentSrc.mockResolvedValue(LOCAL_SRC);
    mockLocalAttachmentSrcFor.mockReturnValue(LOCAL_SRC);
    mockProbesEnabled = true;
    mockAttachmentSizes = [];
  });

  it("gives the editor a file:// base URL so cached images can load", () => {
    storeNote(null);
    render(<EditorScreen />);
    expect(lastBridgeOptions().webviewBaseURL).toMatch(/^file:.*\/$/);
  });

  it("opens a note with a cached image from the cache, with no signed URL", async () => {
    storeNote(serializeEditorContent(imageDoc(toAttachmentUrl(FILE_PATH))));
    render(<EditorScreen />);
    await settle();

    expect(mockResolveAttachmentSrc).toHaveBeenCalledWith(FILE_PATH, "image");
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(lastBridgeOptions().initialContent.content[1].attrs?.src).toBe(LOCAL_SRC);
  });

  it("keeps attachment:// for an image it can't resolve offline, and still opens the note", async () => {
    mockResolveAttachmentSrc.mockRejectedValue(new Error("offline"));
    storeNote(serializeEditorContent(imageDoc(toAttachmentUrl(FILE_PATH))));
    const { getByDisplayValue } = render(<EditorScreen />);
    await settle();

    expect(getByDisplayValue("Trip")).toBeTruthy();
    expect(lastBridgeOptions().initialContent.content[1].attrs?.src).toBe(
      toAttachmentUrl(FILE_PATH),
    );
  });

  it("keeps a cached image's local src when a link in the same note never resolves", async () => {
    const LINK_PATH = "user-1/note-1/report.pdf";
    mockResolveAttachmentSrc.mockImplementation((_filePath: string, kind: string) =>
      kind === "link" ? new Promise<string>(() => undefined) : Promise.resolve(LOCAL_SRC),
    );
    storeNote(
      serializeEditorContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "report",
                marks: [{ type: "link", attrs: { href: toAttachmentUrl(LINK_PATH) } }],
              },
            ],
          },
          { type: "image", attrs: { src: toAttachmentUrl(FILE_PATH), alt: "photo.jpg" } },
        ],
      }),
    );
    jest.useFakeTimers();
    try {
      render(<EditorScreen />);
      // Each reference has its own 8 s bound: the hung link alone stays unresolved.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(8000);
      });
      const shown = lastBridgeOptions().initialContent;
      expect(shown.content[1].attrs?.src).toBe(LOCAL_SRC);
      expect(JSON.stringify(shown.content[0])).toContain(toAttachmentUrl(LINK_PATH));
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not save a note opened with cached images and not edited (#654)", async () => {
    const record = storeNote(serializeEditorContent(imageDoc(toAttachmentUrl(FILE_PATH))));
    mockGetJSON.mockResolvedValue(imageDoc(LOCAL_SRC));
    render(<EditorScreen />);
    await settle();

    const { saveContent } = latestSaveHandlers();
    await act(async () => {
      await expect(saveContent(undefined)).resolves.toBe(false);
    });
    expect(record.update).not.toHaveBeenCalled();
  });

  it("inserts an attached image with its local src and stores attachment://", async () => {
    const record = storeNote(null);
    mockGetJSON.mockResolvedValue({ type: "doc", content: [{ type: "paragraph" }] });
    render(<EditorScreen />);
    await settle();

    const attachment = {
      filePath: FILE_PATH,
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      localUri: "file:///docs/attachment-cache/user-1/note-1/photo.jpg",
    };
    expect(mockOnAttachmentReady).toBeDefined();
    await act(async () => {
      await mockOnAttachmentReady?.(attachment);
    });

    expect(mockLocalAttachmentSrcFor).toHaveBeenCalledWith(attachment);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    const shown = mockSetContent.mock.calls[mockSetContent.mock.calls.length - 1][0] as TipTapDoc;
    expect(shown.content[shown.content.length - 1].attrs?.src).toBe(LOCAL_SRC);
    expect(record.content).toContain(toAttachmentUrl(FILE_PATH));
    expect(record.content).not.toContain("file://");
    expect(record.content).not.toContain("#drafto-attachment=");
  });

  it("PrimeTestLab 11035 S-04 resolves a note with only a file link, so it opens and shows as a card", async () => {
    const LINK_PATH = "user-1/note-1/report.pdf";
    const SIGNED =
      "https://x.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/report.pdf?token=t";
    mockResolveAttachmentSrc.mockResolvedValue(SIGNED);
    storeNote(
      JSON.stringify([
        {
          type: "file",
          props: { url: toAttachmentUrl(LINK_PATH), name: "report.pdf" },
          children: [],
        },
      ]),
    );
    render(<EditorScreen />);
    await settle();

    expect(mockResolveAttachmentSrc).toHaveBeenCalledWith(LINK_PATH, "link");
    expect(JSON.stringify(lastBridgeOptions().initialContent)).toContain(SIGNED);
  });

  it("PrimeTestLab 11035 CodeRabbit: resolves a note whose only attachment is an inline text link", async () => {
    const LINK_PATH = "user-1/note-1/report.pdf";
    const SIGNED =
      "https://x.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/report.pdf?token=t";
    mockResolveAttachmentSrc.mockResolvedValue(SIGNED);
    storeNote(
      JSON.stringify([
        {
          type: "paragraph",
          content: [
            {
              type: "link",
              href: toAttachmentUrl(LINK_PATH),
              content: [{ type: "text", text: "the report", styles: {} }],
            },
          ],
          children: [],
        },
      ]),
    );
    render(<EditorScreen />);
    await settle();

    expect(mockResolveAttachmentSrc).toHaveBeenCalledWith(LINK_PATH, "link");
    const initial = JSON.stringify(lastBridgeOptions().initialContent);
    expect(initial).toContain(SIGNED);
    expect(initial).not.toContain(toAttachmentUrl(LINK_PATH));
  });

  it("PrimeTestLab 11035 S-04 inserts an uploaded file with its signed URL and stores a file block", async () => {
    const LINK_PATH = "user-1/note-1/report.pdf";
    const SIGNED =
      "https://x.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/report.pdf?token=t";
    mockResolveAttachmentSrc.mockResolvedValue(SIGNED);
    const record = storeNote(null);
    mockGetJSON.mockResolvedValue({ type: "doc", content: [{ type: "paragraph" }] });
    render(<EditorScreen />);
    await settle();

    await act(async () => {
      await mockOnAttachmentReady?.({
        filePath: LINK_PATH,
        fileName: "report.pdf",
        mimeType: "application/pdf",
        uploadStatus: "uploaded",
        localUri: null,
      });
    });

    expect(mockResolveAttachmentSrc).toHaveBeenCalledWith(LINK_PATH, "link");
    const shown = mockSetContent.mock.calls[mockSetContent.mock.calls.length - 1][0] as TipTapDoc;
    expect(JSON.stringify(shown.content[shown.content.length - 1])).toContain(SIGNED);
    const stored = JSON.parse(record.content ?? "[]") as { type: string; props?: unknown }[];
    expect(stored[stored.length - 1]).toEqual({
      type: "file",
      props: { url: toAttachmentUrl(LINK_PATH), name: "report.pdf" },
      children: [],
    });
  });

  it("PrimeTestLab 11035 CodeRabbit: a later edit stores the inserted file's signed link as attachment://", async () => {
    const LINK_PATH = "user-1/note-1/report.pdf";
    const SIGNED =
      "https://x.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/report.pdf?token=t";
    mockResolveAttachmentSrc.mockResolvedValue(SIGNED);
    const record = storeNote(null);
    mockGetJSON.mockResolvedValue({ type: "doc", content: [{ type: "paragraph" }] });
    render(<EditorScreen />);
    await settle();

    await act(async () => {
      await mockOnAttachmentReady?.({
        filePath: LINK_PATH,
        fileName: "report.pdf",
        mimeType: "application/pdf",
        uploadStatus: "uploaded",
        localUri: null,
      });
    });

    // The editor now holds the signed href; the user types, and the autosave reads it back,
    // with the same link also used inline under other text.
    const shown = mockSetContent.mock.calls[mockSetContent.mock.calls.length - 1][0] as TipTapDoc;
    mockGetJSON.mockResolvedValue({
      type: "doc",
      content: [
        ...shown.content,
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See " },
            {
              type: "text",
              text: "the report",
              marks: [{ type: "link", attrs: { href: SIGNED } }],
            },
          ],
        },
      ],
    });
    const { saveContent } = latestSaveHandlers();
    await act(async () => {
      await expect(saveContent(undefined)).resolves.toBe(true);
    });

    expect(record.content).not.toContain(SIGNED);
    expect(record.content).not.toContain("token=");
    expect(record.content?.split(toAttachmentUrl(LINK_PATH)).length).toBe(3);
  });

  it("PrimeTestLab 11035 review: inserts a file after 1.5 s, not 8 s, when its signed URL stalls", async () => {
    const LINK_PATH = "user-1/note-1/report.pdf";
    const record = storeNote(null);
    mockGetJSON.mockResolvedValue({ type: "doc", content: [{ type: "paragraph" }] });
    render(<EditorScreen />);
    await settle();
    mockResolveAttachmentSrc.mockImplementation(() => new Promise<string>(() => {}));
    mockSetContent.mockClear();

    jest.useFakeTimers();
    try {
      let inserted: Promise<void> | undefined;
      act(() => {
        inserted = mockOnAttachmentReady?.({
          filePath: LINK_PATH,
          fileName: "report.pdf",
          mimeType: "application/pdf",
          uploadStatus: "uploaded",
          localUri: null,
        });
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1000);
      });
      expect(mockSetContent).not.toHaveBeenCalled();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(500);
        await inserted;
      });
      const shown = mockSetContent.mock.calls[mockSetContent.mock.calls.length - 1][0] as TipTapDoc;
      expect(JSON.stringify(shown.content[shown.content.length - 1])).toContain(
        toAttachmentUrl(LINK_PATH),
      );
      const stored = JSON.parse(record.content ?? "[]") as { type: string; props?: unknown }[];
      expect(stored[stored.length - 1]).toEqual({
        type: "file",
        props: { url: toAttachmentUrl(LINK_PATH), name: "report.pdf" },
        children: [],
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("PrimeTestLab 11035 S-04 inserts a file still waiting to upload with attachment://", async () => {
    const LINK_PATH = "user-1/note-1/report.pdf";
    storeNote(null);
    mockGetJSON.mockResolvedValue({ type: "doc", content: [{ type: "paragraph" }] });
    render(<EditorScreen />);
    await settle();
    mockResolveAttachmentSrc.mockClear();

    await act(async () => {
      await mockOnAttachmentReady?.({
        filePath: LINK_PATH,
        fileName: "report.pdf",
        mimeType: "application/pdf",
        uploadStatus: "pending",
        localUri: null,
      });
    });

    expect(mockResolveAttachmentSrc).not.toHaveBeenCalled();
    const shown = mockSetContent.mock.calls[mockSetContent.mock.calls.length - 1][0] as TipTapDoc;
    expect(JSON.stringify(shown.content[shown.content.length - 1])).toContain(
      toAttachmentUrl(LINK_PATH),
    );
  });

  it("mirrors the WebView's image report in accessible status views", async () => {
    storeNote(null);
    const { queryByTestId, getByLabelText } = render(<EditorScreen />);
    await settle();
    expect(queryByTestId("editor-image-status")).toBeNull();

    act(() => {
      mockEditorOnMessage?.({ nativeEvent: { data: "not a report" } });
      mockEditorOnMessage?.({
        nativeEvent: {
          data: JSON.stringify({
            type: IMAGE_RENDER_STATUS_MESSAGE_TYPE,
            images: [
              { name: "photo.jpg", rendered: true, height: 240, local: true },
              { name: "gone.png", rendered: false, height: 16, local: false },
            ],
          }),
        },
      });
    });

    expect(getByLabelText("Image shown: photo.jpg")).toBeTruthy();
    expect(getByLabelText("Image not loaded: gone.png")).toBeTruthy();
  });

  it("has no image status views in a build without the E2E probes", async () => {
    mockProbesEnabled = false;
    storeNote(null);
    const { queryByTestId } = render(<EditorScreen />);
    await settle();
    act(() => {
      mockEditorOnMessage?.({
        nativeEvent: {
          data: JSON.stringify({
            type: IMAGE_RENDER_STATUS_MESSAGE_TYPE,
            images: [{ name: "photo.jpg", rendered: true, height: 240, local: true }],
          }),
        },
      });
    });
    expect(queryByTestId("editor-image-status")).toBeNull();
  });
});
