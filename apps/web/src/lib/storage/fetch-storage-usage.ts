import type { StorageUsage } from "@drafto/shared";

/**
 * Browser-side read of the signed-in user's attachment usage (issue #794), for the
 * settings page. The mobile and desktop apps have their own `fetchStorageUsage`,
 * which calls the `get_my_storage_usage` RPC directly.
 */

export const STORAGE_USAGE_URL = "/api/storage-usage";

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

/** The user's usage from `GET /api/storage-usage`, or null when it can't be read. */
export async function fetchStorageUsage(): Promise<StorageUsage | null> {
  try {
    const res = await fetch(STORAGE_USAGE_URL);
    if (!res.ok) return null;
    return parseStorageUsage(await res.json());
  } catch {
    // Offline or a body that isn't JSON: the caller shows usage as unavailable.
    return null;
  }
}
