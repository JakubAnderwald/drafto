import React from "react";
import type { EditorBridge } from "@10play/tentap-editor";

import { render, act } from "../../helpers/test-utils";
import { NoteEditor } from "@/components/editor/note-editor";

const mockRichText = jest.fn();
const mockToolbar = jest.fn();
jest.mock("@10play/tentap-editor", () => ({
  RichText: (props: Record<string, unknown>) => {
    mockRichText(props);
    return null;
  },
  Toolbar: (props: Record<string, unknown>) => {
    mockToolbar(props);
    return null;
  },
  DEFAULT_TOOLBAR_ITEMS: [],
}));

const mockPage: { current: { ready: boolean; webViewProps: Record<string, unknown> } } = {
  current: { ready: true, webViewProps: {} },
};
jest.mock("@/hooks/use-editor-page", () => ({
  useEditorPage: () => mockPage.current,
}));

function lastRichTextProps(): Record<string, unknown> {
  return mockRichText.mock.calls[mockRichText.mock.calls.length - 1][0];
}

describe("NoteEditor (desktop)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRichText.mockClear();
    mockToolbar.mockClear();
    mockPage.current = { ready: true, webViewProps: {} };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("leaves TenTap's own injected script alone, so every bridge's CSS is installed", () => {
    render(<NoteEditor editor={{} as EditorBridge} />);
    // The WebView mounts one tick after the component.
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockRichText).toHaveBeenCalled();
    const props = mockRichText.mock.calls[mockRichText.mock.calls.length - 1][0];
    // Passing injectedJavaScript replaces TenTap's script, which is what
    // installs the image max-width, blockquote, task list and placeholder CSS.
    expect(props).not.toHaveProperty("injectedJavaScript");
    expect(props.exclusivelyUseCustomOnMessage).toBe(false);
  });

  it("lets the WebView load cached attachment files, and nothing more (ADR-0086)", () => {
    render(<NoteEditor editor={{} as EditorBridge} />);
    act(() => {
      jest.advanceTimersByTime(100);
    });

    const props = mockRichText.mock.calls[mockRichText.mock.calls.length - 1][0];
    expect(props.allowFileAccessFromFileURLs).toBe(false);
    expect(props.allowUniversalAccessFromFileURLs).toBe(false);
    // The complete list: an extra entry (such as an unrestricted "*") fails.
    expect([...props.originWhitelist].sort()).toEqual(
      ["about:*", "data:*", "file://*", "http://*", "https://*"].sort(),
    );
  });

  it("loads the page from the page file, with read access to the cache (ADR-0086)", () => {
    const onLoad = jest.fn();
    const onError = jest.fn();
    mockPage.current = {
      ready: true,
      webViewProps: {
        source: { uri: "file:///docs/attachment-cache/.editor/editor-1.html" },
        allowingReadAccessToURL: "file:///docs/attachment-cache/",
        onLoad,
        onError,
      },
    };
    render(<NoteEditor editor={{} as EditorBridge} />);
    act(() => {
      jest.advanceTimersByTime(100);
    });

    const props = lastRichTextProps();
    expect(props.source).toEqual({ uri: "file:///docs/attachment-cache/.editor/editor-1.html" });
    expect(props.allowingReadAccessToURL).toBe("file:///docs/attachment-cache/");
    expect(props.onLoad).toBe(onLoad);
    expect(props.onError).toBe(onError);
    expect(props.allowFileAccessFromFileURLs).toBe(false);
    expect(props.allowUniversalAccessFromFileURLs).toBe(false);
  });

  it("passes no source for the inline fallback, so TenTap keeps its own", () => {
    render(<NoteEditor editor={{} as EditorBridge} />);
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect("source" in lastRichTextProps()).toBe(false);
  });

  it("PrimeTestLab 11035 S-02 always shows the formatting toolbar (macOS has no soft keyboard)", () => {
    const editor = {} as EditorBridge;
    render(<NoteEditor editor={editor} />);
    act(() => {
      jest.advanceTimersByTime(100);
    });

    const props = mockToolbar.mock.calls[mockToolbar.mock.calls.length - 1][0];
    // TenTap's default (hidden undefined) shows it only while a keyboard is up.
    expect(props.hidden).toBe(false);
    expect(props.editor).toBe(editor);
  });

  it("holds the WebView back until the page file is checked", () => {
    mockPage.current = { ready: false, webViewProps: {} };
    render(<NoteEditor editor={{} as EditorBridge} />);
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(mockRichText).not.toHaveBeenCalled();
  });
});
