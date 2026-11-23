import type { NextRequest } from "next/server";
import { duplicateNotebookNameMessage } from "@drafto/shared";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";
import { findNotebookNameConflict } from "@/lib/api/notebook-name-conflict";
import { NOTE_COUNT_FILTER_COLUMN, withNoteCount } from "@/lib/api/notebook-note-count";

export async function GET(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;

  const { data: notebooks, error } = await supabase
    .from("notebooks")
    .select("*, notes(count)")
    .eq("user_id", user.id)
    .eq(NOTE_COUNT_FILTER_COLUMN, false)
    .order("updated_at", { ascending: false });

  if (error) {
    return errorResponse("Failed to fetch notebooks", 500);
  }

  return successResponse(notebooks.map(withNoteCount));
}

export async function POST(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;

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

  // Names are unique per user, ignoring case and spacing (ADR-0097).
  const conflict = await findNotebookNameConflict(supabase, user.id, name);
  if (conflict.error) {
    return errorResponse("Failed to check notebook names", 500);
  }
  if (conflict.duplicate) {
    return errorResponse(duplicateNotebookNameMessage(conflict.duplicate.name), 409);
  }

  const { data: notebook, error } = await supabase
    .from("notebooks")
    .insert({ user_id: user.id, name: name.trim() })
    .select()
    .single();

  if (error) {
    return errorResponse("Failed to create notebook", 500);
  }

  return successResponse(notebook, 201);
}
