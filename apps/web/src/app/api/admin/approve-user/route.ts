import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthenticatedUserFast, errorResponse, isUuid } from "@/lib/api/utils";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/client";
import { accountActiveEmail } from "@/lib/email/templates";
import { env } from "@/env";

/**
 * Activates an account: sets `profiles.is_approved = true` through the admin's own session
 * (the privilege guard lets admins change it) and emails the user. Since open signup
 * (ADR 0094) this is for a signup still pending from before it, or for reactivating an
 * account an admin suspended (POST /api/admin/suspend-user).
 *
 * Idempotent: the update matches only an inactive row, so activating an account that is
 * already active (a second admin, a stale /admin tab) succeeds without a second email.
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

  const { data: updatedProfile, error: updateError } = await supabase
    .from("profiles")
    .update({ is_approved: true })
    .eq("id", userId)
    .eq("is_approved", false)
    .select("id, display_name")
    .maybeSingle();

  if (updateError) {
    Sentry.captureException(updateError, { extra: { where: "approve-user:update", userId } });
    return errorResponse("Failed to activate user", 500);
  }

  if (!updatedProfile) {
    const { data: target, error: targetError } = await supabase
      .from("profiles")
      .select("is_approved")
      .eq("id", userId)
      .maybeSingle();

    if (targetError) {
      Sentry.captureException(targetError, {
        extra: { where: "approve-user:targetLookup", userId },
      });
      return errorResponse("Failed to look up user", 500);
    }
    if (!target) {
      return errorResponse("User not found", 404);
    }
    // Already active: nothing changed, so no email.
    return NextResponse.json({ success: true, alreadyActive: true });
  }

  try {
    const admin = createAdminClient();
    const { data: activatedUser, error: lookupError } = await admin.auth.admin.getUserById(userId);
    if (lookupError) {
      Sentry.captureException(lookupError, {
        extra: { where: "approve-user:getUserById", userId },
      });
    } else if (activatedUser.user?.email) {
      const content = accountActiveEmail({
        displayName: updatedProfile.display_name,
        loginUrl: `${env.APP_URL}/login`,
      });
      await sendEmail({
        to: activatedUser.user.email,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
    }
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "approve-user:notify", userId } });
  }

  return NextResponse.json({ success: true });
}
