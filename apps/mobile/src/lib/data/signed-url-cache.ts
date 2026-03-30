import { SIGNED_URL_EXPIRY_SECONDS } from "@drafto/shared";

import { getSignedUrl } from "@/lib/data/attachments";

interface CacheEntry {
  url: string;
  expiresAt: number;
}

// Use half the server-side TTL as the cache TTL to avoid serving URLs
// that are about to expire while still reducing redundant fetches.
const CACHE_TTL_MS = (SIGNED_URL_EXPIRY_SECONDS / 2) * 1000;

const cache = new Map<string, CacheEntry>();

export async function getCachedSignedUrl(filePath: string): Promise<string> {
  const entry = cache.get(filePath);
  if (entry) {
    if (entry.expiresAt > Date.now()) {
      return entry.url;
    }
    cache.delete(filePath);
  }

  const url = await getSignedUrl(filePath);
  cache.set(filePath, { url, expiresAt: Date.now() + CACHE_TTL_MS });
  return url;
}

export function invalidateCachedSignedUrl(filePath: string): void {
  cache.delete(filePath);
}

export function clearSignedUrlCache(): void {
  cache.clear();
}

export function hasValidCacheEntry(filePath: string): boolean {
  const entry = cache.get(filePath);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(filePath);
    return false;
  }
  return true;
}

export function getCachedSignedUrlSync(filePath: string): string | null {
  const entry = cache.get(filePath);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(filePath);
    return null;
  }
  return entry.url;
}
