import { env } from "@/env";
import {
  buildContentSecurityPolicy,
  createNonce,
  CSP_HEADER,
  NONCE_HEADER,
  setsOwnContentSecurityPolicy,
} from "@/lib/security/content-security-policy";
import { updateSession } from "@/lib/supabase/middleware";
import type { NextRequest } from "next/server";

// The request headers that choose the nonce a page renders with. Next.js falls back to the
// report-only policy when there is no enforced one, so a client's copy of any of them goes.
const CLIENT_NONCE_HEADERS = [NONCE_HEADER, CSP_HEADER, "content-security-policy-report-only"];

export async function middleware(request: NextRequest) {
  for (const name of CLIENT_NONCE_HEADERS) {
    request.headers.delete(name);
  }

  if (setsOwnContentSecurityPolicy(request.nextUrl.pathname)) {
    return await updateSession(request);
  }

  // A fresh nonce and policy per request (ADR-0069). They travel on `request.headers`, which
  // every response `updateSession` builds forwards to the page, the way it forwards refreshed
  // Supabase cookies.
  const nonce = createNonce();
  const policy = buildContentSecurityPolicy({
    nonce,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    posthogHost: env.NEXT_PUBLIC_POSTHOG_HOST,
    isDevelopment: process.env.NODE_ENV === "development",
  });
  request.headers.set(NONCE_HEADER, nonce);
  request.headers.set(CSP_HEADER, policy);

  const response = await updateSession(request);
  response.headers.set(CSP_HEADER, policy);
  return response;
}

export const config = {
  // These paths skip middleware. All of them are public and need no session. Each middleware
  // run also bills Vercel Active CPU, which the Hobby plan caps at 4h / 30 days.
  // - `/api/health`: Sentry's uptime monitor polls it around the clock.
  // - `/api/mcp`: MCP clients authenticate with a Bearer API key that the route checks itself,
  //   and never send a session cookie. A client with a bad key retries every minute or so, which
  //   made it most of the team's middleware runs.
  // - MCP OAuth probing, which such a client runs after every 401. None of these paths is a
  //   route, so they get a 404 instead of a 307 to /login and a second middleware run:
  //   `/.well-known/oauth-*` and `/.well-known/openid-configuration` (discovery), then `/register`,
  //   `/authorize` and `/token` (the MCP SDK's fallbacks when discovery finds nothing). The 404
  //   still renders per request, because the root layout reads the CSP nonce (ADR-0069).
  // - `/robots.txt`, `/sitemap.xml`: crawlers fetch them signed out, so the session check
  //   would send them to /login instead.
  // - The two `/.well-known` app-link association files: Apple and Google fetch them signed
  //   out and don't follow redirects, so a 307 to /login breaks Universal Links and App Links.
  // Each exclusion is anchored with `$` (or bounded to a prefix like `oauth-`), so lookalike
  // paths and any future `/.well-known/*` route still get a session, except under the explicit
  // `oauth-*` and `openid-configuration` exclusions: a route added there would get no session and
  // must authenticate itself, never through `x-verified-*` headers. `/api/health`, `/api/mcp`,
  // the two crawler files and the two association files are also in PUBLIC_ROUTES, in case a
  // matcher edit ever drops one of them; the OAuth paths are not, and would go back to /login.
  // The skipped paths get `next.config.ts`'s static security headers but no CSP. Of them, only
  // the OAuth probes' 404 is a page with scripts, and with no CSP those scripts run unblocked.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health$|api/mcp(?:/|$)|register$|authorize$|token$|robots\\.txt$|sitemap\\.xml$|\\.well-known/(?:apple-app-site-association$|assetlinks\\.json$|oauth-|openid-configuration$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
