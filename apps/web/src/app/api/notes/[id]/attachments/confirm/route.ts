import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";
import { BUCKET_NAME, MAX_FILE_SIZE, SIGNED_URL_EXPIRY_SECONDS } from "@drafto/shared";

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

  let body: {
    filePath?: unknown;
    fileName?: unknown;
    fileSize?: unknown;
    mimeType?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { filePath, fileName, fileSize, mimeType } = body;

  if (typeof filePath !== "string" || filePath.length === 0) {
    return errorResponse("filePath is required", 400);
  }
  if (typeof fileName !== "string" || fileName.length === 0) {
    return errorResponse("fileName is required", 400);
  }
  if (typeof fileSize !== "number" || fileSize <= 0) {
    return errorResponse("fileSize must be a positive number", 400);
  }
  if (fileSize > MAX_FILE_SIZE) {
    return errorResponse("File size exceeds 25MB limit", 400);
  }
  if (typeof mimeType !== "string" || mimeType.length === 0) {
    return errorResponse("mimeType is required", 400);
  }

  // Validate that the filePath belongs to this user and note (prevent path injection)
  const expectedPrefix = `${user.id}/${noteId}/`;
  if (!filePath.startsWith(expectedPrefix)) {
    return errorResponse("Invalid file path", 403);
  }

  // Verify the file was actually uploaded to storage
  const { error: verifyError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, 60);

  if (verifyError) {
    return errorResponse("File not found in storage — upload may have failed", 400);
  }

  // Create attachment record in database
  const { data: attachment, error: dbError } = await supabase
    .from("attachments")
    .insert({
      note_id: noteId,
      user_id: user.id,
      file_name: fileName,
      file_path: filePath,
      file_size: fileSize,
      mime_type: mimeType,
    })
    .select("id, note_id, user_id, file_name, file_path, file_size, mime_type, created_at")
    .single();

  if (dbError || !attachment) {
    return errorResponse("Failed to save attachment record", 500);
  }

  // Generate a signed URL for the uploaded file (7 day expiry)
  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, SIGNED_URL_EXPIRY_SECONDS);

  if (urlError || !urlData?.signedUrl) {
    // Clean up the DB record if we can't generate a URL
    await supabase.from("attachments").delete().eq("id", attachment.id);
    return errorResponse("Failed to generate file URL", 500);
  }

  return successResponse({ ...attachment, url: urlData.signedUrl }, 201);
}
