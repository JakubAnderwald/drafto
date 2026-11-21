import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTENT_QUOTA_EXCEEDED_CODE,
  CONTENT_QUOTA_EXCEEDED_MESSAGE,
  contentFullMessage,
  contentUsageFromError,
  isContentQuotaError,
  type StorageUsage,
} from "@drafto/shared";
import type { Database } from "@/lib/supabase/database.types";
import { readMyUsage } from "@/lib/api/usage-rpc";

/**
 * The calling user's note content usage and quota (ADR 0090), read through the
 * `get_my_content_usage` RPC, or null when it can't be read.
 */
export function getContentUsage(supabase: SupabaseClient<Database>): Promise<StorageUsage | null> {
  return readMyUsage(supabase, "get_my_content_usage", "content-quota", "content usage");
}

/**
 * The 413 a note route answers when the notes trigger refused a write for the
 * content quota. `usedBytes` / `quotaBytes` come from the trigger's detail, and are
 * null when it didn't carry them.
 */
export function contentQuotaExceededResponse(dbError: unknown): NextResponse {
  const usage = contentUsageFromError(dbError);
  return NextResponse.json(
    {
      error: CONTENT_QUOTA_EXCEEDED_MESSAGE,
      code: CONTENT_QUOTA_EXCEEDED_CODE,
      usedBytes: usage?.usedBytes ?? null,
      quotaBytes: usage?.quotaBytes ?? null,
      status: 413,
    },
    { status: 413 },
  );
}

/** The 413 for a content quota refusal, or null when `dbError` is anything else. */
export function contentQuotaResponseFor(dbError: unknown): NextResponse | null {
  return isContentQuotaError(dbError) ? contentQuotaExceededResponse(dbError) : null;
}

/** The user-facing text for a content quota refusal, or null when `dbError` is anything else. */
export function contentQuotaMessageFor(dbError: unknown): string | null {
  if (!isContentQuotaError(dbError)) return null;
  const usage = contentUsageFromError(dbError);
  return contentFullMessage(usage?.usedBytes, usage?.quotaBytes);
}
