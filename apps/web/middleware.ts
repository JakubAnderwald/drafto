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
  // - `/robots.txt`, `/sitemap.xml`: crawlers fetch them signed out, so the session check
  //   would send them to /login instead.
  // - All of `/.well-known/*`: these are machine-read files fetched signed out. Apple and Google
  //   fetch the app-link association files and don't follow redirects, so a 307 to /login breaks
  //   Universal Links and App Links. MCP clients probe the OAuth discovery paths
  //   (`/.well-known/oauth-protected-resource`, …) after every 401, and those now get a static
  //   404 instead of a 307 to /login and a second middleware run.
  // `/api/health`, `/api/mcp` and the two files are anchored, so lookalike paths still run the
  // middleware. They are also in PUBLIC_ROUTES, in case a matcher edit ever drops one of them.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health$|api/mcp(?:/|$)|robots\\.txt$|sitemap\\.xml$|\\.well-known/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
