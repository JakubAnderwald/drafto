import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";
import { sanitizeAndBuildPath } from "@/lib/api/sanitize-filename";
import { MAX_FILE_SIZE, BUCKET_NAME } from "@drafto/shared";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id: noteId } = await params;

  // Verify the note exists and belongs to the user
  const { data: note, error: noteError } = await supabase
    .from("notes")
    .select("id")
    .eq("id", noteId)
    .eq("user_id", user.id)
    .single();

  if (noteError || !note) {
    return errorResponse("Note not found", 404);
  }

  let body: { fileName?: unknown; fileSize?: unknown; mimeType?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { fileName: rawFileName, fileSize, mimeType } = body;

  if (typeof rawFileName !== "string" || rawFileName.length === 0) {
    return errorResponse("fileName is required", 400);
  }
  if (typeof fileSize !== "number" || fileSize <= 0) {
    return errorResponse("fileSize must be a positive number", 400);
  }
  if (fileSize > MAX_FILE_SIZE) {
    return errorResponse("File size exceeds 25MB limit", 413);
  }
  if (typeof mimeType !== "string" || mimeType.length === 0) {
    return errorResponse("mimeType is required", 400);
  }

  const { fileName, filePath } = sanitizeAndBuildPath(rawFileName, user.id, noteId);

  const { data, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUploadUrl(filePath);

  if (urlError || !data) {
    console.error("[attachments] Failed to create signed upload URL:", urlError?.message);
    return errorResponse("Failed to create upload URL", 500);
  }

  return successResponse({
    signedUrl: data.signedUrl,
    token: data.token,
    filePath,
    fileName,
  });
}
