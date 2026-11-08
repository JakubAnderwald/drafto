import { storageUsageFromRow } from "@drafto/shared";
import type { StorageUsage } from "@drafto/shared";

import { supabase } from "@/lib/supabase";

/**
 * The signed-in user's attachment storage usage and quota (issue #794), from the
 * `get_my_storage_usage` RPC. Null when it can't be read (offline, signed out, an
 * older server): callers then skip their pre-check and leave the refusal to the
 * database, which enforces the quota either way.
 */
export async function fetchStorageUsage(): Promise<StorageUsage | null> {
  try {
    const { data, error } = await supabase.rpc("get_my_storage_usage");
    if (error) return null;
    return storageUsageFromRow(data);
  } catch {
    return null;
  }
}
