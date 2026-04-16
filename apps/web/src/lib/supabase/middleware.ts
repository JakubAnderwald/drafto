import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import type { Database } from "@/lib/supabase/database.types";

const PUBLIC_ROUTES = [
  "/login",
  "/signup",
  "/auth/callback",
  "/forgot-password",
  "/reset-password",
  "/api/health",
  "/api/mcp",
];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + "/"));
}

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Fast-path: MCP uses Bearer token auth, skip Supabase session lookup
  if (pathname === "/api/mcp" || pathname.startsWith("/api/mcp/")) {
    return NextResponse.next({ request });
  }

  // Track cookies set by Supabase SSR so we can re-apply them
  // if we replace supabaseResponse later (e.g., to inject auth headers).
  let pendingCookies: Array<{ name: string; value: string; options?: Record<string, unknown> }> =
    [];

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          pendingCookies = cookiesToSet;
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) => {
            supabaseResponse.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Public routes: allow access regardless of auth state
  if (isPublicRoute(pathname)) {
    return supabaseResponse;
  }

  // No user: redirect to login
  if (!user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  // Check if user is approved
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_approved")
    .eq("id", user.id)
    .single();

  if (profileError) {
    console.error("[middleware] Profile query failed:", profileError);
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  // Waiting-for-approval page: allow unapproved users to see it
  if (pathname === "/waiting-for-approval") {
    if (profile?.is_approved) {
      // Approved users shouldn't be on this page
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = "/";
      return NextResponse.redirect(homeUrl);
    }
    return supabaseResponse;
  }

  // Unapproved user trying to access app: redirect to waiting page
  if (!profile?.is_approved) {
    const waitingUrl = request.nextUrl.clone();
    waitingUrl.pathname = "/waiting-for-approval";
    return NextResponse.redirect(waitingUrl);
  }

  // Forward verified auth state to route handlers so they can skip
  // the redundant getUser() + profiles query (already validated above).
  // Safe: Next.js middleware controls the request object — clients cannot
  // forge these headers because middleware overwrites them before forwarding.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-verified-user-id", user.id);
  requestHeaders.set("x-verified-user-email", user.email ?? "");
  supabaseResponse = NextResponse.next({
    request: { headers: requestHeaders },
  });
  // Re-apply Supabase auth cookies that were set during session refresh
  for (const { name, value, options } of pendingCookies) {
    supabaseResponse.cookies.set(name, value, options);
  }

  return supabaseResponse;
}
