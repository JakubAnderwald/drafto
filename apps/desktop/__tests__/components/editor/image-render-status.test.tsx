import React from "react";
import { renderHook, act } from "@testing-library/react-native";
import type { EditorBridge } from "@10play/tentap-editor";
import type { WebViewMessageEvent } from "react-native-webview";
import { IMAGE_RENDER_STATUS_MESSAGE_TYPE, IMAGE_RENDER_STATUS_SCRIPT } from "@drafto/shared";

import { render } from "../../helpers/test-utils";
import { ImageRenderStatus } from "@/components/editor/image-render-status";
import { useImageRenderStatus } from "@/hooks/use-image-render-status";
import { editorWebViewBaseUrl } from "@/lib/editor-webview";

const message = (data: string) => ({ nativeEvent: { data } }) as WebViewMessageEvent;

describe("ImageRenderStatus (ADR-0086)", () => {
  it("renders nothing until the WebView reports an image", () => {
    const { queryByTestId } = render(<ImageRenderStatus images={[]} />);
    expect(queryByTestId("editor-image-status")).toBeNull();
  });

  it("labels each image shown or not loaded, sized like the image on screen", () => {
    const { getByLabelText } = render(
      <ImageRenderStatus
        images={[
          { name: "photo.jpg", rendered: true, height: 240, local: true },
          { name: "gone.png", rendered: false, height: 16, local: false },
        ]}
      />,
    );
    const shown = getByLabelText("Image shown: photo.jpg");
    const missing = getByLabelText("Image not loaded: gone.png");
    expect(shown.props.testID).toBe("editor-image-rendered");
    expect(missing.props.testID).toBe("editor-image-missing");
    expect(shown.props.style).toEqual(expect.arrayContaining([{ height: 240 }]));
    expect(missing.props.style).toEqual(expect.arrayContaining([{ height: 1 }]));
  });
});

describe("useImageRenderStatus", () => {
  function setup(isReady: boolean) {
    const injectJavaScript = jest.fn();
    const editor = { webviewRef: { current: { injectJavaScript } } } as unknown as EditorBridge;
    const hook = renderHook(({ ready }) => useImageRenderStatus(editor, ready), {
      initialProps: { ready: isReady },
    });
    return { injectJavaScript, hook };
  }

  it("injects the reporter once the editor is ready, and again on refresh", () => {
    const { injectJavaScript, hook } = setup(false);
    expect(injectJavaScript).not.toHaveBeenCalled();
    hook.rerender({ ready: true });
    expect(injectJavaScript).toHaveBeenCalledWith(IMAGE_RENDER_STATUS_SCRIPT);
    act(() => hook.result.current.refresh());
    expect(injectJavaScript).toHaveBeenCalledTimes(2);
  });

  it("keeps the latest report and ignores other messages", () => {
    const { hook } = setup(true);
    act(() => {
      hook.result.current.handleMessage(message(JSON.stringify({ type: "draftoFindResult" })));
    });
    expect(hook.result.current.images).toEqual([]);
    act(() => {
      hook.result.current.handleMessage(
        message(
          JSON.stringify({
            type: IMAGE_RENDER_STATUS_MESSAGE_TYPE,
            images: [{ name: "a.jpg", rendered: true, height: 10, local: true }],
          }),
        ),
      );
    });
    expect(hook.result.current.images).toEqual([
      { name: "a.jpg", rendered: true, height: 10, local: true },
    ]);
  });
});

describe("editorWebViewBaseUrl", () => {
  it("is the container's Documents directory as a file:// URL with a trailing slash", () => {
    expect(editorWebViewBaseUrl()).toBe("file:///mock/documents/");
  });
});
