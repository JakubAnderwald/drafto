import type { Event } from "@sentry/nextjs";

/**
 * Routes whose requests carry a Sign in with Apple authorization code: the
 * `DELETE /api/account` body (`{ apple: { authorizationCode } }`) and Apple's form
 * post to the revocation relay. A code is a credential until the server redeems it.
 */
export const APPLE_GRANT_PATHS: readonly string[] = ["/api/account", "/auth/apple/revocation"];

function pathOf(url: string): string | null {
  try {
    return new URL(url, "http://localhost").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
}

function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Drops the request body and query string from a Sentry event for those routes,
 * so no Apple code can reach Sentry through an attached request. Other events
 * are returned unchanged. Pure: it returns a copy and never mutates the event.
 */
export function scrubAppleGrantRequest<T extends Event>(event: T): T {
  const request = event.request;
  if (!request?.url) return event;
  const path = pathOf(request.url);
  if (path === null || !APPLE_GRANT_PATHS.includes(path)) return event;

  const scrubbed = { ...request, url: withoutQuery(request.url) };
  delete scrubbed.data;
  delete scrubbed.query_string;
  return { ...event, request: scrubbed };
}
