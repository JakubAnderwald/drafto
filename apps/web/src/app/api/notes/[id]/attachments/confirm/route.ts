import type { NextRequest } from "next/server";
import { getAuthenticatedNoteOwner, errorResponse, successResponse } from "@/lib/api/utils";
import { BUCKET_NAME, MAX_FILE_SIZE, SIGNED_URL_EXPIRY_SECONDS } from "@drafto/shared";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: noteId } = await params;
  const { data: auth, error: authError } = await getAuthenticatedNoteOwner(noteId, request);
  if (authError) return authError;

  const { supabase, user } = auth;

  let body: {
    filePath?: unknown;
    fileSize?: unknown;
    mimeType?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { filePath, fileSize, mimeType } = body;

  if (typeof filePath !== "string" || filePath.length === 0) {
    return errorResponse("filePath is required", 400);
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

  // Derive fileName from the server-generated filePath to prevent tampering
  const derivedFileName = filePath.slice(expectedPrefix.length);
  if (derivedFileName.length === 0 || derivedFileName.includes("/")) {
    return errorResponse("Invalid file path", 400);
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
      file_name: derivedFileName,
      file_path: filePath,
      file_size: fileSize,
      mime_type: mimeType,
    })
    .select("id, note_id, user_id, file_name, file_path, file_size, mime_type, created_at")
    .single();

  if (dbError || !attachment) {
    // Clean up the orphaned storage object
    await supabase.storage.from(BUCKET_NAME).remove([filePath]);
    return errorResponse("Failed to save attachment record", 500);
  }

  // Generate a signed URL for the uploaded file (7 day expiry)
  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, SIGNED_URL_EXPIRY_SECONDS);

  if (urlError || !urlData?.signedUrl) {
    // Clean up: remove DB record and storage object
    await supabase.from("attachments").delete().eq("id", attachment.id);
    await supabase.storage.from(BUCKET_NAME).remove([filePath]);
    console.error("[attachments] Failed to generate signed URL:", urlError?.message);
    return errorResponse("Failed to generate file URL", 500);
  }

  return successResponse({ ...attachment, url: urlData.signedUrl }, 201);
}
