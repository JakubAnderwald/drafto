import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";

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
