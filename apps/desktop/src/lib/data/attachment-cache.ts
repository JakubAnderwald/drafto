import RNFS from "react-native-fs";
import { Q } from "@nozbe/watermelondb";

import {
  ATTACHMENT_CACHE_DIR_NAME,
  ATTACHMENT_CACHE_INDEX_FILE_NAME,
  AttachmentCacheIndex,
  attachmentCacheRelativePath,
  isCacheableAttachment,
  parseAttachmentCacheIndex,
  planAttachmentCacheEviction,
} from "@drafto/shared";
import type { AttachmentCacheEntry, AttachmentCacheFile } from "@drafto/shared";

import { database, Attachment, Note } from "@/db";
import { generateId } from "@/lib/generate-id";

// The device's copy of each image attachment, so images show offline
// (ADR-0086). Files live under <Documents>/attachment-cache/<storage path>,
// the directory the editor WebView is given read access to. In the sandboxed
// app that is the container's Documents directory. Mirrors
// apps/mobile/src/lib/data/attachment-cache.ts (expo-file-system there).

/** Cap on the cache. Files whose upload hasn't finished don't count against eviction. */
export const ATTACHMENT_CACHE_MAX_BYTES = 1024 * 1024 * 1024;

/** Downloads land here first and are moved into place once complete. */
const PARTIAL_DIR_NAME = ".partial";

/** How long the index waits for more changes before it is saved. */
const INDEX_SAVE_DELAY_MS = 2_000;

/** Upload states whose cached file is the only copy: never evicted. */
const UNSYNCED_STATUSES = ["pending", "failed", "quota_exceeded"];

/**
 * Thrown when the cache was wiped (sign-out) while a write into it was
 * running: the write stops instead of landing in the next account's cache.
 */
export class AttachmentCacheWipedError extends Error {
  constructor() {
    super("The attachment cache was wiped while a file was being written to it");
    this.name = "AttachmentCacheWipedError";
  }
}

// Bumped by deleteAttachmentCache (sign-out). Every file-system change made
// after an await first checks it is still the generation the work started
// in, so work still running for the previous account never lands in (or
// recreates) the new cache. RNFS runs its calls in order, so a change
// started before the wipe also finishes before the wipe's delete.
let generation = 0;
// Each cached file's size and last use, and the running total (see
// AttachmentCacheIndex). Filled by one walk of the directory on first use.
const index = new AttachmentCacheIndex();
let indexLoading: Promise<AttachmentCacheIndex> | null = null;
let indexSaveTimer: ReturnType<typeof setTimeout> | null = null;
// One download per attachment at a time.
const downloadsInFlight = new Map<string, Promise<string | null>>();
// Files written for an attachment whose row isn't in the database yet, by
// relative path: neither eviction nor the orphan cleanup may delete them.
const held = new Map<string, number>();
let evictionInFlight: Promise<void> | null = null;

export function getAttachmentCacheDir(): string {
  return `${RNFS.DocumentDirectoryPath}/${ATTACHMENT_CACHE_DIR_NAME}`;
}

/** Where the cached copy of the attachment stored at `filePath` lives (it may not exist). */
export function cacheFileFor(filePath: string): string {
  return `${getAttachmentCacheDir()}/${attachmentCacheRelativePath(filePath)}`;
}

/** A local path as the `file://` URI the attachment rows and the editor use. */
function toFileUri(path: string): string {
  return `file://${path}`;
}

function toPath(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/** Throw unless the cache is still the one the work started in. */
function assertGeneration(startedIn: number): void {
  if (generation !== startedIn) throw new AttachmentCacheWipedError();
}

/**
 * Create the cache directory (left out of Time Machine / iCloud backups) and
 * `dir`, for work started in generation `startedIn`. Throws
 * AttachmentCacheWipedError, creating nothing, once the cache was wiped.
 */
async function ensureDir(dir: string, startedIn: number): Promise<void> {
  const root = getAttachmentCacheDir();
  assertGeneration(startedIn);
  if (!(await RNFS.exists(root))) {
    assertGeneration(startedIn);
    await RNFS.mkdir(root, { NSURLIsExcludedFromBackupKey: true });
  }
  if (dir === root) return;
  assertGeneration(startedIn);
  if (!(await RNFS.exists(dir))) {
    assertGeneration(startedIn);
    await RNFS.mkdir(dir);
  }
}

/**
 * `cacheFileFor(filePath)`, with its folders created so a file can be
 * written there. Throws AttachmentCacheWipedError when the cache is wiped
 * meanwhile.
 */
export async function prepareCacheFile(
  filePath: string,
  startedIn: number = generation,
): Promise<string> {
  const path = cacheFileFor(filePath);
  await ensureDir(parentOf(path), startedIn);
  return path;
}

async function fileSize(path: string): Promise<number> {
  if (!(await RNFS.exists(path))) return 0;
  const { size } = await RNFS.stat(path);
  return Number(size);
}

async function hasContent(path: string): Promise<boolean> {
  return (await fileSize(path)) > 0;
}

async function safeUnlink(path: string): Promise<void> {
  try {
    if (await RNFS.exists(path)) await RNFS.unlink(path);
  } catch {
    // Best-effort: a leftover file is evicted or cleaned up later.
  }
}

/** `safeUnlink`, unless the cache was wiped since `startedIn` (it is gone then anyway). */
async function unlinkInGeneration(path: string, startedIn: number): Promise<void> {
  try {
    if (generation !== startedIn || !(await RNFS.exists(path))) return;
    if (generation !== startedIn) return;
    await RNFS.unlink(path);
  } catch {
    // Best-effort: a leftover file is evicted or cleaned up later.
  }
}

// --- The index ---

function isReservedName(name: string): boolean {
  return name === PARTIAL_DIR_NAME || name === ATTACHMENT_CACHE_INDEX_FILE_NAME;
}

async function walk(dir: string, prefix: string, out: AttachmentCacheFile[]): Promise<void> {
  for (const item of await RNFS.readDir(dir)) {
    if (!prefix && isReservedName(item.name)) continue;
    const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      await walk(item.path, relativePath, out);
    } else {
      out.push({
        relativePath,
        size: Number(item.size),
        modifiedAt: item.mtime ? item.mtime.getTime() : 0,
      });
    }
  }
}

function indexPath(): string {
  return `${getAttachmentCacheDir()}/${ATTACHMENT_CACHE_INDEX_FILE_NAME}`;
}

async function readIndex(): Promise<AttachmentCacheIndex> {
  const startedIn = generation;
  const found: AttachmentCacheFile[] = [];
  let saved = new Map<string, number>();
  try {
    const dir = getAttachmentCacheDir();
    if (await RNFS.exists(dir)) {
      await walk(dir, "", found);
      if (await RNFS.exists(indexPath())) {
        saved = parseAttachmentCacheIndex(await RNFS.readFile(indexPath(), "utf8"));
      }
    }
  } catch (error) {
    console.warn("Failed to read the attachment cache:", error);
  }
  // A wipe meanwhile leaves the index empty, as the new cache is.
  index.load(generation === startedIn ? found : [], generation === startedIn ? saved : new Map());
  return index;
}

/** The index, filled by one walk of the cache directory the first time it is needed. */
function loadedIndex(): Promise<AttachmentCacheIndex> {
  if (index.isLoaded) return Promise.resolve(index);
  if (!indexLoading) {
    indexLoading = readIndex().finally(() => {
      indexLoading = null;
    });
  }
  return indexLoading;
}

/** Save the index now. Never throws. */
export async function flushAttachmentCacheIndex(): Promise<void> {
  if (indexSaveTimer) clearTimeout(indexSaveTimer);
  indexSaveTimer = null;
  if (!index.isLoaded) return;
  const startedIn = generation;
  const contents = index.serialize();
  try {
    // Never create the cache directory just for the index.
    if (!(await RNFS.exists(getAttachmentCacheDir()))) return;
    if (generation !== startedIn) return;
    await RNFS.writeFile(indexPath(), contents, "utf8");
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
    if (generation === scheduledIn) void flushAttachmentCacheIndex();
  }, INDEX_SAVE_DELAY_MS);
}

/** The cached copy of `filePath`, `size` bytes, was just written in generation `startedIn`. */
async function noteWritten(filePath: string, size: number, startedIn: number): Promise<void> {
  const current = await loadedIndex();
  if (generation !== startedIn) return;
  current.record(attachmentCacheRelativePath(filePath), size, Date.now());
  saveIndexSoon();
}

function noteRemoved(relativePath: string): void {
  index.remove(relativePath);
  saveIndexSoon();
}

/** The cache as a prefetch pass sees it: what is cached and how full it is. */
export async function getAttachmentCacheState(): Promise<{
  totalBytes: number;
  isCached: (filePath: string) => boolean;
}> {
  const current = await loadedIndex();
  return {
    totalBytes: current.totalBytes,
    isCached: (filePath) => current.has(attachmentCacheRelativePath(filePath)),
  };
}

/** Every file in the cache (downloads in progress excluded). */
export async function listAttachmentCache(): Promise<AttachmentCacheEntry[]> {
  return (await loadedIndex()).entries();
}

// --- Reading and writing cached files ---

/** The cached copy's `file://` URI, or null when there is none (or it is empty). */
export async function getCachedAttachmentUri(filePath: string): Promise<string | null> {
  try {
    const startedIn = generation;
    const path = cacheFileFor(filePath);
    const relativePath = attachmentCacheRelativePath(filePath);
    const size = await fileSize(path);
    if (generation !== startedIn) return null;
    if (size === 0) {
      if (index.has(relativePath)) noteRemoved(relativePath);
      return null;
    }
    const current = await loadedIndex();
    if (generation !== startedIn) return null;
    if (!current.touch(relativePath, Date.now())) current.record(relativePath, size, Date.now());
    saveIndexSoon();
    return toFileUri(path);
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
 * Copy a picked image (at the POSIX path `sourcePath`) into the cache, at its
 * storage path, and return the copy's `file://` URI. Throws when the cache is
 * wiped meanwhile or the copy fails.
 */
export async function copyIntoCache(sourcePath: string, filePath: string): Promise<string> {
  const startedIn = generation;
  const destination = await prepareCacheFile(filePath, startedIn);
  assertGeneration(startedIn);
  await RNFS.copyFile(sourcePath, destination);
  await noteWritten(filePath, await fileSize(destination), startedIn);
  return toFileUri(destination);
}

async function download(filePath: string, url: string, startedIn: number): Promise<string | null> {
  const destination = cacheFileFor(filePath);
  if (await hasContent(destination)) return toFileUri(destination);

  const partialDir = `${getAttachmentCacheDir()}/${PARTIAL_DIR_NAME}`;
  const partial = `${partialDir}/${generateId()}.part`;
  try {
    await ensureDir(partialDir, startedIn);
    assertGeneration(startedIn);
    const { statusCode } = await RNFS.downloadFile({ fromUrl: url, toFile: partial }).promise;
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Download failed with status ${statusCode}`);
    }
    assertGeneration(startedIn);
    const size = await fileSize(partial);
    if (size === 0) throw new Error("Downloaded file is empty");
    const target = await prepareCacheFile(filePath, startedIn);
    await unlinkInGeneration(target, startedIn);
    assertGeneration(startedIn);
    await RNFS.moveFile(partial, target);
    await noteWritten(filePath, size, startedIn);
    assertGeneration(startedIn);
    return toFileUri(target);
  } catch (error) {
    // A wipe meanwhile can also surface as a file vanishing under a call.
    if (error instanceof AttachmentCacheWipedError || generation !== startedIn) return null;
    throw error;
  } finally {
    await unlinkInGeneration(partial, startedIn);
  }
}

/**
 * Download the image at `url` into the cache, unless it is already there.
 * The file is written beside the cache and moved into place once complete, so
 * a half-written file is never shown. Concurrent calls for one attachment share
 * a download. Resolves to the cached file's URI, or null when the cache was
 * wiped (sign-out) while it ran. Rejects when the download fails.
 */
export function downloadToCache(filePath: string, url: string): Promise<string | null> {
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
 * into the cache. If the move fails the file is deleted, as before. Does
 * nothing once the cache was wiped (sign-out) meanwhile.
 */
export async function retainInCache(localUri: string, filePath: string): Promise<void> {
  const startedIn = generation;
  const target = cacheFileFor(filePath);
  const source = toPath(localUri);
  if (source === target) {
    const size = await fileSize(target);
    if (size > 0) await noteWritten(filePath, size, startedIn);
    return;
  }
  try {
    if (!(await RNFS.exists(source))) return;
    const destination = await prepareCacheFile(filePath, startedIn);
    await unlinkInGeneration(destination, startedIn);
    assertGeneration(startedIn);
    await RNFS.moveFile(source, destination);
    await noteWritten(filePath, await fileSize(destination), startedIn);
  } catch (error) {
    if (error instanceof AttachmentCacheWipedError || generation !== startedIn) return;
    await safeUnlink(source);
  }
}

/** Delete the cached copy of the attachment stored at `filePath`, if there is one. */
export async function deleteFromCache(filePath: string): Promise<void> {
  await safeUnlink(cacheFileFor(filePath));
  noteRemoved(attachmentCacheRelativePath(filePath));
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
 * stopping if the cache was wiped meanwhile.
 */
async function deleteAll(relativePaths: readonly string[], startedIn: number): Promise<void> {
  const dir = getAttachmentCacheDir();
  for (const relativePath of relativePaths) {
    if (generation !== startedIn) return;
    if (held.has(relativePath)) continue;
    await unlinkInGeneration(`${dir}/${relativePath}`, startedIn);
    if (generation !== startedIn) return;
    noteRemoved(relativePath);
  }
}

async function evict(maxBytes: number): Promise<void> {
  const startedIn = generation;
  const current = await loadedIndex();
  // The running total makes the common case (the cache fits) free.
  if (generation !== startedIn || current.totalBytes <= maxBytes) return;
  // Take the files and the held set before reading the rows: a file saved
  // after this isn't in `entries`, and one whose row is written meanwhile is
  // either still held now or its row is in the query.
  const entries = current.entries();
  const protectedPaths = new Set(held.keys());
  for (const relativePath of await unsyncedCachePaths()) protectedPaths.add(relativePath);
  await deleteAll(planAttachmentCacheEviction(entries, maxBytes, protectedPaths), startedIn);
}

/**
 * Delete the least recently used cached files until the cache fits in
 * `maxBytes`. A file whose attachment hasn't reached the server, or whose
 * row is still being written, is never deleted. One eviction runs at a time;
 * never throws.
 */
export function evictAttachmentCache(maxBytes: number = ATTACHMENT_CACHE_MAX_BYTES): Promise<void> {
  if (evictionInFlight) return evictionInFlight;
  evictionInFlight = evict(maxBytes)
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
 * gone, whose note was deleted (permanently, here or synced from elsewhere),
 * or that aren't images. Notes in the trash keep theirs. Also clears the
 * leftovers of downloads an app exit cut short. Run after a sync, so the rows
 * are complete. Never throws.
 */
export async function removeOrphanedCacheFiles(): Promise<void> {
  try {
    const startedIn = generation;
    const entries = (await loadedIndex()).entries();
    const keep = new Set(held.keys());
    for (const relativePath of await liveCachePaths()) keep.add(relativePath);
    const orphans = entries
      .map((entry) => entry.relativePath)
      .filter((relativePath) => !keep.has(relativePath));
    await deleteAll(orphans, startedIn);
    if (downloadsInFlight.size === 0) {
      await unlinkInGeneration(`${getAttachmentCacheDir()}/${PARTIAL_DIR_NAME}`, startedIn);
    }
  } catch (error) {
    console.warn("Attachment cache cleanup failed:", error);
  }
}

/**
 * Delete the whole cache. Used on sign-out and by the cross-account identity
 * guard, so one account's images never show for the next. Best-effort: a
 * failure is logged, never thrown, so it can't block sign-out.
 */
export async function deleteAttachmentCache(): Promise<void> {
  generation += 1;
  if (indexSaveTimer) clearTimeout(indexSaveTimer);
  indexSaveTimer = null;
  index.clear();
  downloadsInFlight.clear();
  held.clear();
  try {
    const dir = getAttachmentCacheDir();
    if (await RNFS.exists(dir)) await RNFS.unlink(dir);
  } catch (error) {
    console.warn("Failed to delete the attachment cache:", error);
  }
}
