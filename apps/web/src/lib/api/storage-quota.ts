import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  STORAGE_QUOTA_EXCEEDED_CODE,
  STORAGE_QUOTA_EXCEEDED_MESSAGE,
  type StorageUsage,
} from "@drafto/shared";
import type { Database } from "@/lib/supabase/database.types";
import { readMyUsage } from "@/lib/api/usage-rpc";

/**
 * The calling user's attachment usage and quota (issue #794), read through the
 * `get_my_storage_usage` RPC, or null when it can't be read. Callers decide what a
 * missing reading means: the upload pre-check lets the upload through (the
 * attachments trigger still enforces the quota), the usage endpoint answers 500.
 */
export function getStorageUsage(supabase: SupabaseClient<Database>): Promise<StorageUsage | null> {
  return readMyUsage(supabase, "get_my_storage_usage", "storage-quota", "storage usage");
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
