import { storageUsageFromRow, withTimeout } from "@drafto/shared";
import type { StorageUsage } from "@drafto/shared";

import { supabase } from "@/lib/supabase";

/**
 * How long a usage read may take before it counts as unknown. Callers await it
 * before saving a picked file and before each queued upload, so a stalled request
 * (a flaky network, a stuck session refresh) must not hold them up.
 */
export const STORAGE_USAGE_TIMEOUT_MS = 5000;

/**
 * The signed-in user's attachment storage usage and quota (issue #794), from the
 * `get_my_storage_usage` RPC. Null when it can't be read (offline, signed out, an
 * older server, or no answer within `STORAGE_USAGE_TIMEOUT_MS`): callers then skip
 * their pre-check and leave the refusal to the database, which enforces the quota
 * either way.
 */
export function fetchStorageUsage(): Promise<StorageUsage | null> {
  return withTimeout(readStorageUsage(), STORAGE_USAGE_TIMEOUT_MS, null);
}

/** One RPC read. A rejection becomes null through `withTimeout`. */
async function readStorageUsage(): Promise<StorageUsage | null> {
  const { data, error } = await supabase.rpc("get_my_storage_usage");
  if (error) return null;
  return storageUsageFromRow(data);
}
