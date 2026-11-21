import { timingSafeEqual } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import type { NextRequest } from "next/server";
import { errorResponse, successResponse } from "@/lib/api/utils";
import { hostedUsageReadoutSchema, toSnapshotRows } from "@/lib/metrics/hosted-usage-readout";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/env";

/**
 * Receives the weekly hosting-usage readout (ADR 0091): the Mac mini reads the
 * Vercel and Supabase usage dashboards on Sunday evening and POSTs the figures
 * here with `Authorization: Bearer $HOSTED_USAGE_SECRET`. That secret is this
 * route's alone (not CRON_SECRET), so it can't run any other cron job, and this
 * route can only add readings.
 *
 * `/api/cron` is a public route: the middleware verifies no session here, so the
 * secret is the only way in.
 */
function hasReadoutSecret(request: NextRequest, secret: string): boolean {
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function POST(request: NextRequest) {
  const secret = env.HOSTED_USAGE_SECRET;
  if (!secret) {
    Sentry.captureMessage(
      "HOSTED_USAGE_SECRET is not set: the usage readout can't be stored",
      "error",
    );
    return errorResponse("Hosted usage is not configured", 500);
  }
  if (!hasReadoutSecret(request, secret)) return errorResponse("Unauthorized", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Body must be JSON", 400);
  }
  const parsed = hostedUsageReadoutSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return errorResponse(
      `Invalid readout: ${issue?.path.join(".") || "body"} ${issue?.message ?? ""}`.trim(),
      400,
    );
  }

  let admin;
  try {
    admin = createAdminClient("web-cron");
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "hosted-usage:client" } });
    return errorResponse("Hosted usage is not configured", 500);
  }

  const rows = toSnapshotRows(parsed.data);
  // hosted_usage_snapshots isn't in the shared Database type (a web-only,
  // service-role table), so the table name and rows are cast here.
  const { error } = await admin.from("hosted_usage_snapshots" as never).insert(rows as never);
  if (error) {
    Sentry.captureException(new Error(`hosted_usage_snapshots insert failed: ${error.message}`), {
      extra: { where: "hosted-usage:insert", code: error.code },
    });
    return errorResponse("Failed to store the readout", 500);
  }
  return successResponse({ inserted: rows.length }, 201);
}
