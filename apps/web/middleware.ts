import { updateSession } from "@/lib/supabase/middleware";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // `/api/health` skips middleware: Sentry's uptime monitor polls it around the clock, and
  // each middleware run bills Vercel Active CPU, which the Hobby plan caps at 4h / 30 days.
  // The route is public and needs no session, so nothing is lost. Anchored with `$` so
  // only the exact path is skipped.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
