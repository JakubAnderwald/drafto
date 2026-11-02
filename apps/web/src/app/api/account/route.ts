import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import { errorResponse } from "@/lib/api/utils";
import { authenticateAccountRequest } from "@/lib/account/authenticate-account-request";
import { deleteUserAccount } from "@/lib/account/delete-user";
import { readAppleRevocationGrant } from "@/lib/account/read-apple-revocation-grant";
import { getAppleSignInKey } from "@/lib/apple/config";
import { appleSubjectsOf } from "@/lib/apple/identities";
import { revokeAppleSignIn } from "@/lib/apple/revoke";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The function's time limit, in seconds. 60 s is the Vercel Hobby ceiling without
 * Fluid compute; a normal deletion takes a few seconds.
 */
export const maxDuration = 60;

/**
 * Kept back from `maxDuration` for sending the response. The Apple revocation
 * runs after the account is gone, and is cut short to finish before this margin,
 * so a slow deletion plus a slow Apple can never cost the client its success
 * response (it would keep the session and offline data of a deleted account).
 */
export const RESPONSE_MARGIN_MS = 5_000;

const DELETE_FAILED_MESSAGE = "Failed to delete your account. Please try again.";
const STORAGE_FAILED_MESSAGE =
  "Failed to delete your attachments. Your account was not deleted — please try again.";

/**
 * Permanently deletes the caller's own account (web, iOS, Android, macOS).
 *
 * Takes no parameters: the user id comes only from the verified bearer token
 * or session cookie, so a caller can never name another account. The optional
 * JSON body may only carry a fresh Sign in with Apple authorization code, whose
 * tokens are revoked once the account is gone. There is no undo, so every
 * guard runs before anything is deleted. Not exposed as an MCP tool — a
 * destructive account deletion must not be reachable with an API key.
 */
export async function DELETE(request: NextRequest) {
  const deadline = Date.now() + maxDuration * 1_000 - RESPONSE_MARGIN_MS;
  const { user, error: authError } = await authenticateAccountRequest(request);
  if (authError) return authError;
  const userId = user.id;

  const appleGrant = await readAppleRevocationGrant(request, userId);
  const admin = createAdminClient();

  const lastAdminError = await rejectLastAdmin(admin, userId);
  if (lastAdminError) return lastAdminError;

  const result = await deleteUserAccount(admin, userId);
  if (!result.ok) {
    return errorResponse(
      result.stage === "storage" ? STORAGE_FAILED_MESSAGE : DELETE_FAILED_MESSAGE,
      500,
    );
  }

  // Only once the account is really gone, and best-effort: revokeAppleSignIn
  // never throws and reports its own failures, so the deletion stands either way.
  // The identities come from the user verified above; the auth user no longer exists.
  if (appleGrant) {
    await revokeAppleSignIn(appleGrant, {
      key: getAppleSignInKey(),
      appleSubjects: appleSubjectsOf(user),
      userId,
      deadline,
    });
  }

  return NextResponse.json({ success: true });
}

/**
 * Refuses to delete the only admin, so nobody is left to approve new signups.
 *
 * Accepted race: two admins deleting themselves at the same moment could both
 * pass this count and leave zero admins. There is a single admin today, and an
 * admin can still be restored by setting `profiles.is_admin` in the dashboard.
 */
async function rejectLastAdmin(
  admin: SupabaseClient<Database>,
  userId: string,
): Promise<NextResponse | null> {
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    Sentry.captureException(profileError, {
      extra: { where: "account-delete:profileLookup", userId },
    });
    return errorResponse(DELETE_FAILED_MESSAGE, 500);
  }

  // A missing profile cannot be an admin.
  if (!profile?.is_admin) return null;

  const { count, error: countError } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("is_admin", true);

  if (countError || count === null) {
    // A null count without an error has nothing to capture, so report it as its own error.
    Sentry.captureException(countError ?? new Error("Admin count came back empty"), {
      extra: { where: "account-delete:adminCount", userId },
    });
    return errorResponse(DELETE_FAILED_MESSAGE, 500);
  }

  if (count <= 1) {
    return errorResponse(
      "You are the only admin. Make another user an admin before deleting your account.",
      409,
    );
  }

  return null;
}
