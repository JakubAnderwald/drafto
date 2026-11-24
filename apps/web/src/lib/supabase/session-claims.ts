import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";

// The signed-in user as the middleware knows it: the verified access token's `sub` and `email`.
export type VerifiedSessionUser = { id: string; email: string };

// Only the one auth method the check needs, so a test can hand in a stub.
export type ClaimsAuth = Pick<SupabaseClient["auth"], "getClaims">;

type ClaimsResult = Awaited<ReturnType<ClaimsAuth["getClaims"]>>;

// A thrown verification error goes to Sentry at most once a minute per instance. Anyone can send
// a cookie that throws, so reporting each one could use up the Sentry quota, but a runtime change
// that breaks the crypto for every real token must still show up there.
const REPORT_INTERVAL_MS = 60_000;
let lastReportedAt = Number.NEGATIVE_INFINITY;

function reportVerificationError(error: unknown): void {
  console.error("[middleware] Session verification failed:", error);
  const now = Date.now();
  if (now - lastReportedAt < REPORT_INTERVAL_MS) {
    return;
  }
  lastReportedAt = now;
  Sentry.captureException(error, { extra: { where: "middleware:session-claims" } });
}

// Verifies the session in the request's cookies without a call to Supabase Auth (ADR-0098).
//
// `getClaims()` with no argument first runs `getSession()`, which refreshes an expiring session
// and writes the new cookies through the client's `setAll`. It then checks the access token's
// signature against the project's JWKS, which auth-js caches for 10 minutes, so a warm instance
// makes no Auth request. For an HS-signed token or one without a `kid` it falls back to a
// `getUser()` call: still correct, just no saving.
//
// Returns `null` (signed out) for no session, a refresh that failed, any auth error (a bad
// signature, an expired or malformed token, a JWKS fetch failure), and a token without a user
// `sub`.
export async function getVerifiedSessionUser(
  auth: ClaimsAuth,
): Promise<VerifiedSessionUser | null> {
  let result: ClaimsResult;
  try {
    result = await auth.getClaims();
  } catch (error) {
    // auth-js re-throws errors that aren't auth errors, and a tampered cookie can reach some: an
    // unknown `alg` sent with a real `kid`, a header that isn't JSON, a key-type mismatch in
    // `crypto.subtle.importKey`. Without this catch each would answer 500 instead of signed out.
    reportVerificationError(error);
    return null;
  }

  const { data, error } = result;
  if (error || !data) {
    return null;
  }

  const { sub, email } = data.claims;
  if (typeof sub !== "string" || sub === "") {
    return null;
  }

  return { id: sub, email: typeof email === "string" ? email : "" };
}
