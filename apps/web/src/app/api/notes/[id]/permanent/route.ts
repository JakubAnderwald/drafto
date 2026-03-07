import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const BUCKET_NAME = "attachments";

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id } = await params;

  // Fetch attachment file paths before deleting the note (cascade will remove DB rows)
  const { data: attachments } = await supabase
    .from("attachments")
    .select("file_path")
    .eq("note_id", id)
    .eq("user_id", user.id);

  // Atomic delete: only deletes if note exists, belongs to user, AND is trashed
  // CASCADE will automatically delete attachment DB records
  const { data, error } = await supabase
    .from("notes")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("is_trashed", true)
    .select("id")
    .single();

  if (error || !data) {
    return errorResponse("Note not found or not in trash", 404);
  }

  // Clean up storage files (best-effort — DB records already cascaded)
  if (attachments && attachments.length > 0) {
    const filePaths = attachments.map((a) => a.file_path);
    await supabase.storage.from(BUCKET_NAME).remove(filePaths);
  }

  return successResponse({ success: true });
}
