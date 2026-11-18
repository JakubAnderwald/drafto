import { ATTACHMENT_URL_PREFIX, LOCAL_ATTACHMENT_FRAGMENT } from "../constants";
import { toStorageSafeFileName } from "../storage/storage-key";

export function toAttachmentUrl(filePath: string): string {
  return `${ATTACHMENT_URL_PREFIX}${filePath}`;
}

export function isAttachmentUrl(url: string): boolean {
  return url.startsWith(ATTACHMENT_URL_PREFIX);
}

export function extractFilePath(url: string): string {
  return url.slice(ATTACHMENT_URL_PREFIX.length);
}

/**
 * Pattern to detect Supabase signed storage URLs.
 * Matches URLs containing `/storage/v1/object/sign/attachments/`
 * and extracts the file path after the bucket name.
 */
const SIGNED_URL_PATTERN = /\/storage\/v1\/object\/sign\/attachments\/([^?]+)/;

export function isSignedStorageUrl(url: string): boolean {
  return SIGNED_URL_PATTERN.test(url);
}

export function extractFilePathFromSignedUrl(url: string): string | null {
  const match = url.match(SIGNED_URL_PATTERN);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

// --- Device-local srcs for cached attachments (ADR-0086) ---

/**
 * The src the native editors give a cached attachment: the cached file's
 * `file://` URI plus `#drafto-attachment=<URL-encoded storage path>`. The
 * fragment does not change which file the WebView loads; it lets the save path
 * map the src back to `attachment://<path>` (see `migrateSignedUrlsToAttachmentUrls`),
 * so a device path is never stored. Any fragment `fileUri` already has is dropped.
 */
export function toLocalAttachmentSrc(fileUri: string, filePath: string): string {
  const hashIndex = fileUri.indexOf("#");
  const base = hashIndex === -1 ? fileUri : fileUri.slice(0, hashIndex);
  return `${base}${LOCAL_ATTACHMENT_FRAGMENT}${encodeURIComponent(filePath)}`;
}

/**
 * The storage path a local attachment src carries, or null when `url` is not
 * one: not a `file:` URL, no marker, an empty path, or a path that is not valid
 * URI encoding.
 */
export function extractFilePathFromLocalSrc(url: string): string | null {
  if (!url.startsWith("file:")) return null;
  const markerIndex = url.indexOf(LOCAL_ATTACHMENT_FRAGMENT);
  if (markerIndex === -1) return null;
  const encoded = url.slice(markerIndex + LOCAL_ATTACHMENT_FRAGMENT.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/** True when `url` is a local attachment src made by `toLocalAttachmentSrc`. */
export function isLocalAttachmentSrc(url: string): boolean {
  return extractFilePathFromLocalSrc(url) !== null;
}

/**
 * Where an attachment's cached copy lives, relative to the cache directory:
 * its storage path with each segment made filesystem-safe, so older keys with
 * characters a filesystem dislikes still map to a valid file. Empty segments
 * are dropped, and `.` / `..` can never escape the cache directory.
 */
export function attachmentCacheRelativePath(filePath: string): string {
  const segments = filePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const safe = toStorageSafeFileName(segment);
      return safe === "" || safe === "." || safe === ".." ? "_" : safe;
    });
  return segments.length > 0 ? segments.join("/") : "_";
}
