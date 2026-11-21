import type { NextRequest } from "next/server";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";
import { getContentUsage } from "@/lib/api/content-quota";

/**
 * GET /api/content-usage — the signed-in user's note content usage and quota (ADR 0090).
 * Returns: { usedBytes, quotaBytes } where `quotaBytes` null means unlimited.
 */
export async function GET(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const usage = await getContentUsage(auth.supabase);
  if (!usage) return errorResponse("Failed to load content usage", 500);

  return successResponse({ usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes });
}
