import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  STORAGE_QUOTA_EXCEEDED_CODE,
  STORAGE_QUOTA_EXCEEDED_MESSAGE,
  storageUsageFromRow,
  type StorageUsage,
} from "@drafto/shared";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The calling user's attachment usage and quota (issue #794), read through the
 * `get_my_storage_usage` RPC, or null when it can't be read. Callers decide what a
 * missing reading means: the upload pre-check lets the upload through (the
 * attachments trigger still enforces the quota), the usage endpoint answers 500.
 */
export async function getStorageUsage(
  supabase: SupabaseClient<Database>,
): Promise<StorageUsage | null> {
  let data: unknown;
  try {
    const result = await supabase.rpc("get_my_storage_usage");
    if (result.error) {
      console.error("[storage-quota] Failed to read storage usage:", result.error.message);
      Sentry.captureException(result.error, { extra: { where: "storage-quota:get-usage" } });
      return null;
    }
    data = result.data;
  } catch (err) {
    console.error("[storage-quota] Failed to read storage usage:", err);
    Sentry.captureException(err, { extra: { where: "storage-quota:get-usage" } });
    return null;
  }
  const usage = storageUsageFromRow(data);
  if (!usage) {
    console.error("[storage-quota] get_my_storage_usage returned no usable row");
  }
  return usage;
}

/**
 * The 413 an attachment route answers when an upload would go over the quota. The
 * `code` tells clients it's the quota (the per-file size 413 has none) and the
 * numbers let them say how full the storage is; both are null when unknown.
 */
export function storageQuotaExceededResponse(usage: StorageUsage | null): NextResponse {
  return NextResponse.json(
    {
      error: STORAGE_QUOTA_EXCEEDED_MESSAGE,
      code: STORAGE_QUOTA_EXCEEDED_CODE,
      usedBytes: usage?.usedBytes ?? null,
      quotaBytes: usage?.quotaBytes ?? null,
      status: 413,
    },
    { status: 413 },
  );
}
