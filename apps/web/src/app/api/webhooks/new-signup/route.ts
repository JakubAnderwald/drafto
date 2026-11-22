import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { env } from "@/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAdminEmails } from "@/lib/auth/list-admin-emails";
import { sendEmail } from "@/lib/email/client";
import { newSignupAdminEmail } from "@/lib/email/templates";

interface WebhookPayload {
  type: string;
  table: string;
  schema: string;
  record: { id: string; is_approved?: boolean; display_name?: string | null } | null;
}

/** Every admin, or the fallback address when there are none (or they can't be listed). */
async function resolveAdminRecipients(
  admin: ReturnType<typeof createAdminClient>,
): Promise<string[]> {
  const { emails } = await listAdminEmails(admin);
  return emails.length > 0 ? emails : [env.EMAIL_ADMIN_FALLBACK];
}

export async function POST(request: NextRequest) {
  if (!env.WEBHOOK_SECRET) {
    Sentry.captureMessage("new-signup webhook called without WEBHOOK_SECRET configured", {
      level: "error",
    });
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const providedSecret = request.headers.get("x-webhook-secret");
  if (providedSecret !== env.WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = (await request.json()) as WebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (payload.type !== "INSERT" || payload.table !== "profiles" || !payload.record?.id) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const { id: userId, display_name: displayName = null } = payload.record;

  try {
    const admin = createAdminClient();

    const { data: authUser, error: authError } = await admin.auth.admin.getUserById(userId);
    if (authError || !authUser.user?.email) {
      Sentry.captureException(authError ?? new Error("auth user has no email"), {
        extra: { userId },
      });
      return NextResponse.json({ ok: true, emailSent: false });
    }

    const recipients = await resolveAdminRecipients(admin);
    const adminUrl = `${env.APP_URL}/admin`;

    const content = newSignupAdminEmail({
      userEmail: authUser.user.email,
      userDisplayName: displayName,
      signupAt: new Date(authUser.user.created_at ?? Date.now()),
      adminUrl,
    });

    const result = await sendEmail({
      to: recipients,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });

    return NextResponse.json({ ok: true, emailSent: result !== null });
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "new-signup-webhook", userId } });
    return NextResponse.json({ ok: true, emailSent: false });
  }
}
