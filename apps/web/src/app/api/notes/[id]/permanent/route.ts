import { after, type NextRequest } from "next/server";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";
import { removeUserOrphanedAttachments } from "@/lib/storage/remove-orphaned-attachments";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id } = await params;

  // Atomic delete: only deletes if note exists, belongs to user, AND is trashed.
  // CASCADE deletes the attachment rows.
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

  // Then remove the note's files, and any other files of this user whose note
  // is gone (e.g. deleted on mobile). The note goes first so a failed or raced
  // delete never costs a live note its files. The user's own client can't do
  // this: the bucket's policies only match objects under a note the user still
  // has. Best-effort, and after the response: the user asked for the note gone,
  // and it is.
  after(() => removeUserOrphanedAttachments(user.id, "web-trash"));

  return successResponse({ success: true });
}
