import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { megabytesToBytes } from "@drafto/shared";
import { getAuthenticatedUserFast, errorResponse, isUuid } from "@/lib/api/utils";
import type { Database } from "@/lib/supabase/database.types";

/** The largest quota the admin page can set: 1,000,000 MB, about 1 TB. */
const MAX_QUOTA_MB = 1_000_000;

type QuotaInput = { ok: true; bytes: number | null } | { ok: false; message: string };

/** `null` means unlimited; anything else must be a whole number of megabytes. */
function parseQuotaMb(field: string, value: unknown): QuotaInput {
  if (value === null) return { ok: true, bytes: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { ok: false, message: `${field} must be a positive whole number of MB, or null` };
  }
  if (value > MAX_QUOTA_MB) {
    return { ok: false, message: `${field} must be at most ${MAX_QUOTA_MB} MB` };
  }
  return { ok: true, bytes: megabytesToBytes(value) };
}

/** The 500 message for a failed update, naming what it tried to change. */
function updateFailedMessage(setsStorage: boolean, setsContent: boolean): string {
  if (setsStorage && setsContent) return "Failed to update quotas";
  return setsContent ? "Failed to update notes quota" : "Failed to update storage quota";
}

type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];

/** The profile columns a request sets, or an error message. Each field is optional; one is required. */
function parseQuotaUpdate(
  record: Record<string, unknown>,
): { ok: true; update: ProfileUpdate } | { ok: false; message: string } {
  if (!("quotaMb" in record) && !("contentQuotaMb" in record)) {
    return {
      ok: false,
      message:
        "quotaMb or contentQuotaMb is required (a whole number of MB, or null for unlimited)",
    };
  }
  const update: ProfileUpdate = {};
  if ("quotaMb" in record) {
    const quota = parseQuotaMb("quotaMb", record.quotaMb);
    if (!quota.ok) return quota;
    update.storage_quota_bytes = quota.bytes;
  }
  if ("contentQuotaMb" in record) {
    const quota = parseQuotaMb("contentQuotaMb", record.contentQuotaMb);
    if (!quota.ok) return quota;
    update.content_quota_bytes = quota.bytes;
  }
  return { ok: true, update };
}

/**
 * Sets a user's attachment storage quota (issue #794, `quotaMb`) and/or note content
 * quota (ADR 0090, `contentQuotaMb`). Admins only. The response carries `quotaBytes`
 * and/or `contentQuotaBytes` for the fields that were set.
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

  const parsed = parseQuotaUpdate(record);
  if (!parsed.ok) {
    return errorResponse(parsed.message, 400);
  }
  const { update } = parsed;
  const setsStorage = "storage_quota_bytes" in update;
  const setsContent = "content_quota_bytes" in update;
  const columns = [
    "id",
    ...(setsStorage ? ["storage_quota_bytes"] : []),
    ...(setsContent ? ["content_quota_bytes"] : []),
  ].join(", ");

  const { data, error: updateError } = await supabase
    .from("profiles")
    .update(update)
    .eq("id", userId)
    .select(columns)
    .maybeSingle();

  if (updateError) {
    return errorResponse(updateFailedMessage(setsStorage, setsContent), 500);
  }

  // `columns` is built at runtime, so the row's type can't be inferred from it.
  const updated = data as unknown as {
    id: string;
    storage_quota_bytes?: number | null;
    content_quota_bytes?: number | null;
  } | null;
  if (!updated) {
    return errorResponse("User not found", 404);
  }

  return NextResponse.json({
    userId: updated.id,
    ...(setsStorage ? { quotaBytes: updated.storage_quota_bytes ?? null } : {}),
    ...(setsContent ? { contentQuotaBytes: updated.content_quota_bytes ?? null } : {}),
  });
}
