import type { NextRequest } from "next/server";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";
import { convertEnmlToBlocks } from "@/lib/import/enml-to-blocknote";
import { sanitizeAndBuildPath } from "@/lib/api/sanitize-filename";
import type {
  ImportBatchRequest,
  ImportBatchResult,
  EnexNote,
  EnexResource,
} from "@/lib/import/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { createHash } from "node:crypto";
import { BUCKET_NAME, toAttachmentUrl } from "@drafto/shared";

export async function POST(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
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

  // Upload attachments and build an en-media hash → attachment map. The
  // `<en-media hash="...">` value is the MD5 of the resource binary, so key the
  // map by exactly that — computed server-side, where Node crypto has MD5.
  // Identical-content resources share an MD5 and therefore one entry, matching
  // Evernote's content-addressed en-media semantics.
  const attachmentUrlMap = new Map<string, { url: string; name: string }>();

  for (const resource of note.resources) {
    try {
      const bytes = decodeBase64(resource.data);
      const md5 = createHash("md5").update(bytes).digest("hex");
      const uploaded = await uploadResource(supabase, userId, noteRow.id, resource, bytes);
      if (uploaded) {
        attachmentUrlMap.set(md5, uploaded);
      }
    } catch {
      // Skip failed attachments — partial import is acceptable
    }
  }

  // Convert ENML to BlockNote blocks
  const blocks = convertEnmlToBlocks(note.content, attachmentUrlMap, note.tasks);

  // Update note with converted content
  const { error: updateError } = await supabase
    .from("notes")
    .update({ content: blocks as unknown as Json[] })
    .eq("id", noteRow.id);

  if (updateError) {
    throw new Error(`Failed to update note content: ${updateError.message}`);
  }
}

function decodeBase64(data: string): Uint8Array {
  const binaryString = atob(data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function uploadResource(
  supabase: SupabaseClient<Database>,
  userId: string,
  noteId: string,
  resource: EnexResource,
  bytes: Uint8Array,
): Promise<{ url: string; name: string } | null> {
  // Reuse the shared path builder so imported attachments get the same
  // collision-safe, sanitized storage path as native uploads (a timestamp+UUID
  // suffix keeps two same-named resources in one note from clobbering each other).
  const { fileName, filePath } = sanitizeAndBuildPath(resource.fileName, userId, noteId);

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

  // Store the durable attachment:// reference, not a signed URL. GET
  // /api/notes/[id] resolves a fresh signed URL at read time, so the note never
  // holds an expiring URL. The block's display name keeps the original Evernote
  // filename; the storage path (and DB file_name) carries the uniqueness suffix.
  return { url: toAttachmentUrl(filePath), name: resource.fileName };
}
