import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { megabytesToBytes } from "@drafto/shared";
import { getAuthenticatedUserFast, errorResponse, isUuid } from "@/lib/api/utils";

/** The largest quota the admin page can set: 1,000,000 MB, about 1 TB. */
const MAX_QUOTA_MB = 1_000_000;

type QuotaInput = { ok: true; quotaMb: number | null } | { ok: false; message: string };

/** `null` means unlimited; anything else must be a whole number of megabytes. */
function parseQuotaMb(value: unknown): QuotaInput {
  if (value === null) return { ok: true, quotaMb: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { ok: false, message: "quotaMb must be a positive whole number of MB, or null" };
  }
  if (value > MAX_QUOTA_MB) {
    return { ok: false, message: `quotaMb must be at most ${MAX_QUOTA_MB} MB` };
  }
  return { ok: true, quotaMb: value };
}

/**
 * Sets a user's attachment storage quota (issue #794). Admins only.
 *
 * The update runs through the admin's own session, not the service role, so the
 * profiles privilege guard and the "Admins can update all profiles" policy decide
 * whether it lands. The database enforces the quota itself.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const userId = record.userId;
  if (typeof userId !== "string" || !isUuid(userId)) {
    return errorResponse("userId must be a valid UUID", 400);
  }

  if (!("quotaMb" in record)) {
    return errorResponse("quotaMb is required (a whole number of MB, or null for unlimited)", 400);
  }
  const quota = parseQuotaMb(record.quotaMb);
  if (!quota.ok) {
    return errorResponse(quota.message, 400);
  }

  const storageQuotaBytes = quota.quotaMb === null ? null : megabytesToBytes(quota.quotaMb);

  const { data: updated, error: updateError } = await supabase
    .from("profiles")
    .update({ storage_quota_bytes: storageQuotaBytes })
    .eq("id", userId)
    .select("id, storage_quota_bytes")
    .maybeSingle();

  if (updateError) {
    return errorResponse("Failed to update storage quota", 500);
  }

  if (!updated) {
    return errorResponse("User not found", 404);
  }

  return NextResponse.json({ userId: updated.id, quotaBytes: updated.storage_quota_bytes });
}
