import RNFS from "react-native-fs";
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
// URL: in the sandboxed app, cached images showed as broken. So the editor
// loads TenTap's own page (`editorHtml`, which it would otherwise load as a
// string) from <Documents>/attachment-cache/.editor/, with read access to
// attachment-cache/ and nothing else. Mirrors apps/mobile/src/lib/editor-page.ts.

/** How long an editor waits for the page file before it loads the page inline. */
export const EDITOR_PAGE_WRITE_TIMEOUT_MS = 3_000;

/** Whether the editor loads its page from a file (WebKit), not from a string: always on macOS. */
export function usesEditorPageFile(): boolean {
  return true;
}

let pageFileName: string | null = null;
let inFlight: Promise<EditorPageLocation | null> | null = null;

/** The page file's name, from TenTap's page (hashed once per launch). */
function currentPageFileName(): string {
  pageFileName ??= editorPageFileName(editorHtml);
  return pageFileName;
}

/** The attachment cache directory (attachment-cache.ts's, without loading the database). */
function cacheDir(): string {
  return `${RNFS.DocumentDirectoryPath}/${ATTACHMENT_CACHE_DIR_NAME}`;
}

async function hasContent(path: string): Promise<boolean> {
  if (!(await RNFS.exists(path))) return false;
  const { size } = await RNFS.stat(path);
  return Number(size) > 0;
}

/** Delete earlier versions of the page and leftovers of an interrupted write. Best-effort. */
async function removeStalePages(dir: string, keep: string): Promise<void> {
  for (const item of await RNFS.readDir(dir)) {
    if (item.name === keep) continue;
    try {
      await RNFS.unlink(`${dir}/${item.name}`);
    } catch (error) {
      console.warn("Failed to remove an old editor page:", error);
    }
  }
}

/**
 * Write the editor page into the cache unless it is already there (a sign-out
 * deletes the whole cache, so it is checked every time), and return where it
 * is. It is written beside its final name and then moved there, so a
 * half-written page is never loaded. Rejects when the write fails.
 */
export async function writeEditorPage(): Promise<EditorPageLocation> {
  const name = currentPageFileName();
  const root = cacheDir();
  const dir = `${root}/${EDITOR_PAGE_DIR_NAME}`;
  const target = `${dir}/${name}`;
  const location = editorPageLocation(`file://${root}`, name);
  if (await hasContent(target)) return location;
  // Left out of Time Machine / iCloud backups, like the rest of the cache.
  await RNFS.mkdir(root, { NSURLIsExcludedFromBackupKey: true });
  await RNFS.mkdir(dir);
  const temp = `${target}.tmp`;
  await RNFS.writeFile(temp, editorHtml, "utf8");
  if (await RNFS.exists(target)) await RNFS.unlink(target);
  await RNFS.moveFile(temp, target);
  await removeStalePages(dir, name);
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
    const attempt = writeEditorPage()
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
