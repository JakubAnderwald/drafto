import { useCallback, useEffect, useMemo, useState } from "react";
import type { WebViewProps } from "react-native-webview";
import type { EditorPageLocation } from "@drafto/shared";

import { ensureEditorPage, usesEditorPageFile } from "@/lib/editor-page";

type WebViewErrorEvent = Parameters<NonNullable<WebViewProps["onError"]>>[0];

/** Props for the editor's RichText that load its page from the page file. */
export interface EditorPageWebViewProps {
  source?: { uri: string };
  allowingReadAccessToURL?: string;
  onLoad?: () => void;
  onError?: (event: WebViewErrorEvent) => void;
}

export interface EditorPage {
  /** False while the page file is checked or written: don't mount the WebView yet. */
  ready: boolean;
  /**
   * Spread onto RichText. Without a `source` (Android, or the fallback) TenTap
   * loads its page inline from its HTML string with the editor's base URL, as
   * before; the key is left out then, never set to undefined, which would
   * replace TenTap's own source.
   */
  webViewProps: EditorPageWebViewProps;
}

type PageState =
  | { kind: "loading" }
  | { kind: "file"; location: EditorPageLocation; loaded: boolean }
  | { kind: "inline"; readAccessUrl?: string };

/**
 * Where the note editor loads its page from (ADR-0086). On iOS that is the
 * page file in the attachment cache, written first if missing, with read
 * access to the cache, so cached images show. When the file can't be written
 * in time, or fails to load, the editor loads its page inline instead, as it
 * did before (cached images may then not show). TenTap boots a page loaded
 * from a file by injecting its boot script before the page's content loads.
 * Mirrors apps/desktop/src/hooks/use-editor-page.ts.
 */
export function useEditorPage(): EditorPage {
  const [state, setState] = useState<PageState>(() =>
    usesEditorPageFile() ? { kind: "loading" } : { kind: "inline" },
  );

  useEffect(() => {
    if (!usesEditorPageFile()) return;
    let cancelled = false;
    void ensureEditorPage().then((location) => {
      if (cancelled) return;
      setState(location ? { kind: "file", location, loaded: false } : { kind: "inline" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLoad = useCallback(() => {
    setState((current) =>
      current.kind === "file" && !current.loaded ? { ...current, loaded: true } : current,
    );
  }, []);

  // Only until the page first loads: a failure then (a missing or unreadable
  // file) falls back to the inline page. The default error view is skipped,
  // since the inline page replaces it at once.
  const handleError = useCallback((event: WebViewErrorEvent) => {
    event.preventDefault();
    console.warn("The editor page file failed to load; loading it inline:", event.nativeEvent);
    setState((current) =>
      current.kind === "file"
        ? { kind: "inline", readAccessUrl: current.location.readAccessUrl }
        : current,
    );
  }, []);

  const uri = state.kind === "file" ? state.location.uri : undefined;
  const readAccessUrl =
    state.kind === "file"
      ? state.location.readAccessUrl
      : state.kind === "inline"
        ? state.readAccessUrl
        : undefined;
  const awaitingLoad = state.kind === "file" && !state.loaded;

  const webViewProps = useMemo<EditorPageWebViewProps>(() => {
    const props: EditorPageWebViewProps = {};
    if (uri) props.source = { uri };
    // Kept after a fallback, so dropping it doesn't load the page once more.
    if (readAccessUrl) props.allowingReadAccessToURL = readAccessUrl;
    if (awaitingLoad) {
      props.onLoad = handleLoad;
      props.onError = handleError;
    }
    return props;
  }, [uri, readAccessUrl, awaitingLoad, handleLoad, handleError]);

  return { ready: state.kind !== "loading", webViewProps };
}
