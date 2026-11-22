import * as Sentry from "@sentry/nextjs";
import type { NextRequest } from "next/server";
import { errorResponse, successResponse } from "@/lib/api/utils";
import { listAdminEmails } from "@/lib/auth/list-admin-emails";
import { hasCronSecret, isVercelCronCaller } from "@/lib/cron/has-cron-secret";
import { sendEmail } from "@/lib/email/client";
import { weeklyMetricsEmail } from "@/lib/email/weekly-metrics-email";
import { loadProductMetrics } from "@/lib/metrics/load-product-metrics";
import { buildWeeklyReport, weeklyEmptiedSince } from "@/lib/metrics/weekly-report";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/env";

/** Nine metric reads in parallel, then one send per admin. */
export const maxDuration = 60;

const SUPPORT_REPLY_TO = "support@drafto.eu";

/**
 * The Monday product-metrics email (#823). Vercel Cron calls it at 06:00 UTC on
 * Mondays (`apps/web/vercel.json`) with `Authorization: Bearer $CRON_SECRET`. It reads
 * the metrics `/admin/stats` shows, and emails each admin a summary of the week that
 * just ended. It returns only `{ sent, recipients, generatedAt }`, never the metrics.
 *
 * `/api/cron` is a public route: the middleware verifies no session here, so the cron
 * secret is the only way in. Without `CRON_SECRET` every call gets a 401, and a call
 * from Vercel Cron is also reported to Sentry, since the email then never goes out.
 */
export async function GET(request: NextRequest) {
  if (!env.CRON_SECRET && isVercelCronCaller(request)) {
    Sentry.captureMessage("CRON_SECRET is not set: the Monday metrics email can't run", "error");
  }
  if (!hasCronSecret(request)) return errorResponse("Unauthorized", 401);

  let admin;
  try {
    admin = createAdminClient("web-cron");
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "weekly-metrics:client" } });
    return errorResponse("Weekly metrics are not configured", 500);
  }

  const now = new Date();
  const metrics = await loadProductMetrics({
    now,
    client: admin,
    emptiedSince: weeklyEmptiedSince(now),
  });
  const generatedAt = metrics.generatedAt;

  const { emails, failed } = await listAdminEmails(admin);
  if (failed) return errorResponse("Failed to look up the admins", 500);
  if (emails.length === 0) {
    console.warn("[weekly-metrics] no admin accounts: nothing sent");
    return successResponse({ sent: 0, recipients: 0, generatedAt });
  }

  const report = buildWeeklyReport(metrics, { now, statsUrl: `${env.APP_URL}/admin/stats` });
  const content = weeklyMetricsEmail(report);

  // One send per admin, so no admin sees another's address.
  let sent = 0;
  for (const to of emails) {
    const result = await sendEmail({ to, replyTo: SUPPORT_REPLY_TO, ...content });
    if (result) sent += 1;
  }

  if (sent < emails.length) {
    Sentry.captureException(
      new Error(`weekly-metrics: ${emails.length - sent} of ${emails.length} sends failed`),
      { extra: { where: "weekly-metrics:send", sent, recipients: emails.length } },
    );
    return successResponse({ sent, recipients: emails.length, generatedAt }, 502);
  }
  return successResponse({ sent, recipients: emails.length, generatedAt });
}
