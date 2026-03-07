import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";

interface RouteParams {
  params: Promise<{ id: string }>;
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
  const name = body.name;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return errorResponse("name is required", 400);
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

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id } = await params;

  // Check if notebook has notes
  const { count, error: countError } = await supabase
    .from("notes")
    .select("id", { count: "exact", head: true })
    .eq("notebook_id", id)
    .eq("user_id", user.id);

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

  return successResponse({ success: true });
}
