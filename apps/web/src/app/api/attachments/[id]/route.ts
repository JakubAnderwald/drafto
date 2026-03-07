import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";
import { BUCKET_NAME } from "@drafto/shared";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id: attachmentId } = await params;

  // Fetch the attachment to get the file path (and verify ownership)
  const { data: attachment, error: fetchError } = await supabase
    .from("attachments")
    .select("id, file_path")
    .eq("id", attachmentId)
    .eq("user_id", user.id)
    .single();

  if (fetchError || !attachment) {
    return errorResponse("Attachment not found", 404);
  }

  // Remove from storage
  const { error: storageError } = await supabase.storage
    .from(BUCKET_NAME)
    .remove([attachment.file_path]);

  if (storageError) {
    return errorResponse("Failed to delete file from storage", 500);
  }

  // Delete the database record
  const { error: dbError } = await supabase.from("attachments").delete().eq("id", attachmentId);

  if (dbError) {
    return errorResponse("Failed to delete attachment record", 500);
  }

  return successResponse({ success: true });
}
