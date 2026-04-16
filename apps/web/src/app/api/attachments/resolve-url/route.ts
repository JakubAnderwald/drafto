import type { NextRequest } from "next/server";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";
import { BUCKET_NAME, SIGNED_URL_EXPIRY_SECONDS } from "@drafto/shared";

export async function POST(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { filePath } = body;
  if (typeof filePath !== "string" || filePath.length === 0) {
    return errorResponse("filePath is required", 400);
  }

  // Verify the file belongs to the authenticated user
  if (!filePath.startsWith(`${user.id}/`)) {
    return errorResponse("Forbidden", 403);
  }

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, SIGNED_URL_EXPIRY_SECONDS);

  if (error || !data?.signedUrl) {
    return errorResponse("Failed to generate signed URL", 500);
  }

  return successResponse({ signedUrl: data.signedUrl });
}
