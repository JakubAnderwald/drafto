import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id } = await params;

  // Only allow permanent deletion of trashed notes
  const { data: note, error: fetchError } = await supabase
    .from("notes")
    .select("id, is_trashed")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (fetchError || !note) {
    return errorResponse("Note not found", 404);
  }

  if (!note.is_trashed) {
    return errorResponse("Note must be in trash before permanent deletion", 400);
  }

  const { error } = await supabase.from("notes").delete().eq("id", id).eq("user_id", user.id);

  if (error) {
    return errorResponse("Failed to permanently delete note", 500);
  }

  return successResponse({ success: true });
}
