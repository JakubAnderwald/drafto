import { Directory, File, Paths } from "expo-file-system";
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
// the editor WebView is given read access to. Mirrors
// apps/desktop/src/lib/data/attachment-cache.ts (react-native-fs there).

/** Cap on the cache. Files whose upload hasn't finished don't count against eviction. */
export const ATTACHMENT_CACHE_MAX_BYTES = 300 * 1024 * 1024;

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

export function getAttachmentCacheDir(): Directory {
  return new Directory(Paths.document, ATTACHMENT_CACHE_DIR_NAME);
}

/** Where the cached copy of the attachment stored at `filePath` lives (it may not exist). */
export function cacheFileFor(filePath: string): File {
  return new File(getAttachmentCacheDir(), ...attachmentCacheRelativePath(filePath).split("/"));
}

/** `cacheFileFor(filePath)`, with its folders created so a file can be written there. */
export function prepareCacheFile(filePath: string): File {
  const file = cacheFileFor(filePath);
  file.parentDirectory.create({ intermediates: true, idempotent: true });
  return file;
}

function markUsed(filePath: string): void {
  lastUsed.set(attachmentCacheRelativePath(filePath), Date.now());
}

/** The cached copy's `file://` URI, or null when there is none (or it is empty). */
export function getCachedAttachmentUri(filePath: string): string | null {
  try {
    const file = cacheFileFor(filePath);
    if (!file.exists || file.size === 0) return null;
    markUsed(filePath);
    return file.uri;
  } catch {
    return null;
  }
}

function safeDelete(item: File | Directory): void {
  try {
    if (item.exists) item.delete();
  } catch {
    // Best-effort: a leftover file is evicted or wiped later.
  }
}

async function download(filePath: string, url: string, startedIn: number): Promise<string | null> {
  const destination = cacheFileFor(filePath);
  if (destination.exists && destination.size > 0) return destination.uri;

  const partialDir = new Directory(getAttachmentCacheDir(), PARTIAL_DIR_NAME);
  partialDir.create({ intermediates: true, idempotent: true });
  const partialName = `${generateId()}.part`;
  const partial = new File(partialDir, partialName);
  try {
    await File.downloadFileAsync(url, partial, { idempotent: true });
    if (generation !== startedIn) return null;
    if (!partial.exists || partial.size === 0) throw new Error("Downloaded file is empty");
    const target = prepareCacheFile(filePath);
    safeDelete(target);
    partial.move(target);
    markUsed(filePath);
    return cacheFileFor(filePath).uri;
  } finally {
    // `partial` now names the moved file, so address the leftover by name.
    safeDelete(new File(partialDir, partialName));
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
export function retainInCache(localUri: string, filePath: string): void {
  const target = cacheFileFor(filePath);
  if (target.uri === localUri) {
    markUsed(filePath);
    return;
  }
  const source = new File(localUri);
  try {
    if (!source.exists) return;
    const destination = prepareCacheFile(filePath);
    safeDelete(destination);
    source.move(destination);
    markUsed(filePath);
  } catch {
    safeDelete(source);
  }
}

function listEntries(dir: Directory, prefix: string, out: AttachmentCacheEntry[]): void {
  for (const item of dir.list()) {
    const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
    if (item instanceof Directory) {
      if (!prefix && item.name === PARTIAL_DIR_NAME) continue;
      listEntries(item, relativePath, out);
    } else {
      const written = item.modificationTime ?? 0;
      out.push({
        relativePath,
        size: item.size,
        lastUsedAt: Math.max(written, lastUsed.get(relativePath) ?? 0),
      });
    }
  }
}

/** Every file in the cache (downloads in progress excluded). */
export function listAttachmentCache(): AttachmentCacheEntry[] {
  const dir = getAttachmentCacheDir();
  if (!dir.exists) return [];
  const entries: AttachmentCacheEntry[] = [];
  try {
    listEntries(dir, "", entries);
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
  const entries = listAttachmentCache();
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxBytes) return;
  const protectedPaths = await unsyncedCachePaths();
  const dir = getAttachmentCacheDir();
  for (const relativePath of planAttachmentCacheEviction(entries, maxBytes, protectedPaths)) {
    safeDelete(new File(dir, ...relativePath.split("/")));
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
export function deleteAttachmentCache(): void {
  generation += 1;
  lastUsed.clear();
  downloadsInFlight.clear();
  try {
    const dir = getAttachmentCacheDir();
    if (dir.exists) dir.delete();
  } catch (error) {
    console.warn("Failed to delete the attachment cache:", error);
  }
}
