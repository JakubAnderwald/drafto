import { timingSafeEqual } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import type { NextRequest } from "next/server";
import { getAuthenticatedUser, errorResponse, successResponse } from "@/lib/api/utils";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeOrphanedAttachments } from "@/lib/storage/remove-orphaned-attachments";
import { env } from "@/env";

/** The purge plus up to 10 listing-and-remove rounds of 1,000 files. */
export const maxDuration = 60;

/**
 * Purges notes trashed more than 30 days ago, then removes every attachment file
 * whose note is gone: the purged notes' files, and those left by mobile and
 * desktop permanent deletes, which delete rows only. pg_cron also runs the purge
 * daily at 03:00 UTC; it can't remove files, which only the Storage API does.
 *
 * Callers: Vercel Cron (GET, daily, `apps/web/vercel.json`), which sends
 * `Authorization: Bearer $CRON_SECRET`, and an admin by hand (POST).
 */
async function runCleanup() {
  let admin;
  try {
    admin = createAdminClient("web-cron");
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "cleanup-trash:client" } });
    return errorResponse("Cleanup is not configured", 500);
  }

  // Service role: cleanup_trashed_notes() isn't granted to the API roles.
  const { data, error } = await admin.rpc("cleanup_trashed_notes");
  if (error) {
    console.error("[cleanup-trash] RPC failed:", error.message);
    return errorResponse("Failed to cleanup trashed notes", 500);
  }

  const removedFiles = await removeOrphanedAttachments(admin);
  return successResponse({ deleted: data ?? 0, removedFiles });
}

/** Constant-time: the route is public, so anyone can try tokens against it. */
function hasCronSecret(request: NextRequest): boolean {
  const cronSecret = env.CRON_SECRET;
  if (!cronSecret) return false;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Vercel Cron: the cron secret only. */
export async function GET(request: NextRequest) {
  if (!env.CRON_SECRET) {
    // Vercel Cron still calls without one, so the daily purge and sweep would
    // otherwise fail every day with nothing but a 401 in the logs.
    Sentry.captureMessage("CRON_SECRET is not set: the daily trash cleanup can't run", "error");
    return errorResponse("Cron is not configured", 500);
  }
  if (!hasCronSecret(request)) return errorResponse("Unauthorized", 401);
  return runCleanup();
}

/**
 * The cron secret, or a signed-in admin. `/api/cron` is a public route (Vercel
 * Cron sends no session), so the middleware doesn't verify the session or set
 * the `x-verified-*` headers here: this checks the session itself and must never
 * use getAuthenticatedUserFast, which would trust a client's copy of them.
 */
export async function POST(request: NextRequest) {
  if (hasCronSecret(request)) return runCleanup();

  const { data: auth, error: authError } = await getAuthenticatedUser();
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

  return runCleanup();
}
