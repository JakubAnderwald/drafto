import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";
import { MAX_FILE_SIZE, BUCKET_NAME, SIGNED_URL_EXPIRY_SECONDS } from "@drafto/shared";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
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

  const { data: attachments, error } = await supabase
    .from("attachments")
    .select("id, note_id, user_id, file_name, file_path, file_size, mime_type, created_at")
    .eq("note_id", noteId)
    .order("created_at", { ascending: false });

  if (error) {
    return errorResponse("Failed to fetch attachments", 500);
  }

  return successResponse(attachments);
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

  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse("Invalid form data", 400);
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return errorResponse("No file provided", 400);
  }

  if (file.size === 0) {
    return errorResponse("File is empty", 400);
  }

  if (file.size > MAX_FILE_SIZE) {
    return errorResponse("File size exceeds 25MB limit", 413);
  }

  // Sanitize filename: strip path traversal and dangerous characters
  const rawName = file.name || "unnamed";
  const sanitized = rawName
    .replace(/[/\\]/g, "_") // no path separators
    .replace(/\.\./g, "_") // no directory traversal
    .replace(/[<>:"|?*\x00-\x1f]/g, "_") // no shell/HTML-special chars
    .slice(0, 255); // cap length

  // Add a timestamp suffix to prevent duplicate filename collisions.
  // When a user uploads, deletes the block, and re-uploads the same file,
  // the original storage object still exists — upsert is off for safety,
  // so a unique name is required.
  const dotIndex = sanitized.lastIndexOf(".");
  const baseName = dotIndex > 0 ? sanitized.slice(0, dotIndex) : sanitized;
  const extension = dotIndex > 0 ? sanitized.slice(dotIndex) : "";
  const fileName = `${baseName}-${Date.now()}${extension}`;
  const filePath = `${user.id}/${noteId}/${fileName}`;

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage.from(BUCKET_NAME).upload(filePath, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });

  if (uploadError) {
    console.error("[attachments] Storage upload failed:", uploadError.message);
    return errorResponse(`Failed to upload file: ${uploadError.message}`, 500);
  }

  // Create attachment record in database
  const { data: attachment, error: dbError } = await supabase
    .from("attachments")
    .insert({
      note_id: noteId,
      user_id: user.id,
      file_name: fileName,
      file_path: filePath,
      file_size: file.size,
      mime_type: file.type || "application/octet-stream",
    })
    .select("id, note_id, user_id, file_name, file_path, file_size, mime_type, created_at")
    .single();

  if (dbError || !attachment) {
    // Clean up uploaded file if DB insert fails
    await supabase.storage.from(BUCKET_NAME).remove([filePath]);
    return errorResponse("Failed to save attachment record", 500);
  }

  // Generate a signed URL for the uploaded file (7 day expiry)
  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, SIGNED_URL_EXPIRY_SECONDS);

  if (urlError || !urlData?.signedUrl) {
    // Clean up: remove uploaded file and DB record
    await supabase.storage.from(BUCKET_NAME).remove([filePath]);
    await supabase.from("attachments").delete().eq("id", attachment.id);
    return errorResponse("Failed to generate file URL", 500);
  }

  return successResponse({ ...attachment, url: urlData.signedUrl }, 201);
}
