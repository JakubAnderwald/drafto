import React from "react";
import { renderHook, act } from "@testing-library/react-native";
import type { EditorBridge } from "@10play/tentap-editor";
import type { WebViewMessageEvent } from "react-native-webview";
import { IMAGE_RENDER_STATUS_MESSAGE_TYPE, IMAGE_RENDER_STATUS_SCRIPT } from "@drafto/shared";

import { render } from "../helpers/test-utils";
import { ImageRenderStatus } from "@/components/editor/image-render-status";
import { useImageRenderStatus } from "@/hooks/use-image-render-status";

let mockProbesEnabled = true;
jest.mock("@/lib/e2e-probes", () => ({
  areE2EProbesEnabled: () => mockProbesEnabled,
}));

const message = (data: string) => ({ nativeEvent: { data } }) as WebViewMessageEvent;
const REPORT = JSON.stringify({
  type: IMAGE_RENDER_STATUS_MESSAGE_TYPE,
  images: [{ name: "a.jpg", rendered: true, height: 10, local: true }],
});
const IMAGE = { name: "photo.jpg", rendered: true, height: 240, local: true };

function setup(isReady: boolean) {
  const injectJavaScript = jest.fn();
  const editor = { webviewRef: { current: { injectJavaScript } } } as unknown as EditorBridge;
  const hook = renderHook(() => useImageRenderStatus(editor, isReady));
  return { injectJavaScript, hook };
}

beforeEach(() => {
  mockProbesEnabled = true;
});

describe("image render status probes in an E2E build (ADR-0086)", () => {
  it("labels each image for the E2E checks", () => {
    const { getByLabelText } = render(<ImageRenderStatus images={[IMAGE]} />);
    expect(getByLabelText("Image shown: photo.jpg").props.testID).toBe("editor-image-rendered");
  });

  it("keeps two images with the same name apart, so Maestro sees both", () => {
    const { getAllByLabelText } = render(<ImageRenderStatus images={[IMAGE, IMAGE]} />);
    const tops = getAllByLabelText("Image shown: photo.jpg").map(
      (node) => (node.props.style as { top?: number }[])[1].top,
    );
    expect(tops).toEqual([0, 1]);
  });

  it("injects the reporter and keeps its report", () => {
    const { injectJavaScript, hook } = setup(true);
    expect(injectJavaScript).toHaveBeenCalledWith(IMAGE_RENDER_STATUS_SCRIPT);
    act(() => hook.result.current.handleMessage(message(REPORT)));
    expect(hook.result.current.images).toHaveLength(1);
  });
});

describe("image render status probes in any other build", () => {
  beforeEach(() => {
    mockProbesEnabled = false;
  });

  it("renders no views, so screen readers never read them", () => {
    const { queryByTestId, queryByLabelText } = render(<ImageRenderStatus images={[IMAGE]} />);
    expect(queryByTestId("editor-image-status")).toBeNull();
    expect(queryByLabelText("Image shown: photo.jpg")).toBeNull();
  });

  it("injects nothing and keeps no report", () => {
    const { injectJavaScript, hook } = setup(true);
    act(() => hook.result.current.refresh());
    act(() => hook.result.current.handleMessage(message(REPORT)));
    expect(injectJavaScript).not.toHaveBeenCalled();
    expect(hook.result.current.images).toEqual([]);
  });
});
