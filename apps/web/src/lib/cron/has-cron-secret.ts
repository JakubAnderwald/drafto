import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { env } from "@/env";

/**
 * True when the request carries `Authorization: Bearer $CRON_SECRET`, the header Vercel
 * Cron sends. Constant-time: `/api/cron` is a public route, so anyone can try tokens
 * against it. False when `CRON_SECRET` isn't set.
 */
export function hasCronSecret(request: NextRequest): boolean {
  const cronSecret = env.CRON_SECRET;
  if (!cronSecret) return false;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Vercel Cron's user agent, `vercel-cron/1.0`. Not proof of anything: only for alerting. */
export function isVercelCronCaller(request: NextRequest): boolean {
  return (request.headers.get("user-agent") ?? "").startsWith("vercel-cron/");
}
