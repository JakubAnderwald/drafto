import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { storageUsageFromRow, type StorageUsage } from "@drafto/shared";
import type { Database } from "@/lib/supabase/database.types";

/** The no-argument RPCs that return the caller's `{ used_bytes, quota_bytes }` row. */
export type MyUsageRpc = "get_my_storage_usage" | "get_my_content_usage";

/**
 * The calling user's usage and quota from one of the `get_my_*_usage` RPCs, or null
 * when it can't be read. `tag` names the caller in logs and Sentry (`storage-quota`,
 * `content-quota`). Callers decide what a missing reading means.
 */
export async function readMyUsage(
  supabase: SupabaseClient<Database>,
  rpc: MyUsageRpc,
  tag: string,
  label: string,
): Promise<StorageUsage | null> {
  let data: unknown;
  try {
    const result = await supabase.rpc(rpc);
    if (result.error) {
      console.error(`[${tag}] Failed to read ${label}:`, result.error.message);
      Sentry.captureException(result.error, { extra: { where: `${tag}:get-usage` } });
      return null;
    }
    data = result.data;
  } catch (err) {
    console.error(`[${tag}] Failed to read ${label}:`, err);
    Sentry.captureException(err, { extra: { where: `${tag}:get-usage` } });
    return null;
  }
  const usage = storageUsageFromRow(data);
  if (!usage) {
    console.error(`[${tag}] ${rpc} returned no usable row`);
  }
  return usage;
}
