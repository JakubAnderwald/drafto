/**
 * Deep links back into the macOS app from the drafto.eu hand-off pages.
 *
 * Supabase ends the desktop OAuth and password-reset redirect chains on
 * `https://drafto.eu/auth/desktop/<flow>` instead of on the app's custom scheme,
 * so the browser tab lands on a real page rather than freezing mid-navigation.
 * That page forwards the result to `eu.drafto.desktop://auth/<flow>`, the path
 * the app already routes on (`apps/desktop/src/lib/oauth.ts`,
 * `apps/desktop/src/lib/auth-recovery.ts`). See ADR-0044.
 */

export const DESKTOP_FLOWS = ["callback", "recovery"] as const;

export type DesktopFlow = (typeof DESKTOP_FLOWS)[number];

const DESKTOP_SCHEME = "eu.drafto.desktop";

/**
 * The only params forwarded to the app. This is hygiene, not the security
 * boundary. Any website can open `eu.drafto.desktop://` directly, so the app
 * itself ignores session tokens in the URL and accepts only a PKCE code that
 * its own `code_verifier` can redeem (ADR-0034 amendment). The allowlist just
 * keeps this page from relaying anything else.
 */
const FORWARDED_PARAMS = ["code", "error", "error_code", "error_description"] as const;

export interface DesktopDeepLink {
  /** `eu.drafto.desktop://auth/<flow>` plus the forwarded params. */
  url: string;
  /** PKCE authorization code, when Supabase sent one. */
  code: string | null;
  /**
   * Whether Supabase sent an error instead of a code. The error text is only
   * forwarded to the app, never rendered: it is attacker-controlled page content.
   */
  hasError: boolean;
}

export function isDesktopFlow(value: string): value is DesktopFlow {
  return (DESKTOP_FLOWS as readonly string[]).includes(value);
}

function stripPrefix(raw: string, prefix: string): string {
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

/**
 * Builds the app deep link from the hand-off page's `location.search` and
 * `location.hash`. Supabase puts some errors (an expired reset link) in the
 * fragment, which the server never sees, so both are read. The fragment wins a
 * collision, matching the desktop parser.
 */
export function buildDesktopDeepLink(
  flow: DesktopFlow,
  search: string,
  hash: string,
): DesktopDeepLink {
  const query = new URLSearchParams(stripPrefix(search, "?"));
  const fragment = new URLSearchParams(stripPrefix(hash, "#"));

  const forwarded = new URLSearchParams();
  for (const key of FORWARDED_PARAMS) {
    const value = fragment.get(key) ?? query.get(key);
    if (value) forwarded.set(key, value);
  }

  const params = forwarded.toString();
  return {
    url: `${DESKTOP_SCHEME}://auth/${flow}${params ? `?${params}` : ""}`,
    code: forwarded.get("code"),
    hasError: forwarded.has("error") || forwarded.has("error_description"),
  };
}
