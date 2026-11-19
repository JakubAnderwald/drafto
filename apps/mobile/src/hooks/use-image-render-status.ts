import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorBridge } from "@10play/tentap-editor";
import type { WebViewMessageEvent } from "react-native-webview";
import { IMAGE_RENDER_STATUS_SCRIPT, parseImageRenderStatus } from "@drafto/shared";
import type { ImageRenderState } from "@drafto/shared";

import { areE2EProbesEnabled } from "@/lib/e2e-probes";

export interface ImageRenderStatus {
  /** The editor's images as the WebView last reported them. */
  images: ImageRenderState[];
  /** Pass to the editor's RichText; ignores every other message. */
  handleMessage: (event: WebViewMessageEvent) => void;
  /** Ask the WebView for a fresh report (after content was replaced). */
  refresh: () => void;
}

/**
 * Tracks whether each image in the editor rendered (ADR-0086): injects the
 * shared reporter once the editor is ready and keeps its latest report. Only
 * in E2E builds (`areE2EProbesEnabled`); otherwise it injects nothing and
 * reports no images.
 * Mirrors apps/desktop/src/hooks/use-image-render-status.ts.
 */
export function useImageRenderStatus(editor: EditorBridge, isReady: boolean): ImageRenderStatus {
  const [images, setImages] = useState<ImageRenderState[]>([]);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const enabled = areE2EProbesEnabled();

  const refresh = useCallback(() => {
    if (!enabled) return;
    editorRef.current.webviewRef?.current?.injectJavaScript(IMAGE_RENDER_STATUS_SCRIPT);
  }, [enabled]);

  useEffect(() => {
    if (isReady) refresh();
  }, [isReady, refresh]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!enabled) return;
      const report = parseImageRenderStatus(event.nativeEvent.data);
      if (report) setImages(report);
    },
    [enabled],
  );

  return { images, handleMessage, refresh };
}
