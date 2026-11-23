import React from "react";
import { Text } from "react-native";
import type { EditorBridge } from "@10play/tentap-editor";

import { render } from "../helpers/test-utils";
import { NoteEditor } from "@/components/editor/note-editor";

const mockRichTextProps = jest.fn();
const mockToolbarProps = jest.fn();
jest.mock("@10play/tentap-editor", () => {
  const { Text: MockText } = require("react-native");
  return {
    RichText: (props: Record<string, unknown>) => {
      mockRichTextProps(props);
      return <MockText>body</MockText>;
    },
    Toolbar: (props: Record<string, unknown>) => {
      mockToolbarProps(props);
      return <MockText>toolbar</MockText>;
    },
    DEFAULT_TOOLBAR_ITEMS: [],
  };
});

const mockPage: { current: { ready: boolean; webViewProps: Record<string, unknown> } } = {
  current: { ready: true, webViewProps: {} },
};
jest.mock("@/hooks/use-editor-page", () => ({
  useEditorPage: () => mockPage.current,
}));

const editor = {} as EditorBridge;

beforeEach(() => {
  mockRichTextProps.mockClear();
  mockToolbarProps.mockClear();
  mockPage.current = { ready: true, webViewProps: {} };
});

function lastRichTextProps(): Record<string, unknown> {
  return mockRichTextProps.mock.calls[mockRichTextProps.mock.calls.length - 1][0];
}

describe("NoteEditor", () => {
  it("renders the accessory between the body and the toolbar, so the toolbar meets the keyboard", () => {
    const { toJSON } = render(<NoteEditor editor={editor} accessory={<Text>attachments</Text>} />);

    const rendered = JSON.stringify(toJSON());
    const body = rendered.indexOf('"body"');
    const accessory = rendered.indexOf('"attachments"');
    const toolbar = rendered.indexOf('"toolbar"');

    expect(body).toBeGreaterThanOrEqual(0);
    expect(accessory).toBeGreaterThan(body);
    expect(toolbar).toBeGreaterThan(accessory);
  });

  it("PrimeTestLab 11035 S-02 keeps the formatting toolbar shown with the keyboard closed", () => {
    render(<NoteEditor editor={editor} />);

    const props = mockToolbarProps.mock.calls[mockToolbarProps.mock.calls.length - 1][0];
    // TenTap's default (hidden undefined) hides it while the keyboard is down
    // or the editor is blurred; false shows it always.
    expect(props.hidden).toBe(false);
    expect(props.editor).toBe(editor);
  });

  it("renders without an accessory", () => {
    const { getByText } = render(<NoteEditor editor={editor} />);

    expect(getByText("body")).toBeTruthy();
    expect(getByText("toolbar")).toBeTruthy();
  });

  it("lets the WebView load cached attachment files, and nothing more (ADR-0086)", () => {
    const onMessage = jest.fn();
    render(<NoteEditor editor={editor} onMessage={onMessage} />);

    const props = mockRichTextProps.mock.calls[mockRichTextProps.mock.calls.length - 1][0];
    expect(props.allowFileAccess).toBe(true);
    expect(props.allowFileAccessFromFileURLs).toBe(false);
    expect(props.allowUniversalAccessFromFileURLs).toBe(false);
    // The complete list: an extra entry (such as an unrestricted "*") fails.
    expect([...props.originWhitelist].sort()).toEqual(
      ["about:*", "data:*", "file://*", "http://*", "https://*"].sort(),
    );
    // TenTap's bridges keep receiving their messages alongside ours.
    expect(props.onMessage).toBe(onMessage);
    expect(props.exclusivelyUseCustomOnMessage).toBe(false);
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
    render(<NoteEditor editor={editor} />);

    const props = lastRichTextProps();
    expect(props.source).toEqual({ uri: "file:///docs/attachment-cache/.editor/editor-1.html" });
    expect(props.allowingReadAccessToURL).toBe("file:///docs/attachment-cache/");
    expect(props.onLoad).toBe(onLoad);
    expect(props.onError).toBe(onError);
    // Script still may not read files.
    expect(props.allowFileAccessFromFileURLs).toBe(false);
    expect(props.allowUniversalAccessFromFileURLs).toBe(false);
  });

  it("passes no source for the inline page, so TenTap keeps its own (Android)", () => {
    render(<NoteEditor editor={editor} />);
    expect("source" in lastRichTextProps()).toBe(false);
    expect("allowingReadAccessToURL" in lastRichTextProps()).toBe(false);
  });

  it("holds the WebView back until the page file is checked, keeping the toolbar", () => {
    mockPage.current = { ready: false, webViewProps: {} };
    const { getByTestId, getByText, queryByText } = render(
      <NoteEditor editor={editor} accessory={<Text>attachments</Text>} />,
    );
    expect(mockRichTextProps).not.toHaveBeenCalled();
    expect(queryByText("body")).toBeNull();
    expect(getByTestId("note-editor-page-loading")).toBeTruthy();
    expect(getByText("attachments")).toBeTruthy();
    expect(getByText("toolbar")).toBeTruthy();
  });
});
