import type { NextRequest } from "next/server";
import { getAuthenticatedUserFast, errorResponse, successResponse } from "@/lib/api/utils";

export async function GET(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;

  const { data: notes, error } = await supabase
    .from("notes")
    .select("id, title, notebook_id, trashed_at, created_at, updated_at")
    .eq("user_id", user.id)
    .eq("is_trashed", true)
    .order("trashed_at", { ascending: false });

  if (error) {
    return errorResponse("Failed to fetch trashed notes", 500);
  }

  return successResponse(notes);
}
