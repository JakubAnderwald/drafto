import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthenticatedUserFast, errorResponse } from "@/lib/api/utils";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/client";
import { userApprovedEmail } from "@/lib/email/templates";
import { env } from "@/env";

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

  const { data: updatedProfile, error: updateError } = await supabase
    .from("profiles")
    .update({ is_approved: true })
    .eq("id", userId)
    .select("id, display_name")
    .maybeSingle();

  if (updateError) {
    return errorResponse("Failed to approve user", 500);
  }

  if (!updatedProfile) {
    return errorResponse("User not found", 404);
  }

  try {
    const admin = createAdminClient();
    const { data: approvedUser, error: lookupError } = await admin.auth.admin.getUserById(userId);
    if (lookupError) {
      Sentry.captureException(lookupError, {
        extra: { where: "approve-user:getUserById", userId },
      });
    } else if (approvedUser.user?.email) {
      const content = userApprovedEmail({
        displayName: updatedProfile.display_name,
        loginUrl: `${env.APP_URL}/login`,
      });
      await sendEmail({
        to: approvedUser.user.email,
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
