import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id: notebookId } = await params;

  const { data: notes, error } = await supabase
    .from("notes")
    .select("id, title, created_at, updated_at")
    .eq("notebook_id", notebookId)
    .eq("user_id", user.id)
    .eq("is_trashed", false)
    .order("updated_at", { ascending: false });

  if (error) {
    return errorResponse("Failed to fetch notes", 500);
  }

  return successResponse(notes);
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id: notebookId } = await params;

  const { data: note, error } = await supabase
    .from("notes")
    .insert({
      notebook_id: notebookId,
      user_id: user.id,
      title: "Untitled",
    })
    .select()
    .single();

  if (error) {
    return errorResponse("Failed to create note", 500);
  }

  return successResponse(note, 201);
}
