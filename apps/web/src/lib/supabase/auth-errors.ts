import { isAuthApiError, isAuthSessionMissingError } from "@supabase/supabase-js";

/**
 * True when a `getUser()` error only means the request has no usable session: no session
 * cookie at all, or a token the Auth API rejected as invalid or expired (401/403). Callers
 * send the visitor to sign in. Any other error, including Auth API server failures (5xx)
 * and network errors, returns false so it can propagate to Sentry.
 */
export function isSignedOutAuthError(error: unknown): boolean {
  if (isAuthSessionMissingError(error)) return true;
  return isAuthApiError(error) && (error.status === 401 || error.status === 403);
}
