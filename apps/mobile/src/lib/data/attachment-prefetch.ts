import { Q } from "@nozbe/watermelondb";

import {
  ATTACHMENT_PREFETCH_MAX_BYTES,
  ATTACHMENT_PREFETCH_MAX_FILES,
  ATTACHMENT_PREFETCH_MAX_FILE_BYTES,
  createAttachmentPrefetcher,
} from "@drafto/shared";
import type { PrefetchOptions, PrefetchResult } from "@drafto/shared";

import { database, Attachment } from "@/db";
import {
  ATTACHMENT_CACHE_MAX_BYTES,
  downloadToCache,
  evictAttachmentCache,
  getAttachmentCacheState,
} from "@/lib/data/attachment-cache";
import { getCachedSignedUrl } from "@/lib/data/signed-url-cache";

// Downloads image attachments ahead of time, so a note synced from another
// device shows its images offline too (ADR-0086). The pass itself is shared
// (createAttachmentPrefetcher); this wires it to mobile's database, signed
// URLs and cache. Mirrors apps/desktop/src/lib/data/attachment-prefetch.ts.

export { PREFETCH_MIN_INTERVAL_MS } from "@drafto/shared";
export type { PrefetchOptions, PrefetchResult } from "@drafto/shared";

const prefetcher = createAttachmentPrefetcher({
  listCandidates: async () => {
    const rows = await database
      .get<Attachment>("attachments")
      .query(
        Q.where("upload_status", "uploaded"),
        Q.where("mime_type", Q.like("image/%")),
        Q.on("notes", "is_trashed", false),
        Q.sortBy("created_at", Q.desc),
      )
      .fetch();
    return rows.map((row) => ({ filePath: row.filePath, fileSize: row.fileSize }));
  },
  cacheState: async () => getAttachmentCacheState(),
  maxCacheBytes: ATTACHMENT_CACHE_MAX_BYTES,
  limits: {
    maxFiles: ATTACHMENT_PREFETCH_MAX_FILES,
    maxBytes: ATTACHMENT_PREFETCH_MAX_BYTES,
    maxFileBytes: ATTACHMENT_PREFETCH_MAX_FILE_BYTES,
  },
  getSignedUrl: getCachedSignedUrl,
  download: downloadToCache,
  evict: () => evictAttachmentCache(),
});

/**
 * Download up to 25 not-yet-cached image attachments (100 MB in all) of notes
 * not in the trash, newest first. Runs after each successful sync, on any
 * network. Images over 20 MB are left until they are viewed, and a pass never
 * fills the cache past its cap. One pass runs at a time, and one that found
 * nothing to do isn't repeated for a minute. Never throws.
 */
export function prefetchAttachmentImages(options: PrefetchOptions = {}): Promise<PrefetchResult> {
  return prefetcher.prefetch(options);
}

/** Forget the idle-pass throttle and drop the running pass (sign-out, tests). */
export function resetAttachmentPrefetch(): void {
  prefetcher.reset();
}
