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
  const { data: updated, error: updateError } = await admin
    .from("profiles")
    .update({ is_approved: true })
    .eq("id", verified.userId)
    .select("id, display_name")
    .maybeSingle();

  if (updateError) {
    Sentry.captureException(updateError, {
      extra: { where: "approve-one-click:update", userId: verified.userId },
    });
    return errorRedirect("update_failed");
  }

  if (!updated) {
    return errorRedirect("user_not_found");
  }

  let approvedEmail: string | undefined;
  try {
    const { data: approvedUser } = await admin.auth.admin.getUserById(verified.userId);
    approvedEmail = approvedUser.user?.email ?? undefined;
    if (approvedEmail) {
      const content = userApprovedEmail({
        displayName: updated.display_name,
        loginUrl: `${env.APP_URL}/login`,
      });
      await sendEmail({
        to: approvedEmail,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
    }
  } catch (err) {
    Sentry.captureException(err, {
      extra: { where: "approve-one-click:notify-user", userId: verified.userId },
    });
  }

  const redirectUrl = new URL("/admin", env.APP_URL);
  if (approvedEmail) redirectUrl.searchParams.set("approved", approvedEmail);
  return NextResponse.redirect(redirectUrl);
}

function errorRedirect(reason: string): NextResponse {
  const url = new URL("/admin", env.APP_URL);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}
