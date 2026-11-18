import { Paths } from "expo-file-system";

// How the note editor's WebView reaches cached attachment files (ADR-0086).
// TenTap loads the editor page from an HTML string; giving that page a file://
// base URL in the app's Documents directory lets <img> load the cached copies
// under Documents/attachment-cache/. Mirrors apps/desktop/src/lib/editor-webview.ts.

/** The editor page's base URL: the Documents directory, with a trailing slash. */
export function editorWebViewBaseUrl(): string {
  const uri = Paths.document.uri;
  return uri.endsWith("/") ? uri : `${uri}/`;
}

/**
 * WebView props for the editor. Android blocks every file:// load unless
 * `allowFileAccess` is on (iOS reads under the base URL without it). Pages
 * loaded from file:// still may not read other files with script
 * (`allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs` stay
 * off): images load, nothing else does.
 */
export const EDITOR_WEBVIEW_FILE_ACCESS_PROPS = {
  allowFileAccess: true,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  originWhitelist: ["about:*", "file://*", "data:*", "http://*", "https://*"],
} as const;
