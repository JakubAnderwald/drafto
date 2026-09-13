import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthenticatedUserFast, errorResponse, isUuid } from "@/lib/api/utils";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeUserAttachments } from "@/lib/storage/remove-user-attachments";

const USER_OWNED_TABLES = ["notebooks", "notes", "api_keys"] as const;

/**
 * Permanently deletes a pending (not yet approved) signup. Deleting the auth
 * user cascades to the profile and every user-owned row; the user's storage
 * objects are cleaned up best-effort afterwards. There is no undo, so every
 * guard runs before `deleteUser` is called.
 */
export async function POST(request: NextRequest) {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;

  const { supabase, user } = auth;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();

  if (profileError) {
    Sentry.captureException(profileError, {
      extra: { where: "delete-user:adminCheck", adminId: user.id },
    });
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

  if (!isUuid(userId)) {
    return errorResponse("userId must be a valid UUID", 400);
  }

  if (userId === user.id) {
    return errorResponse("You cannot delete your own account", 400);
  }

  const { data: target, error: targetError } = await supabase
    .from("profiles")
    .select("is_approved, is_admin")
    .eq("id", userId)
    .maybeSingle();

  if (targetError) {
    Sentry.captureException(targetError, { extra: { where: "delete-user:targetLookup", userId } });
    return errorResponse("Failed to look up user", 500);
  }

  if (!target) {
    return errorResponse("User not found", 404);
  }

  if (target.is_approved || target.is_admin) {
    return errorResponse("Only pending users can be deleted", 409);
  }

  const admin = createAdminClient();

  // Don't trust the profile flags alone. A signup that was never approved cannot
  // own any of these rows (every insert policy on them requires an approved
  // profile), so an account that does is not a genuine pending signup.
  const ownedRows = await Promise.all(
    USER_OWNED_TABLES.map((table) =>
      admin.from(table).select("id", { count: "exact", head: true }).eq("user_id", userId),
    ),
  );

  const failedLookups = ownedRows
    .map(({ error, count }, i) => ({ table: USER_OWNED_TABLES[i], error, count }))
    .filter(({ error, count }) => error || count === null);

  if (failedLookups.length > 0) {
    for (const { table, error } of failedLookups) {
      // A null count without an error has nothing to capture, so report it as its own error.
      const err = error ?? new Error(`Ownership count for ${table} came back empty`);
      Sentry.captureException(err, { extra: { where: "delete-user:ownedRows", table, userId } });
    }
    return errorResponse("Failed to look up user", 500);
  }

  if (ownedRows.some(({ count }) => (count ?? 0) > 0)) {
    return errorResponse("Only pending users can be deleted: this account already has data", 409);
  }

  try {
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
    if (deleteError) throw deleteError;
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "delete-user:deleteUser", userId } });
    return errorResponse("Failed to delete user", 500);
  }

  await removeUserAttachments(admin, userId);

  return NextResponse.json({ success: true });
}
