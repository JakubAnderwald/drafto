import type { NextRequest } from "next/server";
import { getAuthenticatedNoteOwner, errorResponse, successResponse } from "@/lib/api/utils";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id: noteId } = await params;
  const { data: auth, error: authError } = await getAuthenticatedNoteOwner(noteId);
  if (authError) return authError;

  const { supabase } = auth;

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
