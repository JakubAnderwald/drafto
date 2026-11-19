import { cyrb64Hex } from "../hash/cyrb64";

// The note editor's page as a file, for WebKit (ADR-0086). iOS and macOS load
// TenTap's editor page from a file inside the attachment cache, with read
// access to the cache directory, because WebKit lets its (sandboxed) web
// content process read local files only for a page loaded with
// `loadFileURL:allowingReadAccessToURL:`. A page loaded from an HTML string
// with a file:// base URL gets no read access, so cached images showed broken.

/**
 * The folder in the attachment cache that holds the editor page. Its name
 * starts with a dot, so it can never be a cached attachment's folder
 * (`attachmentCacheRelativePath` never makes a segment that does), and the
 * cache's walk skips it like the other reserved names: it is never indexed,
 * evicted or swept as an orphan.
 */
export const EDITOR_PAGE_DIR_NAME = ".editor";

/**
 * The page file's name. It changes with the HTML (a hash and its length), so
 * a new TenTap version writes a new file, and an existing one is never
 * rewritten.
 */
export function editorPageFileName(html: string): string {
  return `editor-${cyrb64Hex(html)}-${html.length.toString(36)}.html`;
}

/** Where the editor page is, as the WebView needs it. */
export interface EditorPageLocation {
  /** The page file's file:// URL (the WebView's `source.uri`). */
  uri: string;
  /**
   * The directory the page may read files under (the WebView's
   * `allowingReadAccessToURL`): the attachment cache, with a trailing slash.
   */
  readAccessUrl: string;
}

/**
 * The page's location, from the attachment cache directory's file:// URL and
 * the page file's name.
 */
export function editorPageLocation(cacheDirUrl: string, fileName: string): EditorPageLocation {
  const readAccessUrl = cacheDirUrl.endsWith("/") ? cacheDirUrl : `${cacheDirUrl}/`;
  return { uri: `${readAccessUrl}${EDITOR_PAGE_DIR_NAME}/${fileName}`, readAccessUrl };
}
