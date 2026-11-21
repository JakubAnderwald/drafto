import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthenticatedUserFast, errorResponse, isUuid } from "@/lib/api/utils";

/**
 * Suspends an account (ADR 0094): sets `profiles.is_approved = false` through the admin's own
 * session, which the privilege guard allows for admins only. Every RLS policy and the
 * attachments bucket gate on `public.is_approved()`, so from the next request the account
 * can't reach its data on any platform. Web shows the "Account not active" screen on the next
 * page load, and mobile and desktop at their next approval check (at the latest, the quiet
 * re-check on the hourly token refresh).
 * Nothing is deleted: POST /api/admin/approve-user reactivates it. An admin account can't be
 * suspended, so no admin can lock themselves or another admin out.
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
      extra: { where: "suspend-user:adminCheck", adminId: user.id },
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
    return errorResponse("You cannot suspend your own account", 400);
  }

  // `is_admin = false` in the filter, not a separate lookup first: an admin row is never
  // touched, even if it became an admin between a check and the update.
  const { data: updated, error: updateError } = await supabase
    .from("profiles")
    .update({ is_approved: false })
    .eq("id", userId)
    .eq("is_admin", false)
    .select("id")
    .maybeSingle();

  if (updateError) {
    Sentry.captureException(updateError, { extra: { where: "suspend-user:update", userId } });
    return errorResponse("Failed to suspend user", 500);
  }

  if (!updated) {
    const { data: target, error: targetError } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", userId)
      .maybeSingle();

    if (targetError) {
      Sentry.captureException(targetError, {
        extra: { where: "suspend-user:targetLookup", userId },
      });
      return errorResponse("Failed to look up user", 500);
    }
    if (target?.is_admin) {
      return errorResponse("Admin accounts cannot be suspended", 409);
    }
    return errorResponse("User not found", 404);
  }

  return NextResponse.json({ success: true });
}
