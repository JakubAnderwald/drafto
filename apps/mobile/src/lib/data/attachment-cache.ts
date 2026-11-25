import { Directory, File } from "expo-file-system";
import { Q } from "@nozbe/watermelondb";

import {
  ATTACHMENT_CACHE_INDEX_FILE_NAME,
  AttachmentCacheIndex,
  EDITOR_PAGE_DIR_NAME,
  attachmentCacheRelativePath,
  isCacheableAttachment,
  parseAttachmentCacheIndex,
  planAttachmentCacheEviction,
} from "@drafto/shared";
import type { AttachmentCacheEntry, AttachmentCacheFile } from "@drafto/shared";

import { database, Attachment, Note } from "@/db";
import { generateId } from "@/lib/generate-id";
import {
  ensureAttachmentCacheRoot,
  forgetAttachmentCacheRoot,
  getAttachmentCacheDir,
} from "@/lib/data/attachment-cache-root";

// The device's copy of each image attachment, so images show offline
// (ADR-0086). Files live under <Documents>/attachment-cache/<storage path>,
// the directory the editor WebView is given read access to. On iOS the editor
// page itself is kept there too, in .editor/ (see editor-page.ts). The folder
// stays out of iCloud and device backups: everything written into it goes
// through ensureAttachmentCacheRoot() first (ADR-0099). Mirrors
// apps/desktop/src/lib/data/attachment-cache.ts (react-native-fs there).

/** Cap on the cache. Files whose upload hasn't finished don't count against eviction. */
export const ATTACHMENT_CACHE_MAX_BYTES = 300 * 1024 * 1024;

/** Downloads land here first and are moved into place once complete. */
const PARTIAL_DIR_NAME = ".partial";

/** How long the index waits for more changes before it is saved. */
const INDEX_SAVE_DELAY_MS = 2_000;

/** Upload states whose cached file is the only copy: never evicted. */
const UNSYNCED_STATUSES = ["pending", "failed", "quota_exceeded"];

// Bumped by deleteAttachmentCache (sign-out), so work still running for the
// previous account is thrown away instead of landing in the new cache.
let generation = 0;
// Each cached file's size and last use, and the running total (see
// AttachmentCacheIndex). Filled by one walk of the directory on first use.
const index = new AttachmentCacheIndex();
let indexSaveTimer: ReturnType<typeof setTimeout> | null = null;
// One download per attachment at a time.
const downloadsInFlight = new Map<string, Promise<string | null>>();
// The partial file name of every download still running, in any generation:
// the orphan cleanup never deletes one of these.
const activePartials = new Set<string>();
// Files written for an attachment whose row isn't in the database yet, by
// relative path: neither eviction nor the orphan cleanup may delete them.
const held = new Map<string, number>();
let evictionInFlight: Promise<void> | null = null;
// Set by a call that joined the running eviction: it runs once more.
let evictAgain = false;

export { getAttachmentCacheDir };

function fileAt(relativePath: string): File {
  return new File(getAttachmentCacheDir(), ...relativePath.split("/"));
}

/** Where the cached copy of the attachment stored at `filePath` lives (it may not exist). */
export function cacheFileFor(filePath: string): File {
  return fileAt(attachmentCacheRelativePath(filePath));
}

/**
 * `cacheFileFor(filePath)`, with its folders created so a file can be written
 * there, and the cache folder flagged to stay out of backups.
 */
export function prepareCacheFile(filePath: string): File {
  ensureAttachmentCacheRoot();
  const file = cacheFileFor(filePath);
  file.parentDirectory.create({ intermediates: true, idempotent: true });
  return file;
}

/** Delete `item` if it exists. True when it is gone; false when deleting it failed. */
function safeDelete(item: File | Directory): boolean {
  try {
    if (item.exists) item.delete();
    return true;
  } catch {
    // Best-effort: a leftover file is evicted or cleaned up later.
    return false;
  }
}

// --- The index ---

/**
 * Names at the top of the cache that are not cached attachments: downloads in
 * progress, the index, and the editor page (see editor-page.ts), which must
 * never be indexed, evicted or swept as an orphan. Every one starts with a
 * dot, which no cached attachment's name does.
 */
function isReservedName(name: string): boolean {
  return (
    name === PARTIAL_DIR_NAME ||
    name === ATTACHMENT_CACHE_INDEX_FILE_NAME ||
    name === EDITOR_PAGE_DIR_NAME
  );
}

function walk(dir: Directory, prefix: string, out: AttachmentCacheFile[]): void {
  for (const item of dir.list()) {
    if (!prefix && isReservedName(item.name)) continue;
    const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
    if (item instanceof Directory) {
      walk(item, relativePath, out);
    } else {
      out.push({ relativePath, size: item.size, modifiedAt: item.modificationTime ?? 0 });
    }
  }
}

function indexFile(): File {
  return new File(getAttachmentCacheDir(), ATTACHMENT_CACHE_INDEX_FILE_NAME);
}

/** The index, filled by one walk of the cache directory the first time it is needed. */
function loadedIndex(): AttachmentCacheIndex {
  if (index.isLoaded) return index;
  const found: AttachmentCacheFile[] = [];
  let saved = new Map<string, number>();
  try {
    const dir = getAttachmentCacheDir();
    if (dir.exists) {
      // A cache made before the backup flag existed (1.4.x) gets it now.
      ensureAttachmentCacheRoot();
      walk(dir, "", found);
      const file = indexFile();
      if (file.exists) saved = parseAttachmentCacheIndex(file.textSync());
    }
  } catch (error) {
    console.warn("Failed to read the attachment cache:", error);
  }
  index.load(found, saved);
  return index;
}

/** Save the index now. Never throws. */
export function flushAttachmentCacheIndex(): void {
  if (indexSaveTimer) clearTimeout(indexSaveTimer);
  indexSaveTimer = null;
  if (!index.isLoaded) return;
  try {
    // Never create the cache directory just for the index.
    if (!getAttachmentCacheDir().exists) return;
    const file = indexFile();
    if (!file.exists) file.create();
    file.write(index.serialize());
  } catch (error) {
    console.warn("Failed to save the attachment cache index:", error);
  }
}

/** Save the index once changes stop for a moment, so a burst of them writes it once. */
function saveIndexSoon(): void {
  if (indexSaveTimer) return;
  const scheduledIn = generation;
  indexSaveTimer = setTimeout(() => {
    indexSaveTimer = null;
    if (generation === scheduledIn) flushAttachmentCacheIndex();
  }, INDEX_SAVE_DELAY_MS);
}

/** `file` (the cached copy of `filePath`) was just written. */
function noteWritten(filePath: string, file: File): void {
  loadedIndex().record(attachmentCacheRelativePath(filePath), file.size, Date.now());
  saveIndexSoon();
}

/**
 * The index missed a file in the cache: save the last-use times it has, then
 * empty it, so its next use walks the cache again.
 */
function reindexOnNextUse(): void {
  flushAttachmentCacheIndex();
  index.clear();
}

function noteRemoved(relativePath: string): void {
  loadedIndex().remove(relativePath);
  saveIndexSoon();
}

/** The cache as a prefetch pass sees it: what is cached and how full it is. */
export function getAttachmentCacheState(): {
  totalBytes: number;
  isCached: (filePath: string) => boolean;
} {
  const current = loadedIndex();
  return {
    totalBytes: current.totalBytes,
    isCached: (filePath) => current.has(attachmentCacheRelativePath(filePath)),
  };
}

/** Every file in the cache (downloads in progress excluded). */
export function listAttachmentCache(): AttachmentCacheEntry[] {
  return loadedIndex().entries();
}

// --- Reading and writing cached files ---

/** The cached copy's `file://` URI, or null when there is none (or it is empty). */
export function getCachedAttachmentUri(filePath: string): string | null {
  try {
    const file = cacheFileFor(filePath);
    const relativePath = attachmentCacheRelativePath(filePath);
    if (!file.exists || file.size === 0) {
      if (index.has(relativePath)) noteRemoved(relativePath);
      return null;
    }
    if (!loadedIndex().touch(relativePath, Date.now())) {
      loadedIndex().record(relativePath, file.size, Date.now());
    }
    saveIndexSoon();
    return file.uri;
  } catch {
    return null;
  }
}

/**
 * Keep the file for an attachment whose database row is about to be written:
 * until the returned release is called, neither eviction nor the orphan
 * cleanup deletes it. Call the release once the row exists (or the save failed).
 */
export function holdCacheFile(filePath: string): () => void {
  const relativePath = attachmentCacheRelativePath(filePath);
  held.set(relativePath, (held.get(relativePath) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (held.get(relativePath) ?? 1) - 1;
    if (count > 0) held.set(relativePath, count);
    else held.delete(relativePath);
  };
}

/**
 * Copy a picked image into the cache, at its storage path, and return the
 * copy's URI. Throws when the copy is missing or empty.
 */
export function copyIntoCache(sourceUri: string, filePath: string): string {
  const destination = prepareCacheFile(filePath);
  new File(sourceUri).copy(destination);
  if (!destination.exists || destination.size === 0) {
    throw new Error("File copy failed — destination is missing or empty");
  }
  noteWritten(filePath, destination);
  return destination.uri;
}

/** The cache's current generation; pass it to `downloadToCache` from work that awaits first. */
export function getAttachmentCacheGeneration(): number {
  return generation;
}

async function download(filePath: string, url: string, startedIn: number): Promise<string | null> {
  const destination = cacheFileFor(filePath);
  if (destination.exists && destination.size > 0) return destination.uri;

  // Each download writes to a file of its own (a fresh id), so one a wipe
  // overtook never writes into a later session's partial file.
  const partialDir = new Directory(ensureAttachmentCacheRoot(), PARTIAL_DIR_NAME);
  partialDir.create({ intermediates: true, idempotent: true });
  const partialName = `${generateId()}.part`;
  const partial = new File(partialDir, partialName);
  activePartials.add(partialName);
  try {
    try {
      await File.downloadFileAsync(url, partial, { idempotent: true });
    } catch (error) {
      // A download the wipe overtook is obsolete, failed or not.
      if (generation !== startedIn) return null;
      throw error;
    }
    // Everything below is synchronous, so the cache can't be wiped part-way.
    if (generation !== startedIn) return null;
    if (!partial.exists || partial.size === 0) throw new Error("Downloaded file is empty");
    const target = prepareCacheFile(filePath);
    safeDelete(target);
    partial.move(target);
    const placed = cacheFileFor(filePath);
    noteWritten(filePath, placed);
    return placed.uri;
  } finally {
    // `partial` now names the moved file, so address the leftover by name.
    // Deleted even after a wipe: the name is this download's own, so an
    // obsolete download leaves nothing in a later session's cache.
    safeDelete(new File(partialDir, partialName));
    activePartials.delete(partialName);
  }
}

/**
 * Download the image at `url` into the cache, unless it is already there.
 * The file is written beside the cache and moved into place once complete, so
 * a half-written file is never shown. Concurrent calls for one attachment share
 * a download. Resolves to the cached file's URI, or null when the cache was
 * wiped (sign-out) while it ran, or since `startedIn` (the generation the
 * caller's work began in, before it awaited the signed URL). Rejects when the
 * download fails.
 */
export function downloadToCache(
  filePath: string,
  url: string,
  startedIn: number = generation,
): Promise<string | null> {
  if (startedIn !== generation) return Promise.resolve(null);
  const key = attachmentCacheRelativePath(filePath);
  const running = downloadsInFlight.get(key);
  if (running) return running;
  const attempt = download(filePath, url, generation).finally(() => {
    if (downloadsInFlight.get(key) === attempt) downloadsInFlight.delete(key);
  });
  downloadsInFlight.set(key, attempt);
  return attempt;
}

/**
 * Keep an uploaded image's local file as its cached copy. A file picked
 * before the cache existed lives in the old attachments folder: it is moved
 * into the cache. If the move fails the file is deleted, as before. Never
 * throws: it runs after the upload is recorded, so a cache failure must not
 * fail the upload.
 */
export function retainInCache(localUri: string, filePath: string): void {
  const target = cacheFileFor(filePath);
  if (target.uri === localUri) {
    try {
      if (target.exists) noteWritten(filePath, target);
    } catch (error) {
      console.warn("Failed to record the cached attachment:", error);
    }
    return;
  }
  const source = new File(localUri);
  try {
    if (!source.exists) return;
    const destination = prepareCacheFile(filePath);
    safeDelete(destination);
    source.move(destination);
  } catch {
    // The move failed: the old file isn't needed any more, as before.
    safeDelete(source);
    return;
  }
  // The file is in the cache now (`source` names it there): keep it even if
  // recording it fails, and walk the cache again on the next use of the
  // index, so eviction counts the file.
  try {
    noteWritten(filePath, cacheFileFor(filePath));
  } catch (error) {
    console.warn("Failed to record the cached attachment:", error);
    reindexOnNextUse();
  }
}

/**
 * Delete the cached copy of the attachment stored at `filePath`, if there is
 * one. A file that can't be deleted stays in the index, so the orphan cleanup
 * retries it.
 */
export function deleteFromCache(filePath: string): void {
  if (safeDelete(cacheFileFor(filePath))) noteRemoved(attachmentCacheRelativePath(filePath));
}

// --- Eviction and cleanup ---

async function unsyncedCachePaths(): Promise<Set<string>> {
  const rows = await database
    .get<Attachment>("attachments")
    .query(Q.where("upload_status", Q.oneOf(UNSYNCED_STATUSES)))
    .fetch();
  return new Set(rows.map((row) => attachmentCacheRelativePath(row.filePath)));
}

/**
 * Delete `relativePaths` from the cache, skipping any file held now, and
 * stopping if the cache was wiped meanwhile. A file that can't be deleted
 * stays in the index (and its bytes in the total), so a later pass retries it.
 */
function deleteAll(relativePaths: readonly string[], startedIn: number): void {
  for (const relativePath of relativePaths) {
    if (generation !== startedIn) return;
    if (held.has(relativePath)) continue;
    if (safeDelete(fileAt(relativePath))) noteRemoved(relativePath);
  }
}

/** Delete what downloads an app exit cut short, keeping every running download's file. */
function removeLeftoverPartials(): void {
  const dir = new Directory(getAttachmentCacheDir(), PARTIAL_DIR_NAME);
  if (!dir.exists) return;
  for (const item of dir.list()) {
    if (!activePartials.has(item.name)) safeDelete(item);
  }
}

async function evict(maxBytes: number): Promise<void> {
  const startedIn = generation;
  const current = loadedIndex();
  // The running total makes the common case (the cache fits) free.
  if (current.totalBytes <= maxBytes) return;
  // Take the files and the held set before reading the rows: a file saved
  // after this isn't in `entries`, and one whose row is written meanwhile is
  // either still held now or its row is in the query.
  const eligible = new Set(current.entries().map((entry) => entry.relativePath));
  const protectedPaths = new Set(held.keys());
  for (const relativePath of await unsyncedCachePaths()) protectedPaths.add(relativePath);
  // Rank those files by their last use as it is now, so one opened while the
  // rows were read isn't evicted as if it were still the oldest.
  const entries = current.entries().filter((entry) => eligible.has(entry.relativePath));
  deleteAll(planAttachmentCacheEviction(entries, maxBytes, protectedPaths), startedIn);
}

/**
 * Delete the least recently used cached files until the cache fits in
 * `maxBytes`. A file whose attachment hasn't reached the server, or whose
 * row is still being written, is never deleted. One eviction runs at a time:
 * a call made while one runs joins it, and it then runs once more, so a file
 * written after its snapshot is counted. Never throws.
 */
export function evictAttachmentCache(maxBytes: number = ATTACHMENT_CACHE_MAX_BYTES): Promise<void> {
  if (evictionInFlight) {
    evictAgain = true;
    return evictionInFlight;
  }
  evictionInFlight = (async () => {
    do {
      evictAgain = false;
      await evict(maxBytes);
    } while (evictAgain);
  })()
    .catch((error: unknown) => {
      console.warn("Attachment cache eviction failed:", error);
    })
    .finally(() => {
      evictionInFlight = null;
    });
  return evictionInFlight;
}

/**
 * The cached files to keep: images of attachments whose note still exists
 * (in the trash too, since it can be restored), and every file whose upload
 * hasn't finished.
 */
async function liveCachePaths(): Promise<Set<string>> {
  const [attachments, noteIds] = await Promise.all([
    database.get<Attachment>("attachments").query().fetch(),
    database.get<Note>("notes").query().fetchIds(),
  ]);
  const liveNotes = new Set(noteIds);
  const keep = new Set<string>();
  for (const attachment of attachments) {
    if (
      UNSYNCED_STATUSES.includes(attachment.uploadStatus) ||
      (liveNotes.has(attachment.noteId) && isCacheableAttachment(attachment.mimeType))
    ) {
      keep.add(attachmentCacheRelativePath(attachment.filePath));
    }
  }
  return keep;
}

/**
 * Delete cached files nobody needs any more: those whose attachment row is
 * gone, whose note was deleted permanently on this device (sync does not pull
 * permanent deletions made elsewhere), or that aren't images. Notes in the
 * trash keep theirs. Also clears the leftovers of downloads an app exit cut
 * short. Run after a sync, so the rows are complete. Never throws.
 */
export async function removeOrphanedCacheFiles(): Promise<void> {
  try {
    const startedIn = generation;
    const entries = loadedIndex().entries();
    const keep = new Set(held.keys());
    for (const relativePath of await liveCachePaths()) keep.add(relativePath);
    const orphans = entries
      .map((entry) => entry.relativePath)
      .filter((relativePath) => !keep.has(relativePath));
    deleteAll(orphans, startedIn);
    if (generation === startedIn) removeLeftoverPartials();
  } catch (error) {
    console.warn("Attachment cache cleanup failed:", error);
  }
}

/**
 * Delete the whole cache. Used on sign-out and by the cross-account identity
 * guard, so one account's images never show for the next. Best-effort: a
 * failure is logged, never thrown, so it can't block sign-out.
 */
export function deleteAttachmentCache(): void {
  generation += 1;
  if (indexSaveTimer) clearTimeout(indexSaveTimer);
  indexSaveTimer = null;
  index.clear();
  downloadsInFlight.clear();
  held.clear();
  // The backup flag goes with the folder: the next folder is flagged again.
  forgetAttachmentCacheRoot();
  try {
    const dir = getAttachmentCacheDir();
    if (dir.exists) dir.delete();
  } catch (error) {
    console.warn("Failed to delete the attachment cache:", error);
  }
}
