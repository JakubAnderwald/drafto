import type { NextRequest, NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { errorResponse } from "@/lib/api/utils";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type AccountRequestAuth = { user: User; error: null } | { user: null; error: NextResponse };

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

/**
 * Resolves the caller of an account-level route to a verified Supabase user.
 *
 * - Native apps send `Authorization: Bearer <Supabase access token>`, verified
 *   with the service-role client. Once an `Authorization` header is present it
 *   must be a valid bearer token: there is no cookie fallback, so a bad token
 *   can never be rescued by an unrelated session.
 * - The web app sends no `Authorization` header and is verified from its
 *   session cookie.
 *
 * The user, and so the id, only ever comes from a verified token or session. The
 * `x-verified-user-*` headers are deliberately ignored: middleware passes
 * client headers through untouched on public routes, so they can be forged.
 * Approval is not required — an unapproved user may delete their own account.
 */
export async function authenticateAccountRequest(
  request: NextRequest,
): Promise<AccountRequestAuth> {
  const authorization = request.headers.get("authorization");

  if (authorization !== null) {
    const token = BEARER_PATTERN.exec(authorization.trim())?.[1];
    if (!token) return unauthorized();

    const {
      data: { user },
      error,
    } = await createAdminClient().auth.getUser(token);
    if (error || !user) return unauthorized();
    return { user, error: null };
  }

  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return unauthorized();
  return { user, error: null };
}

function unauthorized(): AccountRequestAuth {
  return { user: null, error: errorResponse("Unauthorized", 401) };
}
