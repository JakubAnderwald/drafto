import {
  ATTACHMENT_URL_PREFIX,
  LOCAL_ATTACHMENT_FRAGMENT,
  MAX_FILE_NAME_LENGTH,
} from "../constants";
import { cyrb64Hex } from "../hash/cyrb64";
import { splitExtension, toStorageSafeFileName } from "../storage/storage-key";

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
 * The `attachment://` form of a URL the editors only show, or null when `url`
 * is not one: a Supabase signed URL (older content, or a session's display
 * src) or a device-local cached-file src (ADR-0086). A local src must never
 * be stored: it names a file on one device, so it would show as a broken
 * image everywhere else.
 */
export function canonicalAttachmentUrl(url: string): string | null {
  if (isSignedStorageUrl(url)) {
    const filePath = extractFilePathFromSignedUrl(url);
    return filePath ? toAttachmentUrl(filePath) : null;
  }
  const localPath = extractFilePathFromLocalSrc(url);
  return localPath ? toAttachmentUrl(localPath) : null;
}

/**
 * The unique part of a storage key made by `buildAttachmentStoragePath`:
 * `-<timestamp>-<8 hex>` before the extension. Digits, hex and dashes read the
 * same in every encoding of the URL.
 */
export const UNIQUE_KEY_SUFFIX = /-\d{10,}-[0-9a-f]{8}(?=(?:\.[^./]*)?$)/;

/**
 * Whether `text` is the name of the file stored at `filePath`: what a file
 * link's text is when the link stands for a file (the native editors insert
 * the attachment's name, and a web file block projects to the picked file's
 * name). The key's last segment is the storage-safe form of that name with the
 * unique upload suffix before the extension (older keys have none). The key
 * keeps only the extension's first 20 characters (see `splitExtension`), and
 * its base is cut short when the name is long. So the name matches when its
 * storage-safe form is the segment itself (the web's attachment rows are named
 * that), or when, split the way the key was built, its capped extension is the
 * key's extension and its base is the key's base, or, for a segment at the
 * length cap, starts with it.
 */
export function isAttachmentFileName(text: string, filePath: string): boolean {
  const segment = filePath.slice(filePath.lastIndexOf("/") + 1);
  if (!text || !segment) return false;
  const safe = toStorageSafeFileName(text);
  if (safe === segment) return true;
  const suffix = UNIQUE_KEY_SUFFIX.exec(segment);
  if (!suffix) return false;
  const base = segment.slice(0, suffix.index);
  const extension = segment.slice(suffix.index + suffix[0].length);
  const name = splitExtension(safe);
  if (name.extension !== extension) return false;
  if (name.base === base) return true;
  return segment.length >= MAX_FILE_NAME_LENGTH && name.base.startsWith(base);
}

/** Longest file or folder name APFS and ext4 accept, in bytes. */
const MAX_CACHE_SEGMENT_LENGTH = 255;

/** Longest extension kept when a cache name is shortened. */
const MAX_CACHE_EXTENSION_LENGTH = 20;

/**
 * Marks a cache name that was changed from its storage key segment. A name
 * kept as it is never contains it: `toStorageSafeFileName` never emits `~`.
 */
const CHANGED_SEGMENT_MARK = "~";

/**
 * Tells apart storage key segments that make the same safe name (see
 * `cyrb64Hex`).
 */
const segmentHash = cyrb64Hex;

/**
 * The cache name for one storage key segment. A segment that is already
 * storage-safe, lower case, at most 255 characters and doesn't start with a
 * dot is kept as it is (every segment of a key made since keys got a unique
 * suffix, apart from upper case). Any other segment gets its safe form plus
 * `~` and a hash of the original before the extension, so two segments that
 * make the same safe form (`café` / `cafe`, `photo#1` / `photo_1`, or
 * `Photo` / `photo` on a case-insensitive disk) still get different files,
 * and `.` / `..` can never climb out of the cache directory.
 */
function cacheSegment(segment: string): string {
  const safe = toStorageSafeFileName(segment);
  if (
    segment.length > 0 &&
    segment.length <= MAX_CACHE_SEGMENT_LENGTH &&
    !segment.startsWith(".") &&
    safe === segment &&
    segment === segment.toLowerCase()
  ) {
    return segment;
  }
  const tag = `${CHANGED_SEGMENT_MARK}${segmentHash(segment)}`;
  const dotIndex = safe.lastIndexOf(".");
  const hasExtension = dotIndex > 0 && safe.length - dotIndex <= MAX_CACHE_EXTENSION_LENGTH;
  const base = (hasExtension ? safe.slice(0, dotIndex) : safe).replace(/^\.+/, "") || "_";
  const extension = hasExtension ? safe.slice(dotIndex) : "";
  const room = MAX_CACHE_SEGMENT_LENGTH - tag.length - extension.length;
  return `${base.slice(0, room)}${tag}${extension}`;
}

/**
 * Where an attachment's cached copy lives, relative to the cache directory:
 * its storage path, with each segment mapped by `cacheSegment`. The mapping
 * is one-to-one, so two attachments never share a cached file, and every
 * name it makes is filesystem-safe and URL-safe.
 */
export function attachmentCacheRelativePath(filePath: string): string {
  return filePath.split("/").map(cacheSegment).join("/");
}
