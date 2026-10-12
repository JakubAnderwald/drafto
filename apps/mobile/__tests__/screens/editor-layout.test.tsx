import React from "react";
import * as ReactNative from "react-native";
import { KeyboardAvoidingView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { render } from "../helpers/test-utils";
import EditorScreen from "../../app/notes/[id]";
import { AttachmentPicker } from "@/components/editor/attachment-picker";
import { semanticDark, semanticLight } from "@/theme/tokens";

// Layout of the editor screen: the header, the keyboard handling and the
// toolbar theme (App Review recording, 2:04–2:15). Kept apart from
// editor.test.tsx, which covers saving.

const mockStackScreen = jest.fn();
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "note-1" }),
  Stack: {
    Screen: (props: unknown) => {
      mockStackScreen(props);
      return null;
    },
  },
}));

const MOCK_HEADER_HEIGHT = 96;
jest.mock("@react-navigation/elements", () => ({
  useHeaderHeight: () => MOCK_HEADER_HEIGHT,
}));

let mockKeyboardVisible = false;
jest.mock("@/hooks/use-keyboard-visible", () => ({
  useKeyboardVisible: () => mockKeyboardVisible,
}));

jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => ({
    database: { write: jest.fn(), get: jest.fn() },
    sync: jest.fn().mockResolvedValue(undefined),
    isSyncing: false,
  }),
}));

let mockNote: { id: string; title: string; content: string | null; updatedAt: Date } | null = null;
let mockNoteLoading = true;

jest.mock("@/hooks/use-note", () => ({
  useNote: () => ({ note: mockNote, loading: mockNoteLoading, error: null }),
}));

const mockUseEditorBridge = jest.fn();
jest.mock("@10play/tentap-editor", () => ({
  useEditorBridge: (options: unknown) => {
    mockUseEditorBridge(options);
    return {
      getJSON: jest.fn().mockResolvedValue({ type: "doc", content: [] }),
      setContent: jest.fn(),
      injectCSS: jest.fn(),
    };
  },
  useBridgeState: () => ({ isReady: true }),
  TenTapStartKit: [],
  CoreBridge: { configureCSS: (css: string) => ({ name: "core", extendCSS: css }) },
  darkEditorTheme: { toolbar: { icon: { tintColor: "white" } }, webview: {}, webviewContainer: {} },
}));

const mockNoteEditor = jest.fn();
jest.mock("@/components/editor/note-editor", () => ({
  NoteEditor: (props: unknown) => {
    mockNoteEditor(props);
    return null;
  },
}));

jest.mock("@/components/editor/attachment-picker", () => ({
  AttachmentPicker: () => null,
}));

jest.mock("@/hooks/use-auto-save", () => ({
  useAutoSave: () => ({ trigger: jest.fn(), cancel: jest.fn(), flush: jest.fn(), status: "idle" }),
}));

const mockedInsets = jest.mocked(useSafeAreaInsets);

type BridgeOptions = {
  avoidIosKeyboard: boolean;
  theme: {
    toolbar: {
      toolbarBody: Record<string, unknown>;
      toolbarButton: Record<string, unknown>;
      iconWrapper: Record<string, unknown>;
      icon?: Record<string, unknown>;
    };
    webview: Record<string, unknown>;
  };
};

function lastBridgeOptions(): BridgeOptions {
  const calls = mockUseEditorBridge.mock.calls;
  return calls[calls.length - 1][0] as BridgeOptions;
}

function loadNote() {
  mockNoteLoading = false;
  mockNote = { id: "note-1", title: "Shopping", content: null, updatedAt: new Date() };
}

describe("EditorScreen layout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNote = null;
    mockNoteLoading = true;
    mockKeyboardVisible = false;
    mockedInsets.mockReturnValue({ top: 47, bottom: 34, left: 0, right: 0 });
  });

  it("never sets a header title while the note loads or after, so 'Editor' can't flash", () => {
    const { rerender } = render(<EditorScreen />);
    loadNote();
    rerender(<EditorScreen />);

    const titles = mockStackScreen.mock.calls
      .map(([props]) => (props as { options?: { title?: unknown } }).options?.title)
      .filter((title) => title !== undefined);
    expect(titles).toEqual([]);
  });

  it("turns TenTap's own keyboard avoidance off, so the body isn't padded twice", () => {
    loadNote();
    render(<EditorScreen />);

    expect(lastBridgeOptions().avoidIosKeyboard).toBe(false);
  });

  it("pins the toolbar to one 44pt row in the screen's colours (light)", () => {
    loadNote();
    render(<EditorScreen />);

    const { theme } = lastBridgeOptions();
    expect(theme.toolbar.toolbarBody).toEqual(
      expect.objectContaining({
        flex: 0,
        flexGrow: 0,
        height: 44,
        backgroundColor: semanticLight.bg,
        borderTopColor: semanticLight.border,
        borderBottomColor: semanticLight.border,
      }),
    );
    expect(theme.toolbar.toolbarButton).toEqual({ backgroundColor: semanticLight.bg });
    expect(theme.toolbar.iconWrapper).toEqual({ backgroundColor: semanticLight.bg });
    expect(theme.webview).toEqual({ backgroundColor: semanticLight.bg });
  });

  it("uses the dark surface for the toolbar and keeps TenTap's dark icons", () => {
    const colorSchemeSpy = jest.spyOn(ReactNative, "useColorScheme").mockReturnValue("dark");
    loadNote();
    render(<EditorScreen />);

    const { theme } = lastBridgeOptions();
    expect(theme.toolbar.toolbarBody).toEqual(
      expect.objectContaining({ flex: 0, flexGrow: 0, backgroundColor: semanticDark.bg }),
    );
    expect(theme.toolbar.icon).toEqual({ tintColor: "white" });
    expect(theme.webview).toEqual({ backgroundColor: semanticDark.bg });
    colorSchemeSpy.mockRestore();
  });

  it("offsets the keyboard avoiding view by the header height", () => {
    loadNote();
    const { UNSAFE_getByType } = render(<EditorScreen />);

    const kav = UNSAFE_getByType(KeyboardAvoidingView);
    expect(kav.props.keyboardVerticalOffset).toBe(MOCK_HEADER_HEIGHT);
  });

  it.each([
    ["ios", "padding"],
    ["android", "height"],
  ] as const)("avoids the keyboard on %s (behavior %s)", (os, behavior) => {
    const originalOS = ReactNative.Platform.OS;
    Object.defineProperty(ReactNative.Platform, "OS", { value: os, configurable: true });
    try {
      loadNote();
      const { UNSAFE_getByType } = render(<EditorScreen />);

      expect(UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBe(behavior);
    } finally {
      Object.defineProperty(ReactNative.Platform, "OS", { value: originalOS, configurable: true });
    }
  });

  it("renders the attachment row between the body and the toolbar", () => {
    loadNote();
    render(<EditorScreen />);

    const [props] = mockNoteEditor.mock.calls[mockNoteEditor.mock.calls.length - 1] as [
      { accessory: React.ReactElement<{ noteId: string }> },
    ];
    expect(props.accessory.type).toBe(AttachmentPicker);
    expect(props.accessory.props.noteId).toBe("note-1");
  });

  it("keeps the attachment row above the home indicator with the keyboard down", () => {
    loadNote();
    const { getByTestId } = render(<EditorScreen />);

    const style = StyleSheet.flatten(getByTestId("editor-bottom-inset").props.style);
    expect(style.height).toBe(34);
    expect(style.backgroundColor).toBe(semanticLight.bg);
  });

  it("drops the bottom inset with the keyboard up, so the toolbar sits on the keyboard", () => {
    mockKeyboardVisible = true;
    loadNote();
    const { getByTestId } = render(<EditorScreen />);

    const style = StyleSheet.flatten(getByTestId("editor-bottom-inset").props.style);
    expect(style.height).toBe(0);
  });
});
