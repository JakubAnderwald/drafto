import type { NextRequest } from "next/server";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";
import { contentQuotaResponseFor } from "@/lib/api/content-quota";
import { reportError } from "@/lib/report-error";
import {
  contentToBlocknote,
  resolveBlockNoteImageUrls,
  migrateSignedUrlsToAttachmentUrls,
  BUCKET_NAME,
  SIGNED_URL_EXPIRY_SECONDS,
} from "@drafto/shared";
import type { BlockNoteBlock } from "@drafto/shared";
import type { Database } from "@/lib/supabase/database.types";

type NoteUpdate = Database["public"]["Tables"]["notes"]["Update"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id } = await params;

  const { data: note, error } = await supabase
    .from("notes")
    // `is_trashed` is returned rather than filtered on: the web editor needs to be
    // able to tell that the note it has open was trashed on another device.
    .select("id, title, content, is_trashed, created_at, updated_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (error) {
    return errorResponse("Note not found", 404);
  }

  // Defensive conversion: if content was saved in TipTap format by mobile,
  // convert it to BlockNote format so the web editor can render it correctly.
  const noteRecord = note as Record<string, unknown>;
  const content = noteRecord.content;
  if (
    typeof content === "object" &&
    content !== null &&
    !Array.isArray(content) &&
    (content as Record<string, unknown>).type === "doc" &&
    Array.isArray((content as Record<string, unknown>).content)
  ) {
    const converted = contentToBlocknote(content);
    noteRecord.content = converted;

    // Persist the repaired content so future reads don't need conversion
    supabase
      .from("notes")
      .update({ content: converted as unknown as string })
      .eq("id", id)
      .eq("user_id", user.id)
      .then(({ error: updateError }) => {
        if (updateError) {
          reportError(updateError, "api:notes-get:persist-converted", { extra: { noteId: id } });
        }
      });
  }

  // Resolve attachment:// URLs to fresh signed URLs
  if (Array.isArray(noteRecord.content)) {
    const blocks = noteRecord.content as BlockNoteBlock[];
    // Signing failures are counted and reported once per request, without the file path (it
    // carries the attachment's file name): a storage outage must not send one event per image.
    let failedCount = 0;
    let firstSignError: unknown = null;
    noteRecord.content = await resolveBlockNoteImageUrls(blocks, async (filePath) => {
      const { data, error } = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(filePath, SIGNED_URL_EXPIRY_SECONDS);
      if (error || !data?.signedUrl) {
        failedCount += 1;
        firstSignError ??= error ?? new Error("createSignedUrl returned no URL");
        return `attachment://${filePath}`;
      }
      return data.signedUrl;
    });
    if (failedCount > 0) {
      reportError(firstSignError, "api:notes-get:sign-attachments", {
        extra: { noteId: id, failedCount },
      });
    }
  }

  return successResponse(noteRecord);
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
  const updates: Record<string, unknown> = {};

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.length > 255) {
      return errorResponse("Title must be a string of at most 255 characters", 400);
    }
    updates.title = body.title;
  }
  if (body.content !== undefined) {
    // Migrate any legacy signed Supabase URLs to attachment:// scheme
    if (Array.isArray(body.content)) {
      updates.content = migrateSignedUrlsToAttachmentUrls(body.content as BlockNoteBlock[]);
    } else {
      updates.content = body.content;
    }
  }
  if (body.notebook_id !== undefined) updates.notebook_id = body.notebook_id;
  if (body.is_trashed !== undefined) {
    if (typeof body.is_trashed !== "boolean") {
      return errorResponse("is_trashed must be a boolean", 400);
    }
    updates.is_trashed = body.is_trashed;
    updates.trashed_at = body.is_trashed ? new Date().toISOString() : null;
  }

  if (Object.keys(updates).length === 0) {
    return errorResponse("No fields to update", 400);
  }

  const { data: note, error } = await supabase
    .from("notes")
    .update(updates as NoteUpdate)
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    // The notes trigger refuses a write that grows the user's content past their quota.
    return contentQuotaResponseFor(error) ?? errorResponse("Failed to update note", 404);
  }

  return successResponse(note);
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id } = await params;

  const { error } = await supabase
    .from("notes")
    .update({ is_trashed: true, trashed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return errorResponse("Failed to delete note", 500);
  }

  return successResponse({ success: true });
}
