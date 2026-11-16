import type { NextRequest } from "next/server";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";
import { getStorageUsage } from "@/lib/api/storage-quota";

/**
 * GET /api/storage-usage — the signed-in user's attachment usage and quota.
 * Returns: { usedBytes, quotaBytes } where `quotaBytes` null means unlimited.
 */
export async function GET(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const usage = await getStorageUsage(auth.supabase);
  if (!usage) return errorResponse("Failed to load storage usage", 500);

  return successResponse({ usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes });
}
