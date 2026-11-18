import { Q } from "@nozbe/watermelondb";

import {
  ATTACHMENT_PREFETCH_MAX_BYTES,
  ATTACHMENT_PREFETCH_MAX_FILES,
  ATTACHMENT_PREFETCH_MAX_FILE_BYTES,
  attachmentCacheRelativePath,
  selectPrefetchCandidates,
} from "@drafto/shared";

import { database, Attachment } from "@/db";
import {
  ATTACHMENT_CACHE_MAX_BYTES,
  downloadToCache,
  evictAttachmentCache,
  listAttachmentCache,
} from "@/lib/data/attachment-cache";
import { getSignedUrl } from "@/lib/data/attachments";

// Downloads image attachments ahead of time, so a note synced from another
// device shows its images offline too (ADR-0086). Mirrors
// apps/mobile/src/lib/data/attachment-prefetch.ts.

/** A pass that ran this recently, and downloaded nothing, is not repeated. */
export const PREFETCH_MIN_INTERVAL_MS = 60_000;

export interface PrefetchOptions {
  /** Checked before each download: true stops the pass (the session ended). */
  isCancelled?: () => boolean;
}

export interface PrefetchResult {
  downloaded: number;
}

let running: Promise<PrefetchResult> | null = null;
let lastIdlePassAt = 0;

async function runPass(isCancelled: () => boolean): Promise<PrefetchResult> {
  const rows = await database
    .get<Attachment>("attachments")
    .query(
      Q.where("upload_status", "uploaded"),
      Q.where("mime_type", Q.like("image/%")),
      Q.on("notes", "is_trashed", false),
      Q.sortBy("created_at", Q.desc),
    )
    .fetch();
  if (rows.length === 0) return { downloaded: 0 };

  const entries = await listAttachmentCache();
  const cached = new Set(entries.map((entry) => entry.relativePath));
  const cacheBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const candidates = selectPrefetchCandidates(
    rows.map((row) => ({ filePath: row.filePath, fileSize: row.fileSize })),
    (filePath) => cached.has(attachmentCacheRelativePath(filePath)),
    {
      maxFiles: ATTACHMENT_PREFETCH_MAX_FILES,
      maxBytes: ATTACHMENT_PREFETCH_MAX_BYTES,
      maxFileBytes: ATTACHMENT_PREFETCH_MAX_FILE_BYTES,
      availableBytes: ATTACHMENT_CACHE_MAX_BYTES - cacheBytes,
    },
  );

  let downloaded = 0;
  for (const candidate of candidates) {
    if (isCancelled()) break;
    try {
      const signedUrl = await getSignedUrl(candidate.filePath);
      if (isCancelled()) break;
      if (await downloadToCache(candidate.filePath, signedUrl)) downloaded += 1;
    } catch (error) {
      // Most likely the network went away: the next pass picks up from here.
      console.warn("Attachment prefetch stopped:", error);
      break;
    }
  }
  if (downloaded > 0) await evictAttachmentCache();
  return { downloaded };
}

/**
 * Download up to 25 not-yet-cached image attachments (100 MB in all) of notes
 * not in the trash, newest first. Runs after each successful sync, on any
 * network. Images over 20 MB are left until they are viewed, and a pass never
 * fills the cache past its cap. One pass runs at a time, and one that found
 * nothing to do isn't repeated for a minute. Never throws.
 */
export function prefetchAttachmentImages(options: PrefetchOptions = {}): Promise<PrefetchResult> {
  if (running) return running;
  if (Date.now() - lastIdlePassAt < PREFETCH_MIN_INTERVAL_MS) {
    return Promise.resolve({ downloaded: 0 });
  }
  const isCancelled = options.isCancelled ?? (() => false);
  running = runPass(isCancelled)
    .catch((error: unknown) => {
      console.warn("Attachment prefetch failed:", error);
      return { downloaded: 0 };
    })
    .then((result) => {
      lastIdlePassAt = result.downloaded === 0 ? Date.now() : 0;
      return result;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** Forget the idle-pass throttle (sign-out, tests). */
export function resetAttachmentPrefetch(): void {
  lastIdlePassAt = 0;
}
