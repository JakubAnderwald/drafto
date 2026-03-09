import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";
import { contentToBlocknote } from "@drafto/shared";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id } = await params;

  const { data: note, error } = await supabase
    .from("notes")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (error) {
    return errorResponse("Note not found", 404);
  }

  // Defensive conversion: if content was saved in TipTap format by mobile,
  // convert it to BlockNote format so the web editor can render it correctly.
  const content = note.content as unknown;
  if (
    typeof content === "object" &&
    content !== null &&
    !Array.isArray(content) &&
    (content as Record<string, unknown>).type === "doc"
  ) {
    (note as Record<string, unknown>).content = contentToBlocknote(content);
  }

  return successResponse(note);
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
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
  if (body.content !== undefined) updates.content = body.content;
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
    .update(updates)
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    return errorResponse("Failed to update note", 404);
  }

  return successResponse(note);
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
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
