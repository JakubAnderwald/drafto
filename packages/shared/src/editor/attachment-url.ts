import { ATTACHMENT_URL_PREFIX } from "../constants";

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
