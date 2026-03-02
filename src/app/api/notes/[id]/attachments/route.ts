import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const MAX_FILE_SIZE = 26214400; // 25MB in bytes
const BUCKET_NAME = "attachments";

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

  const fileName = file.name || "unnamed";
  const filePath = `${user.id}/${noteId}/${fileName}`;

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage.from(BUCKET_NAME).upload(filePath, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });

  if (uploadError) {
    return errorResponse("Failed to upload file", 500);
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
    .select()
    .single();

  if (dbError) {
    // Clean up uploaded file if DB insert fails
    await supabase.storage.from(BUCKET_NAME).remove([filePath]);
    return errorResponse("Failed to save attachment record", 500);
  }

  // Generate a signed URL for the uploaded file (1 year expiry)
  const { data: urlData } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, 31536000);

  return successResponse({ ...attachment, url: urlData?.signedUrl ?? null }, 201);
}
