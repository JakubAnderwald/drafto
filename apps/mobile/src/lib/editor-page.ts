import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { editorHtml } from "@10play/tentap-editor";
import {
  ATTACHMENT_CACHE_DIR_NAME,
  EDITOR_PAGE_DIR_NAME,
  editorPageFileName,
  editorPageLocation,
} from "@drafto/shared";
import type { EditorPageLocation } from "@drafto/shared";

// The note editor's page as a file inside the attachment cache (ADR-0086).
// WebKit lets the editor read cached images only when its page is loaded from
// a file with read access to their directory (`loadFileURL:
// allowingReadAccessToURL:`), never for an HTML string with a file:// base
// URL: on a device, cached images showed as broken. So on iOS the editor loads
// TenTap's own page (`editorHtml`, which it would otherwise load as a string)
// from <Documents>/attachment-cache/.editor/, with read access to
// attachment-cache/ and nothing else. Android keeps loading the string with a
// base URL, which its `allowFileAccess` serves. Mirrors
// apps/desktop/src/lib/editor-page.ts.

/** How long an editor waits for the page file before it loads the page inline. */
export const EDITOR_PAGE_WRITE_TIMEOUT_MS = 3_000;

/** Whether the editor loads its page from a file (WebKit), not from a string. */
export function usesEditorPageFile(): boolean {
  return Platform.OS === "ios";
}

let pageFileName: string | null = null;
let inFlight: Promise<EditorPageLocation | null> | null = null;

/** The page file's name, from TenTap's page (hashed once per launch). */
function currentPageFileName(): string {
  pageFileName ??= editorPageFileName(editorHtml);
  return pageFileName;
}

/** The attachment cache directory (attachment-cache.ts's, without loading the database). */
function cacheDir(): Directory {
  return new Directory(Paths.document, ATTACHMENT_CACHE_DIR_NAME);
}

/** Delete earlier versions of the page and leftovers of an interrupted write. Best-effort. */
function removeStalePages(dir: Directory, keep: string): void {
  for (const item of dir.list()) {
    if (item.name === keep) continue;
    try {
      item.delete();
    } catch (error) {
      console.warn("Failed to remove an old editor page:", error);
    }
  }
}

/**
 * Write the editor page into the cache unless it is already there (a sign-out
 * deletes the whole cache, so it is checked every time), and return where it
 * is. It is written beside its final name and then moved there, so a
 * half-written page is never loaded. Throws when the write fails.
 */
export function writeEditorPage(): EditorPageLocation {
  const name = currentPageFileName();
  const cache = cacheDir();
  const location = editorPageLocation(cache.uri, name);
  const dir = new Directory(cache, EDITOR_PAGE_DIR_NAME);
  const target = new File(dir, name);
  if (target.exists && target.size > 0) return location;
  dir.create({ intermediates: true, idempotent: true });
  const temp = new File(dir, `${name}.tmp`);
  if (temp.exists) temp.delete();
  temp.create();
  temp.write(editorHtml);
  if (target.exists) target.delete();
  temp.move(target);
  removeStalePages(dir, name);
  return location;
}

/**
 * The editor page's location, written first if it is missing; null when it
 * could not be written within EDITOR_PAGE_WRITE_TIMEOUT_MS, and the editor
 * then loads its page inline (cached images may not show). Calls made while a
 * write runs share it. Never rejects.
 */
export function ensureEditorPage(): Promise<EditorPageLocation | null> {
  if (!inFlight) {
    const attempt = Promise.resolve()
      .then(writeEditorPage)
      .catch((error: unknown) => {
        console.warn("Failed to write the editor page; loading it inline:", error);
        return null;
      })
      .finally(() => {
        if (inFlight === attempt) inFlight = null;
      });
    inFlight = attempt;
  }
  const running = inFlight;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn("Writing the editor page timed out; loading it inline");
      resolve(null);
    }, EDITOR_PAGE_WRITE_TIMEOUT_MS);
    void running.then((location) => {
      clearTimeout(timer);
      resolve(location);
    });
  });
}
