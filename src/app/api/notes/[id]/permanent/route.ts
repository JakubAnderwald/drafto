import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;
  const { id } = await params;

  // Atomic delete: only deletes if note exists, belongs to user, AND is trashed
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

  return successResponse({ success: true });
}
