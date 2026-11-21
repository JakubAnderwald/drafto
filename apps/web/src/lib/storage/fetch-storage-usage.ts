import type { StorageUsage } from "@drafto/shared";

/**
 * Browser-side reads of the signed-in user's attachment usage (issue #794) and note
 * content usage (ADR 0090), for the settings page. The mobile and desktop apps call
 * the `get_my_storage_usage` / `get_my_content_usage` RPCs directly.
 */

export const STORAGE_USAGE_URL = "/api/storage-usage";
export const CONTENT_USAGE_URL = "/api/content-usage";

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The `GET /api/storage-usage` body (`{ usedBytes, quotaBytes }`), or null when it isn't one. */
export function parseStorageUsage(body: unknown): StorageUsage | null {
  if (body === null || typeof body !== "object") return null;
  const { usedBytes, quotaBytes } = body as Record<string, unknown>;
  if (!isByteCount(usedBytes)) return null;
  if (quotaBytes === null) return { usedBytes, quotaBytes: null };
  if (!isByteCount(quotaBytes)) return null;
  return { usedBytes, quotaBytes };
}

async function fetchUsage(url: string): Promise<StorageUsage | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseStorageUsage(await res.json());
  } catch {
    // Offline or a body that isn't JSON: the caller shows usage as unavailable.
    return null;
  }
}

/** The user's usage from `GET /api/storage-usage`, or null when it can't be read. */
export function fetchStorageUsage(): Promise<StorageUsage | null> {
  return fetchUsage(STORAGE_USAGE_URL);
}

/** The user's note content usage from `GET /api/content-usage`, or null when it can't be read. */
export function fetchContentUsage(): Promise<StorageUsage | null> {
  return fetchUsage(CONTENT_USAGE_URL);
}
