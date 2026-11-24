import { after, type NextRequest } from "next/server";
import { duplicateNotebookNameMessage } from "@drafto/shared";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";
import { findNotebookNameConflict } from "@/lib/api/notebook-name-conflict";
import { removeUserOrphanedAttachments } from "@/lib/storage/remove-orphaned-attachments";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  const name = body.name;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return errorResponse("name is required", 400);
  }

  // Names are unique per user, ignoring case and spacing (ADR-0097). A notebook never
  // clashes with itself, so changing only the case of its name goes through.
  const conflict = await findNotebookNameConflict(supabase, user.id, name, id);
  if (conflict.error) {
    return errorResponse("Failed to check notebook names", 500);
  }
  // A missing or foreign notebook is not found, whatever name was asked for: the same 404
  // the update below gives it, before any 409 about the name.
  if (!conflict.renamedNotebookFound) {
    return errorResponse("Failed to update notebook", 404);
  }
  if (conflict.duplicate) {
    return errorResponse(duplicateNotebookNameMessage(conflict.duplicate.name), 409);
  }

  const { data: notebook, error } = await supabase
    .from("notebooks")
    .update({ name: name.trim() })
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    return errorResponse("Failed to update notebook", 404);
  }

  return successResponse(notebook);
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id } = await params;

  // Check if notebook has non-trashed notes
  const { count, error: countError } = await supabase
    .from("notes")
    .select("id", { count: "exact", head: true })
    .eq("notebook_id", id)
    .eq("user_id", user.id)
    .eq("is_trashed", false);

  if (countError) {
    return errorResponse("Failed to check notebook contents", 500);
  }

  if (count && count > 0) {
    return errorResponse("Cannot delete notebook with notes. Move or delete notes first.", 409);
  }

  const { error } = await supabase.from("notebooks").delete().eq("id", id).eq("user_id", user.id);

  if (error) {
    return errorResponse("Failed to delete notebook", 500);
  }

  // The notebook's trashed notes went with it (ON DELETE CASCADE); remove their
  // files once the response is sent.
  after(() => removeUserOrphanedAttachments(user.id, "web-notebooks"));

  return successResponse({ success: true });
}
