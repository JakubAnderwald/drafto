import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";

export async function POST() {
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
    return errorResponse("Failed to cleanup trashed notes", 500);
  }

  return successResponse({ deleted: data ?? 0 });
}
