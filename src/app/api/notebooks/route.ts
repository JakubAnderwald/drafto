import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";

export async function GET() {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;

  const { data: notebooks, error } = await supabase
    .from("notebooks")
    .select("*")
    .eq("user_id", user.id)
    .order("name");

  if (error) {
    return errorResponse(error.message, 500);
  }

  return successResponse(notebooks);
}

export async function POST(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;

  const body = await request.json();
  const name = body.name;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return errorResponse("name is required", 400);
  }

  const { data: notebook, error } = await supabase
    .from("notebooks")
    .insert({ user_id: user.id, name: name.trim() })
    .select()
    .single();

  if (error) {
    return errorResponse(error.message, 500);
  }

  return successResponse(notebook, 201);
}
