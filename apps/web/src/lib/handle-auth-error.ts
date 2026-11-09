/**
 * Check whether a fetch response means the session has expired. If so, send the browser to the
 * login page.
 *
 * Middleware answers a signed-out `/api/*` fetch with a 401 JSON body
 * (`src/lib/supabase/middleware.ts`). A response that `fetch()` followed through a redirect to
 * `/login` means the same thing, so it is treated as a 401 too, in case such a redirect still
 * reaches the client (a cached or proxied response).
 *
 * Returns true when the session has expired (the caller should stop processing the response).
 */
export function handleAuthError(res: Response): boolean {
  if (res.status === 401 || wasRedirectedToLogin(res)) {
    window.location.href = "/login";
    return true;
  }
  return false;
}

function wasRedirectedToLogin(res: Response): boolean {
  if (!res.redirected) return false;
  try {
    return new URL(res.url, window.location.origin).pathname === "/login";
  } catch {
    // A malformed URL can't be the login page.
    return false;
  }
}
