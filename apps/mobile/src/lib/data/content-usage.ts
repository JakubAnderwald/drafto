import { storageUsageFromRow, withTimeout } from "@drafto/shared";
import type { StorageUsage } from "@drafto/shared";

import { STORAGE_USAGE_TIMEOUT_MS } from "@/lib/data/storage-usage";
import { supabase } from "@/lib/supabase";

/**
 * The signed-in user's note content usage and quota (ADR 0090), from the
 * `get_my_content_usage` RPC, which answers in the storage quota's row shape. Null
 * when it can't be read (offline, signed out, an older server, or no answer within
 * `STORAGE_USAGE_TIMEOUT_MS`). Only the settings display reads it: the database
 * enforces the quota on every save either way.
 */
export function fetchContentUsage(): Promise<StorageUsage | null> {
  return withTimeout(readContentUsage(), STORAGE_USAGE_TIMEOUT_MS, null);
}

/** One RPC read. A rejection becomes null through `withTimeout`. */
async function readContentUsage(): Promise<StorageUsage | null> {
  const { data, error } = await supabase.rpc("get_my_content_usage");
  if (error) return null;
  return storageUsageFromRow(data);
}
