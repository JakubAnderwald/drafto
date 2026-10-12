import { updateSession } from "@/lib/supabase/middleware";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // These paths skip middleware. All of them are public and need no session. Each middleware
  // run also bills Vercel Active CPU, which the Hobby plan caps at 4h / 30 days.
  // - `/api/health`: Sentry's uptime monitor polls it around the clock.
  // - `/robots.txt`, `/sitemap.xml`: crawlers fetch them signed out, so the session check
  //   would send them to /login instead.
  // - The two `/.well-known` app-link association files: Apple and Google fetch them signed
  //   out and don't follow redirects, so a 307 to /login breaks Universal Links and App Links.
  //   Only these exact files are skipped, so a future `/.well-known/*` route still gets a session.
  // Each path is anchored with `$`, so only the exact file is skipped. They are also in
  // PUBLIC_ROUTES, in case a matcher edit ever drops one of them.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health$|robots\\.txt$|sitemap\\.xml$|\\.well-known/apple-app-site-association$|\\.well-known/assetlinks\\.json$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
