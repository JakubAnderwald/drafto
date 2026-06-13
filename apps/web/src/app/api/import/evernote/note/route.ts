import type { NextRequest } from "next/server";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";
import type { ImportNoteRequest } from "@/lib/import/types";

/**
 * Create a single empty note (and, on first call, its notebook) for an Evernote
 * import, preserving the original title and timestamps. Attachments are then
 * uploaded directly to Storage against the returned noteId, and the note's
 * content is filled in by the `finalize` route. Splitting note creation out of
 * the content step lets the client upload attachment bytes directly to Supabase
 * Storage (bypassing the ~4.5 MB serverless request-body limit) before the ENML
 * is converted.
 */
export async function POST(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;

  let body: ImportNoteRequest;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (typeof body.title !== "string") {
    return errorResponse("title is required", 400);
  }

  // Resolve or create the target notebook.
  let notebookId = body.notebookId;
  if (!notebookId) {
    const name = body.notebookName?.trim() || "Evernote Import";
    const { data: notebook, error: nbError } = await supabase
      .from("notebooks")
      .insert({ name, user_id: user.id })
      .select("id")
      .single();

    if (nbError || !notebook) {
      return errorResponse("Failed to create notebook", 500);
    }
    notebookId = notebook.id;
  }

  const { data: note, error: noteError } = await supabase
    .from("notes")
    .insert({
      title: body.title.slice(0, 500),
      content: [], // filled in by /finalize after attachments upload
      notebook_id: notebookId,
      user_id: user.id,
      created_at: body.created,
      updated_at: body.updated,
    })
    .select("id")
    .single();

  if (noteError || !note) {
    return errorResponse(`Failed to create note: ${noteError?.message || "unknown"}`, 500);
  }

  return successResponse({ notebookId, noteId: note.id }, 201);
}
