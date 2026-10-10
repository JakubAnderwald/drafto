/**
 * Paths whose query string never goes to analytics. `/auth/*` URLs carry one-time
 * auth codes and provider errors (the desktop hand-off pages, the OAuth callback).
 */
const QUERY_REDACTED_PREFIX = "/auth/";

/** The `$current_url` sent with a PostHog pageview. */
export function buildPageviewUrl(origin: string, pathname: string, search: string): string {
  if (!search || pathname.startsWith(QUERY_REDACTED_PREFIX)) {
    return origin + pathname;
  }
  return `${origin}${pathname}?${search}`;
}
