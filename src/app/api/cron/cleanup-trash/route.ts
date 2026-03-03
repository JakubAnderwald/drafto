import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/env";

export async function POST(request: NextRequest) {
  // Allow cron secret header as an alternative to admin auth
  const cronSecret = env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    // Cron secret authenticated — use server client directly
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("cleanup_trashed_notes");

    if (error) {
      console.error("[cleanup-trash] RPC failed:", error.message);
      return errorResponse("Failed to cleanup trashed notes", 500);
    }

    return successResponse({ deleted: data ?? 0 });
  }

  // Fall back to admin user auth
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

  // Call the cleanup function (SECURITY DEFINER, bypasses RLS)
  const { data, error } = await supabase.rpc("cleanup_trashed_notes");

  if (error) {
    console.error("[cleanup-trash] RPC failed:", error.message);
    return errorResponse("Failed to cleanup trashed notes", 500);
  }

  return successResponse({ deleted: data ?? 0 });
}
