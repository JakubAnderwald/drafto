import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse } from "@/lib/api/utils";

export async function POST(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;

  // Check if requester is an admin
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();

  if (!profile?.is_admin) {
    return errorResponse("Forbidden", 403);
  }

  const body = await request.json();
  const userId = body.userId;

  if (!userId || typeof userId !== "string") {
    return errorResponse("userId is required", 400);
  }

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ is_approved: true })
    .eq("id", userId);

  if (updateError) {
    return errorResponse(updateError.message, 500);
  }

  return NextResponse.json({ success: true });
}
