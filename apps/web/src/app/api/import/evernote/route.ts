import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";
import { convertEnmlToBlocks } from "@/lib/import/enml-to-blocknote";
import type {
  ImportBatchRequest,
  ImportBatchResult,
  EnexNote,
  EnexResource,
} from "@/lib/import/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { BUCKET_NAME, SIGNED_URL_EXPIRY_SECONDS } from "@drafto/shared";

export async function POST(request: Request) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;

  let body: ImportBatchRequest;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.notes || !Array.isArray(body.notes) || body.notes.length === 0) {
    return errorResponse("No notes provided", 400);
  }

  if (body.notes.length > 5) {
    return errorResponse("Maximum 5 notes per batch", 400);
  }

  // Resolve or create notebook
  let notebookId = body.notebookId;
  if (!notebookId) {
    const name = body.notebookName || "Evernote Import";
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

  const result: ImportBatchResult = {
    notebookId,
    notesImported: 0,
    notesFailed: 0,
    errors: [],
  };

  for (const note of body.notes) {
    try {
      await importNote(supabase, user.id, notebookId, note);
      result.notesImported++;
    } catch (err) {
      result.notesFailed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      result.errors.push(`"${note.title}": ${message}`);
    }
  }

  return successResponse(result, 200);
}

async function importNote(
  supabase: SupabaseClient<Database>,
  userId: string,
  notebookId: string,
  note: EnexNote,
): Promise<void> {
  // Create note row first to get the ID
  const { data: noteRow, error: noteError } = await supabase
    .from("notes")
    .insert({
      title: note.title.slice(0, 500),
      content: [], // placeholder — will update after uploading attachments
      notebook_id: notebookId,
      user_id: userId,
      created_at: note.created,
      updated_at: note.updated,
    })
    .select("id")
    .single();

  if (noteError || !noteRow) {
    throw new Error(`Failed to create note: ${noteError?.message || "unknown"}`);
  }

  // Upload attachments and build hash→URL map
  const attachmentUrlMap = new Map<string, string>();

  for (const resource of note.resources) {
    try {
      const url = await uploadResource(supabase, userId, noteRow.id, resource);
      if (url) {
        attachmentUrlMap.set(resource.hash, url);
      }
    } catch {
      // Skip failed attachments — partial import is acceptable
    }
  }

  // Convert ENML to BlockNote blocks
  const blocks = convertEnmlToBlocks(note.content, attachmentUrlMap);

  // Update note with converted content
  const { error: updateError } = await supabase
    .from("notes")
    .update({ content: blocks as unknown as Json[] })
    .eq("id", noteRow.id);

  if (updateError) {
    throw new Error(`Failed to update note content: ${updateError.message}`);
  }
}

async function uploadResource(
  supabase: SupabaseClient<Database>,
  userId: string,
  noteId: string,
  resource: EnexResource,
): Promise<string | null> {
  // Decode base64 to buffer
  const binaryString = atob(resource.data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Sanitize filename
  const fileName = resource.fileName
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .slice(0, 255);

  const filePath = `${userId}/${noteId}/${fileName}`;

  // Upload to storage
  const { error: uploadError } = await supabase.storage.from(BUCKET_NAME).upload(filePath, bytes, {
    contentType: resource.mime,
    upsert: false,
  });

  if (uploadError) {
    return null;
  }

  // Create attachment record
  const { data: attachment, error: dbError } = await supabase
    .from("attachments")
    .insert({
      note_id: noteId,
      user_id: userId,
      file_name: fileName,
      file_path: filePath,
      file_size: bytes.length,
      mime_type: resource.mime,
    })
    .select("id")
    .single();

  if (dbError || !attachment) {
    await supabase.storage.from(BUCKET_NAME).remove([filePath]);
    return null;
  }

  // Generate signed URL
  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, SIGNED_URL_EXPIRY_SECONDS);

  if (urlError || !urlData?.signedUrl) {
    return null;
  }

  return urlData.signedUrl;
}
