import type { AttachmentCacheEntry } from "./attachment-cache-policy";

// The native apps' in-memory index of their offline attachment cache (ADR-0086):
// each file's size and when it was last used, plus the running total. It is
// filled by one walk of the cache directory and then kept up to date as files
// are written and deleted, so neither eviction nor prefetch has to walk the
// directory again. When each file was last used is also saved to a small JSON
// file in the cache, so the least-recently-used order survives a restart.

/** The index's file in the cache directory, beside the cached attachments. */
export const ATTACHMENT_CACHE_INDEX_FILE_NAME = ".index.json";

/** A file found by walking the cache directory. */
export interface AttachmentCacheFile {
  /** Path relative to the cache directory (`attachmentCacheRelativePath`). */
  relativePath: string;
  size: number;
  /** The file's modification time, in ms since the epoch (0 when unknown). */
  modifiedAt: number;
}

interface IndexedFile {
  size: number;
  lastUsedAt: number;
}

const INDEX_FORMAT_VERSION = 1;

/**
 * When each cached file was last used, from the index file's contents. Anything
 * unreadable (a missing or damaged file, another version) is an empty map.
 */
export function parseAttachmentCacheIndex(json: string | null | undefined): Map<string, number> {
  const lastUsed = new Map<string, number>();
  if (!json) return lastUsed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return lastUsed;
  }
  if (typeof parsed !== "object" || parsed === null) return lastUsed;
  const { v, lastUsed: saved } = parsed as { v?: unknown; lastUsed?: unknown };
  if (v !== INDEX_FORMAT_VERSION || typeof saved !== "object" || saved === null) return lastUsed;
  for (const [relativePath, at] of Object.entries(saved)) {
    if (typeof at === "number" && Number.isFinite(at)) lastUsed.set(relativePath, at);
  }
  return lastUsed;
}

export class AttachmentCacheIndex {
  private files = new Map<string, IndexedFile>();
  private total = 0;
  private ready = false;

  /** Whether `load` has run since the index was created or cleared. */
  get isLoaded(): boolean {
    return this.ready;
  }

  /** Bytes in the cache. */
  get totalBytes(): number {
    return this.total;
  }

  /**
   * Replace the index with the files a walk found. A file's last use is the
   * saved one, or else its modification time (a copied file can keep an old
   * one, which is why the saved time wins).
   */
  load(found: readonly AttachmentCacheFile[], savedLastUsed: ReadonlyMap<string, number>): void {
    this.files.clear();
    this.total = 0;
    for (const file of found) {
      this.set(
        file.relativePath,
        file.size,
        savedLastUsed.get(file.relativePath) ?? file.modifiedAt,
      );
    }
    this.ready = true;
  }

  /** A file was written (or replaced): it counts as used `now`. */
  record(relativePath: string, size: number, now: number): void {
    this.set(relativePath, size, now);
  }

  /** A file was shown: true when the index has it. */
  touch(relativePath: string, now: number): boolean {
    const file = this.files.get(relativePath);
    if (!file) return false;
    file.lastUsedAt = now;
    return true;
  }

  remove(relativePath: string): void {
    const file = this.files.get(relativePath);
    if (!file) return;
    this.total -= file.size;
    this.files.delete(relativePath);
  }

  has(relativePath: string): boolean {
    return this.files.has(relativePath);
  }

  /** Every indexed file, for eviction. */
  entries(): AttachmentCacheEntry[] {
    return [...this.files].map(([relativePath, file]) => ({ relativePath, ...file }));
  }

  /** Empty the index; the next `load` fills it again. */
  clear(): void {
    this.files.clear();
    this.total = 0;
    this.ready = false;
  }

  /** The index file's contents: when each file was last used. */
  serialize(): string {
    const lastUsed: Record<string, number> = {};
    for (const [relativePath, file] of this.files) lastUsed[relativePath] = file.lastUsedAt;
    return JSON.stringify({ v: INDEX_FORMAT_VERSION, lastUsed });
  }

  private set(relativePath: string, size: number, lastUsedAt: number): void {
    this.remove(relativePath);
    const bytes = Math.max(0, size);
    this.files.set(relativePath, { size: bytes, lastUsedAt });
    this.total += bytes;
  }
}
