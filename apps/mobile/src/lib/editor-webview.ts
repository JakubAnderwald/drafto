import { Paths } from "expo-file-system";

// How the note editor's WebView reaches cached attachment files (ADR-0086).
// On Android TenTap loads the editor page from an HTML string; a file:// base
// URL in the app's Documents directory plus `allowFileAccess` let <img> load
// the cached copies under Documents/attachment-cache/. WebKit (iOS) gives a
// page loaded from a string no read access to local files, so there the page
// loads from a file in the cache instead (editor-page.ts, use-editor-page.ts),
// and this base URL only serves the inline fallback.
// Mirrors apps/desktop/src/lib/editor-webview.ts.

/** The inline editor page's base URL: the Documents directory, with a trailing slash. */
export function editorWebViewBaseUrl(): string {
  const uri = Paths.document.uri;
  return uri.endsWith("/") ? uri : `${uri}/`;
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
