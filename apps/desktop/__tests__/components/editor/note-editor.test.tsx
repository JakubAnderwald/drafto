import React from "react";
import type { EditorBridge } from "@10play/tentap-editor";

import { render, act } from "../../helpers/test-utils";
import { NoteEditor } from "@/components/editor/note-editor";

const mockRichText = jest.fn();
jest.mock("@10play/tentap-editor", () => ({
  RichText: (props: Record<string, unknown>) => {
    mockRichText(props);
    return null;
  },
  Toolbar: () => null,
  DEFAULT_TOOLBAR_ITEMS: [],
}));

describe("NoteEditor (desktop)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRichText.mockClear();
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
});
