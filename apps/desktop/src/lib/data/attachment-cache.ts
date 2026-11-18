import RNFS from "react-native-fs";
import { Q } from "@nozbe/watermelondb";

import {
  ATTACHMENT_CACHE_DIR_NAME,
  attachmentCacheRelativePath,
  planAttachmentCacheEviction,
} from "@drafto/shared";
import type { AttachmentCacheEntry } from "@drafto/shared";

import { database, Attachment } from "@/db";
import { generateId } from "@/lib/generate-id";

// The device's copy of each attachment, so images show offline (ADR-0086).
// Files live under <Documents>/attachment-cache/<storage path>, the directory
// the editor WebView is given read access to. In the sandboxed app that is
// the container's Documents directory. Mirrors
// apps/mobile/src/lib/data/attachment-cache.ts (expo-file-system there).

/** Cap on the cache. Files whose upload hasn't finished don't count against eviction. */
export const ATTACHMENT_CACHE_MAX_BYTES = 1024 * 1024 * 1024;

/** Downloads land here first and are moved into place once complete. */
const PARTIAL_DIR_NAME = ".partial";

/** Upload states whose cached file is the only copy: never evicted. */
const UNSYNCED_STATUSES = ["pending", "failed", "quota_exceeded"];

// Bumped by deleteAttachmentCache (sign-out), so a download still running for
// the previous account is thrown away instead of landing in the new cache.
let generation = 0;
// When each cached file was last shown this session, by relative path. With
// the file's write time it orders eviction (least recently used first).
const lastUsed = new Map<string, number>();
// One download per attachment at a time.
const downloadsInFlight = new Map<string, Promise<string | null>>();
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

/** Create the cache directory (left out of Time Machine / iCloud backups) and `dir`. */
async function ensureDir(dir: string): Promise<void> {
  const root = getAttachmentCacheDir();
  if (!(await RNFS.exists(root))) {
    await RNFS.mkdir(root, { NSURLIsExcludedFromBackupKey: true });
  }
  if (dir !== root && !(await RNFS.exists(dir))) await RNFS.mkdir(dir);
}

/** `cacheFileFor(filePath)`, with its folders created so a file can be written there. */
export async function prepareCacheFile(filePath: string): Promise<string> {
  const path = cacheFileFor(filePath);
  await ensureDir(parentOf(path));
  return path;
}

function markUsed(filePath: string): void {
  lastUsed.set(attachmentCacheRelativePath(filePath), Date.now());
}

async function hasContent(path: string): Promise<boolean> {
  if (!(await RNFS.exists(path))) return false;
  const { size } = await RNFS.stat(path);
  return Number(size) > 0;
}

/** The cached copy's `file://` URI, or null when there is none (or it is empty). */
export async function getCachedAttachmentUri(filePath: string): Promise<string | null> {
  try {
    const path = cacheFileFor(filePath);
    if (!(await hasContent(path))) return null;
    markUsed(filePath);
    return toFileUri(path);
  } catch {
    return null;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    if (await RNFS.exists(path)) await RNFS.unlink(path);
  } catch {
    // Best-effort: a leftover file is evicted or wiped later.
  }
}

async function download(filePath: string, url: string, startedIn: number): Promise<string | null> {
  const destination = cacheFileFor(filePath);
  if (await hasContent(destination)) return toFileUri(destination);

  const partialDir = `${getAttachmentCacheDir()}/${PARTIAL_DIR_NAME}`;
  await ensureDir(partialDir);
  const partial = `${partialDir}/${generateId()}.part`;
  try {
    const { statusCode } = await RNFS.downloadFile({ fromUrl: url, toFile: partial }).promise;
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Download failed with status ${statusCode}`);
    }
    if (generation !== startedIn) return null;
    if (!(await hasContent(partial))) throw new Error("Downloaded file is empty");
    const target = await prepareCacheFile(filePath);
    await safeUnlink(target);
    await RNFS.moveFile(partial, target);
    markUsed(filePath);
    return toFileUri(target);
  } finally {
    await safeUnlink(partial);
  }
}

/**
 * Download the attachment at `url` into the cache, unless it is already there.
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
 * Keep an uploaded attachment's local file as its cached copy. A file picked
 * before the cache existed lives in the old attachments folder: it is moved
 * into the cache. If the move fails the file is deleted, as before.
 */
export async function retainInCache(localUri: string, filePath: string): Promise<void> {
  const target = cacheFileFor(filePath);
  const source = toPath(localUri);
  if (source === target) {
    markUsed(filePath);
    return;
  }
  try {
    if (!(await RNFS.exists(source))) return;
    const destination = await prepareCacheFile(filePath);
    await safeUnlink(destination);
    await RNFS.moveFile(source, destination);
    markUsed(filePath);
  } catch {
    await safeUnlink(source);
  }
}

async function listEntries(dir: string, prefix: string, out: AttachmentCacheEntry[]) {
  for (const item of await RNFS.readDir(dir)) {
    const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      if (!prefix && item.name === PARTIAL_DIR_NAME) continue;
      await listEntries(item.path, relativePath, out);
    } else {
      const written = item.mtime ? item.mtime.getTime() : 0;
      out.push({
        relativePath,
        size: Number(item.size),
        lastUsedAt: Math.max(written, lastUsed.get(relativePath) ?? 0),
      });
    }
  }
}

/** Every file in the cache (downloads in progress excluded). */
export async function listAttachmentCache(): Promise<AttachmentCacheEntry[]> {
  const dir = getAttachmentCacheDir();
  const entries: AttachmentCacheEntry[] = [];
  try {
    if (!(await RNFS.exists(dir))) return [];
    await listEntries(dir, "", entries);
  } catch (error) {
    console.warn("Failed to list the attachment cache:", error);
  }
  return entries;
}

async function unsyncedCachePaths(): Promise<Set<string>> {
  const rows = await database
    .get<Attachment>("attachments")
    .query(Q.where("upload_status", Q.oneOf(UNSYNCED_STATUSES)))
    .fetch();
  return new Set(rows.map((row) => attachmentCacheRelativePath(row.filePath)));
}

async function evict(maxBytes: number): Promise<void> {
  const entries = await listAttachmentCache();
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxBytes) return;
  const protectedPaths = await unsyncedCachePaths();
  const dir = getAttachmentCacheDir();
  for (const relativePath of planAttachmentCacheEviction(entries, maxBytes, protectedPaths)) {
    await safeUnlink(`${dir}/${relativePath}`);
    lastUsed.delete(relativePath);
  }
}

/**
 * Delete the least recently used cached files until the cache fits in
 * `maxBytes`. A file whose attachment hasn't reached the server is never
 * deleted. One eviction runs at a time; never throws.
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
 * Delete the whole cache. Used on sign-out and by the cross-account identity
 * guard, so one account's images never show for the next. Best-effort: a
 * failure is logged, never thrown, so it can't block sign-out.
 */
export async function deleteAttachmentCache(): Promise<void> {
  generation += 1;
  lastUsed.clear();
  downloadsInFlight.clear();
  try {
    const dir = getAttachmentCacheDir();
    if (await RNFS.exists(dir)) await RNFS.unlink(dir);
  } catch (error) {
    console.warn("Failed to delete the attachment cache:", error);
  }
}
