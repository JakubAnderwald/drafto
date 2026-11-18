import { toAttachmentUrl, toLocalAttachmentSrc } from "@drafto/shared";
import type { AttachmentRefKind } from "@drafto/shared";

import {
  downloadToCache,
  evictAttachmentCache,
  getCachedAttachmentUri,
} from "@/lib/data/attachment-cache";
import { getCachedSignedUrl } from "@/lib/data/signed-url-cache";

// Picks the src the editor shows for an attachment (ADR-0086). Mirrors
// apps/desktop/src/lib/data/attachment-resolver.ts.

/** Cache an image just viewed online; a failure only means it isn't cached yet. */
function cacheInBackground(filePath: string, signedUrl: string): void {
  downloadToCache(filePath, signedUrl)
    .then((uri) => (uri ? evictAttachmentCache() : undefined))
    .catch((error: unknown) => {
      console.warn("Failed to cache attachment for offline use:", error);
    });
}

/**
 * The src to show for the attachment stored at `filePath`, for
 * `resolveTipTapImageUrls`:
 * 1. an image in the cache: its local src (`file://…#drafto-attachment=…`),
 *    with no network call, so it shows offline;
 * 2. otherwise a signed URL, and an image starts downloading into the cache;
 * 3. otherwise (offline, no copy) it rejects, and the shared resolver leaves
 *    the `attachment://` src in place.
 * Links keep a signed URL: opening a non-image file offline is out of scope.
 */
export async function resolveAttachmentSrc(
  filePath: string,
  kind: AttachmentRefKind = "image",
): Promise<string> {
  if (kind === "image") {
    const cached = getCachedAttachmentUri(filePath);
    if (cached) return toLocalAttachmentSrc(cached, filePath);
  }
  const signedUrl = await getCachedSignedUrl(filePath);
  if (kind === "image") cacheInBackground(filePath, signedUrl);
  return signedUrl;
}

/**
 * The src for an image attachment just added to a note: its local copy (the
 * picked file, kept in the cache), so it shows at once, online or not. Falls
 * back to `attachment://`, which the next load resolves.
 */
export function localAttachmentSrcFor(attachment: {
  filePath: string;
  localUri: string | null;
}): string {
  const uri = attachment.localUri ?? getCachedAttachmentUri(attachment.filePath);
  return uri
    ? toLocalAttachmentSrc(uri, attachment.filePath)
    : toAttachmentUrl(attachment.filePath);
}
