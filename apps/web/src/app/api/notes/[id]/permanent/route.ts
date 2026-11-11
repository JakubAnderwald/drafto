import * as Sentry from "@sentry/nextjs";
import type { NextRequest } from "next/server";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeNoteAttachments } from "@/lib/storage/remove-user-attachments";

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

  // Then remove the note's files. The note goes first so a failed or raced
  // delete never costs a live note its files. The user's own client can't do
  // this step: the bucket's policies only match objects under a note the user
  // still has, so after the delete its remove() silently matches nothing. The
  // service-role client is safe here because the delete above proved the note
  // was this user's, and removeNoteAttachments stays inside {user.id}/{id}/.
  // Best-effort: the user asked for the note gone, and it is.
  try {
    await removeNoteAttachments(createAdminClient("web-trash"), user.id, data.id);
  } catch (err) {
    // createAdminClient throws when the service-role key isn't configured.
    Sentry.captureException(err, { extra: { where: "notes-permanent:storage", noteId: data.id } });
  }

  return successResponse({ success: true });
}
