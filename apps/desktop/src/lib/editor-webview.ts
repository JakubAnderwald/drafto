import RNFS from "react-native-fs";

// How the note editor's WebView reaches cached attachment files (ADR-0086).
// WebKit gives a page loaded from an HTML string no read access to local
// files, whatever its base URL, and the sandboxed app's web content process
// can't read the container otherwise. So the editor page loads from a file in
// the attachment cache, with read access to the cache (editor-page.ts,
// use-editor-page.ts); this base URL (the container's Documents directory)
// only serves the inline fallback. Mirrors apps/mobile/src/lib/editor-webview.ts.

/** The inline editor page's base URL: the Documents directory, with a trailing slash. */
export function editorWebViewBaseUrl(): string {
  const path = RNFS.DocumentDirectoryPath;
  return `file://${path.endsWith("/") ? path : `${path}/`}`;
}

/**
 * WebView props for the editor. Android blocks every file:// load unless
 * `allowFileAccess` is on (WebKit ignores it: there the page file's
 * `allowingReadAccessToURL` grants read access to the cache). Pages loaded
 * from file:// still may not read other files with script
 * (`allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs` stay
 * off): images load, nothing else does.
 */
export const EDITOR_WEBVIEW_FILE_ACCESS_PROPS = {
  allowFileAccess: true,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  originWhitelist: ["about:*", "file://*", "data:*", "http://*", "https://*"],
} as const;
