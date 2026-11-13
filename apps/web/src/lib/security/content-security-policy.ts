/**
 * The web app's Content-Security-Policy (ADR-0069). The middleware builds one per request
 * around a fresh nonce and sends it twice:
 *
 * - on the response, where the browser enforces it;
 * - on the forwarded request, as `content-security-policy` and `x-nonce`. Next.js reads the
 *   nonce from the forwarded policy's `script-src` and puts it on its own scripts. The root
 *   layout reads `x-nonce` for the inline theme script.
 *
 * Pure: no env access, so the middleware passes in the values it reads from `@/env`.
 */

/** The forwarded request header the root layout reads the nonce from. */
export const NONCE_HEADER = "x-nonce";

/** The policy's header, on the response and on the forwarded request. */
export const CSP_HEADER = "content-security-policy";

/**
 * PostHog's API host when `NEXT_PUBLIC_POSTHOG_HOST` is unset. Keep it the same as the
 * fallback in `src/lib/posthog/client.ts`.
 */
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// PostHog loads its config, toolbar and recorder from hosts it derives from the API host
// (`us-assets.i.posthog.com` for `us.i.posthog.com`). A CSP `*.` wildcard matches subdomains
// at any depth.
const POSTHOG_SOURCE = "https://*.posthog.com";

// Sentry's EU-region ingest (`o<org>.ingest.de.sentry.io`), where the browser SDK posts its
// envelopes. There is no tunnel route, so the browser talks to Sentry directly.
const SENTRY_INGEST_SOURCE = "https://*.ingest.de.sentry.io";

/**
 * Routes that send their own CSP. The middleware puts neither its policy nor a nonce on them:
 * `next start` and Vercel keep a header the middleware set over the route handler's, so the
 * nonce policy would replace the route's own and block its hashed inline script.
 * - `/auth/apple/revocation`: `APPLE_RELAY_CSP` in `src/lib/apple/revocation-relay.ts`.
 */
const ROUTES_WITH_OWN_CSP: readonly string[] = ["/auth/apple/revocation"];

export function setsOwnContentSecurityPolicy(pathname: string): boolean {
  return ROUTES_WITH_OWN_CSP.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

/**
 * A 128-bit nonce, standard base64. Next.js only accepts a nonce matching
 * `[A-Za-z0-9+/_-]+={0,2}`. `crypto.getRandomValues` and `btoa` both exist in the edge runtime
 * the middleware runs on.
 */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export interface ContentSecurityPolicyOptions {
  nonce: string;
  /** `NEXT_PUBLIC_SUPABASE_URL`: the REST, auth, storage and realtime origin. */
  supabaseUrl: string;
  /** `NEXT_PUBLIC_POSTHOG_HOST`. Unset or unreadable falls back to `DEFAULT_POSTHOG_HOST`. */
  posthogHost?: string;
  /** `next dev`, whose React and HMR runtime need `'unsafe-eval'`. */
  isDevelopment: boolean;
}

// A host the policy can carry as it is: a hostname or a bracketed IPv6 address, then an optional
// port. `new URL()` lets `;`, `,`, `'` and `*` through in a host, and any of them would end a
// directive early or widen it.
const PLAIN_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?$/;

/** An `http(s)` URL with a plain host, or `null` for anything else. */
function plainHttpUrl(value: string | undefined): URL | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return PLAIN_HOST.test(url.host) ? url : null;
}

function supabaseSources(supabaseUrl: string): { origin: string; realtime: string } {
  const url = plainHttpUrl(supabaseUrl);
  // Fail loudly: a policy without Supabase would block every API call the app makes.
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not an http(s) URL with a plain host");
  // The realtime channel `use-note-sync.ts` opens is a WebSocket, and an `https:` source
  // doesn't match `wss:`. A local Supabase on `http:` serves it over `ws:`.
  const socketScheme = url.protocol === "http:" ? "ws:" : "wss:";
  return { origin: url.origin, realtime: `${socketScheme}//${url.host}` };
}

export function buildContentSecurityPolicy({
  nonce,
  supabaseUrl,
  posthogHost,
  isDevelopment,
}: ContentSecurityPolicyOptions): string {
  const supabase = supabaseSources(supabaseUrl);
  const posthog = plainHttpUrl(posthogHost)?.origin ?? DEFAULT_POSTHOG_HOST;

  const directives: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["default-src", ["'self'"]],
    // `'strict-dynamic'` lets the nonce'd scripts load the rest (Next's chunks, PostHog,
    // Sign in with Apple JS); browsers that support it ignore `'self'`.
    [
      "script-src",
      [
        "'self'",
        `'nonce-${nonce}'`,
        "'strict-dynamic'",
        ...(isDevelopment ? ["'unsafe-eval'"] : []),
      ],
    ],
    // No nonce here: a browser ignores `'unsafe-inline'` in a directive that has one, and
    // Mantine and BlockNote set inline styles.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // `https:` because `useAttachmentUrlResolver` passes any URL that isn't `attachment://`
    // through unchanged: BlockNote's Embed tab, pasted HTML and MCP markdown put remote URLs
    // straight into `<img>`, `<video>` and `<audio>`.
    ["img-src", ["'self'", "blob:", "data:", supabase.origin, "https:"]],
    ["media-src", ["'self'", "blob:", supabase.origin, "https:"]],
    // next/font self-hosts the Geist fonts.
    ["font-src", ["'self'"]],
    [
      "connect-src",
      ["'self'", supabase.origin, supabase.realtime, posthog, POSTHOG_SOURCE, SENTRY_INGEST_SOURCE],
    ],
    // Sentry Replay and PostHog's session recorder start their workers from `blob:` URLs.
    ["worker-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];

  return directives.map(([name, sources]) => [name, ...new Set(sources)].join(" ")).join("; ");
}
