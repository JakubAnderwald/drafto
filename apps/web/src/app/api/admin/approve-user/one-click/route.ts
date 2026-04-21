import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { env } from "@/env";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyApprovalToken } from "@/lib/approval-tokens";
import { sendEmail } from "@/lib/email/client";
import { userApprovedEmail } from "@/lib/email/templates";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return errorRedirect("missing_token");
  }

  const verified = verifyApprovalToken(token);
  if (!verified) {
    return errorRedirect("invalid_or_expired_token");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const loginUrl = new URL("/login", env.APP_URL);
    loginUrl.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  const { data: requester, error: requesterError } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();

  if (requesterError || !requester?.is_admin) {
    return errorRedirect("forbidden");
  }

  const admin = createAdminClient();
  // Only transition pending → approved. Already-approved clicks become idempotent
  // no-ops (no duplicate email, no re-update).
  const { data: updated, error: updateError } = await admin
    .from("profiles")
    .update({ is_approved: true })
    .eq("id", verified.userId)
    .eq("is_approved", false)
    .select("id, display_name")
    .maybeSingle();

  if (updateError) {
    Sentry.captureException(updateError, {
      extra: { where: "approve-one-click:update", userId: verified.userId },
    });
    return errorRedirect("update_failed");
  }

  if (!updated) {
    // Either the user doesn't exist, or they're already approved.
    const { data: existing } = await admin
      .from("profiles")
      .select("is_approved")
      .eq("id", verified.userId)
      .maybeSingle();
    if (!existing) return errorRedirect("user_not_found");
    return flagRedirect("already_approved");
  }

  let emailSent = false;
  try {
    const { data: approvedUser, error: lookupError } = await admin.auth.admin.getUserById(
      verified.userId,
    );
    if (lookupError) {
      Sentry.captureException(lookupError, {
        extra: { where: "approve-one-click:getUserById", userId: verified.userId },
      });
    } else if (approvedUser.user?.email) {
      const content = userApprovedEmail({
        displayName: updated.display_name,
        loginUrl: `${env.APP_URL}/login`,
      });
      const result = await sendEmail({
        to: approvedUser.user.email,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
      emailSent = result !== null;
    }
  } catch (err) {
    Sentry.captureException(err, {
      extra: { where: "approve-one-click:notify-user", userId: verified.userId },
    });
  }

  return flagRedirect(emailSent ? "approved" : "approved_email_failed");
}

function flagRedirect(flag: string): NextResponse {
  const url = new URL("/admin", env.APP_URL);
  url.searchParams.set("approved", flag);
  return NextResponse.redirect(url);
}

function errorRedirect(reason: string): NextResponse {
  const url = new URL("/admin", env.APP_URL);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}
