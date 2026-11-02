import { updateSession } from "@/lib/supabase/middleware";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // These paths skip middleware. All of them are public and need no session. Each middleware
  // run also bills Vercel Active CPU, which the Hobby plan caps at 4h / 30 days.
  // - `/api/health`: Sentry's uptime monitor polls it around the clock.
  // - `/api/mcp`: MCP clients authenticate with a Bearer API key that the route checks itself,
  //   and never send a session cookie. A client with a bad key retries every minute or so, which
  //   made it most of the team's middleware runs.
  // - MCP OAuth probing, which such a client runs after every 401. None of these paths is a
  //   route, so they get a static 404 instead of a 307 to /login and a second middleware run:
  //   `/.well-known/oauth-*` and `/.well-known/openid-configuration` (discovery), then `/register`,
  //   `/authorize` and `/token` (the MCP SDK's fallbacks when discovery finds nothing).
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
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health$|api/mcp(?:/|$)|register$|authorize$|token$|robots\\.txt$|sitemap\\.xml$|\\.well-known/(?:apple-app-site-association$|assetlinks\\.json$|oauth-|openid-configuration$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
