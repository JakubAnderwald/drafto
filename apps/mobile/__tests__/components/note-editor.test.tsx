import React from "react";
import { Text } from "react-native";
import type { EditorBridge } from "@10play/tentap-editor";

import { render } from "../helpers/test-utils";
import { NoteEditor } from "@/components/editor/note-editor";

const mockRichTextProps = jest.fn();
jest.mock("@10play/tentap-editor", () => {
  const { Text: MockText } = require("react-native");
  return {
    RichText: (props: Record<string, unknown>) => {
      mockRichTextProps(props);
      return <MockText>body</MockText>;
    },
    Toolbar: () => <MockText>toolbar</MockText>,
    DEFAULT_TOOLBAR_ITEMS: [],
  };
});

const editor = {} as EditorBridge;

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
});
