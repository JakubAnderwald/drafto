/**
 * Parsing for the app's own `drafto://` deep links (auth callbacks, password
 * recovery).
 *
 * Deliberately hand-rolled rather than using `URL` / `URLSearchParams`: React
 * Native ships partial implementations of both, and WHATWG parsing treats the
 * first path segment of a custom scheme as the host.
 */

export const APP_SCHEME_PREFIX = "drafto://";

export interface AppDeepLink {
  /** Path after the scheme, lower-cased, without leading or trailing slashes. */
  path: string;
  /** Query and fragment params merged; a fragment value wins a collision. */
  params: Map<string, string>;
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // A malformed escape sequence must not take down the whole callback.
    return value;
  }
}

function parseParams(raw: string, into: Map<string, string>): Map<string, string> {
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const key = separator === -1 ? pair : pair.slice(0, separator);
    const value = separator === -1 ? "" : pair.slice(separator + 1);
    into.set(decodeComponent(key), decodeComponent(value));
  }
  return into;
}

/**
 * Splits `drafto://<path>?<query>#<fragment>`, or returns `null` for any other
 * scheme. URL schemes are case-insensitive per RFC 3986, so the match is too.
 */
export function parseAppDeepLink(url: string): AppDeepLink | null {
  if (!url.toLowerCase().startsWith(APP_SCHEME_PREFIX)) {
    return null;
  }

  const rest = url.slice(APP_SCHEME_PREFIX.length);
  const hashAt = rest.indexOf("#");
  const beforeHash = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : rest.slice(hashAt + 1);

  const queryAt = beforeHash.indexOf("?");
  const rawPath = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);

  // Query first, fragment second: Supabase can put an error (an expired link) in
  // the fragment, so it wins any collision.
  const params = parseParams(query, new Map<string, string>());
  parseParams(fragment, params);

  return { path: rawPath.replace(/^\/+|\/+$/g, "").toLowerCase(), params };
}
