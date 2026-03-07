/**
 * Check if a fetch response indicates an expired session (401).
 * If so, redirect to the login page.
 * Returns true if the response was a 401 (caller should stop processing).
 */
export function handleAuthError(res: Response): boolean {
  if (res.status === 401) {
    window.location.href = "/login";
    return true;
  }
  return false;
}
