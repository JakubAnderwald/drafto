// Pure policy for the native apps' offline attachment cache (ADR-0086): which
// cached files to evict, and which images a prefetch pass downloads. The file
// handling itself is per app (expo-file-system on mobile, react-native-fs on
// desktop); keeping the decisions here keeps the two apps in step.

/**
 * Whether an attachment of this type is kept in the cache. Only images are:
 * they are shown inline, while other files are opened on demand, online
 * (opening one offline is out of scope).
 */
export function isCacheableAttachment(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/");
}

/** A file in the attachment cache. */
export interface AttachmentCacheEntry {
  /** Path relative to the cache directory (`attachmentCacheRelativePath`). */
  relativePath: string;
  size: number;
  /** When it was last written or shown, in ms since the epoch. */
  lastUsedAt: number;
}

/**
 * The cached files to delete so the cache fits in `maxBytes`, least recently
 * used first. Files in `protectedPaths` are never chosen: their attachment
 * hasn't reached the server (pending, failed or refused for the storage
 * quota), so the cached copy is the only one. When protected files alone are
 * over the cap, everything else goes and the protected files stay.
 */
export function planAttachmentCacheEviction(
  entries: readonly AttachmentCacheEntry[],
  maxBytes: number,
  protectedPaths: ReadonlySet<string>,
): string[] {
  let total = entries.reduce((sum, entry) => sum + Math.max(0, entry.size), 0);
  if (total <= maxBytes) return [];
  const evictable = entries
    .filter((entry) => !protectedPaths.has(entry.relativePath))
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const evicted: string[] = [];
  for (const entry of evictable) {
    if (total <= maxBytes) break;
    evicted.push(entry.relativePath);
    total -= Math.max(0, entry.size);
  }
  return evicted;
}

/** An image attachment a prefetch pass may download. */
export interface PrefetchCandidate {
  filePath: string;
  fileSize: number;
}

export interface PrefetchLimits {
  /** Most files one pass downloads. */
  maxFiles: number;
  /** Most bytes one pass downloads. */
  maxBytes: number;
  /** Bigger files are left for when they are viewed. */
  maxFileBytes: number;
  /** Free room in the cache: a pass never fills it past its cap. */
  availableBytes: number;
}

/**
 * The attachments one prefetch pass downloads, in the order given (callers
 * pass the newest first). Skips files already cached and files over
 * `maxFileBytes`, and stops at `maxFiles`. A file that would take the pass over
 * its byte budget is skipped, so a smaller one later can still fit. The budget
 * is the smaller of `maxBytes` and the free room in the cache, so prefetching
 * never evicts anything, and never refetches what an eviction removed.
 */
export function selectPrefetchCandidates(
  candidates: readonly PrefetchCandidate[],
  isCached: (filePath: string) => boolean,
  limits: PrefetchLimits,
): PrefetchCandidate[] {
  const budget = Math.min(limits.maxBytes, Math.max(0, limits.availableBytes));
  const chosen: PrefetchCandidate[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const candidate of candidates) {
    if (chosen.length >= limits.maxFiles) break;
    if (seen.has(candidate.filePath)) continue;
    seen.add(candidate.filePath);
    const size = Math.max(0, candidate.fileSize);
    if (size > limits.maxFileBytes) continue;
    if (bytes + size > budget) continue;
    if (isCached(candidate.filePath)) continue;
    chosen.push(candidate);
    bytes += size;
  }
  return chosen;
}
