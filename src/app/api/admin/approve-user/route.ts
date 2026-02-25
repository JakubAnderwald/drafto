import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse } from "@/lib/api/utils";

export async function POST(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUser();
  if (authError) return authError;

  const { supabase, user } = auth;

  // Check if requester is an admin
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();

  if (profileError) {
    return errorResponse("Failed to verify admin privileges", 500);
  }

  if (!profile?.is_admin) {
    return errorResponse("Forbidden", 403);
  }

  let userId: unknown;
  try {
    const body = await request.json();
    userId = body?.userId;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!userId || typeof userId !== "string") {
    return errorResponse("userId is required", 400);
  }

  const { data: updatedProfile, error: updateError } = await supabase
    .from("profiles")
    .update({ is_approved: true })
    .eq("id", userId)
    .select("id")
    .maybeSingle();

  if (updateError) {
    return errorResponse("Failed to approve user", 500);
  }

  if (!updatedProfile) {
    return errorResponse("User not found", 404);
  }

  return NextResponse.json({ success: true });
}
