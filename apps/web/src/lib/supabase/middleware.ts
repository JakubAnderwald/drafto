import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import type { Database } from "@/lib/supabase/database.types";

const PUBLIC_ROUTES = [
  "/login",
  "/signup",
  "/auth/callback",
  // macOS app sign-in and password-reset hand-off pages: the browser that lands here is
  // signed out — the session belongs to the app, not to drafto.eu.
  "/auth/desktop",
  // The factory browser runner's one-time-link sign-in: the browser that lands here is signed
  // out. The route itself answers 404 outside dev-backed Vercel previews.
  "/auth/test-sign-in",
  "/forgot-password",
  "/reset-password",
  "/api/health",
  "/api/mcp",
  "/api/webhooks",
  // Native apps call it with a bearer token and no cookie; the route authenticates itself.
  "/api/account",
  // Public account-deletion explainer that store reviewers must reach signed out.
  "/account/delete",
  // Legal and support pages: the store listings link here, so App Store / Play reviewers
  // and signed-out visitors must reach them. Prefix match: any future /privacy/* or
  // /support/* route is public too — keep those static.
  "/privacy",
  "/support",
  // Fetched signed out by crawlers and the Apple / Google app-link verifiers, none of which
  // follow a redirect to /login. `config.matcher` in `middleware.ts` already skips these, so
  // this entry is only a backstop.
  "/robots.txt",
  "/sitemap.xml",
  "/.well-known/apple-app-site-association",
  "/.well-known/assetlinks.json",
];

// Where signed-out `/` is rewritten to (`src/app/welcome/page.tsx`).
const LANDING_PAGE_PATH = "/welcome";

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + "/"));
}

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Fast-path: MCP uses Bearer token auth, skip Supabase session lookup
  if (pathname === "/api/mcp" || pathname.startsWith("/api/mcp/")) {
    return NextResponse.next({ request });
  }

  // The landing page's own route is reached only through the rewrite of signed-out `/` below,
  // which doesn't pass through middleware again. A direct visit goes to `/`, so the page has a
  // single public URL.
  if (pathname === LANDING_PAGE_PATH) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/";
    return NextResponse.redirect(homeUrl, 308);
  }

  // Track cookies set by Supabase SSR so we can re-apply them
  // if we replace supabaseResponse later (e.g., to inject auth headers).
  let pendingCookies: Array<{ name: string; value: string; options?: Record<string, unknown> }> =
    [];
  // The no-cache headers Supabase sends with any auth-cookie write, so a cache never stores a
  // response that sets someone's session.
  let pendingHeaders: Record<string, string> = {};

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: {
        headers: { "x-drafto-client": "web" },
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          pendingCookies = cookiesToSet;
          pendingHeaders = { ...pendingHeaders, ...headers };
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

  // Signed-out `/` is the public landing page; signed-in users get the app at the same URL.
  // A rewrite keeps the URL and answers 200. The old 307 to /login made Google index the login
  // form under `/` and ignore /login's own canonical. The landing page is static, so when the
  // session lookup cleared a stale cookie, Supabase's no-cache headers go with it.
  if (!user && pathname === "/") {
    const landingUrl = request.nextUrl.clone();
    landingUrl.pathname = LANDING_PAGE_PATH;
    const landingResponse = NextResponse.rewrite(landingUrl);
    for (const { name, value, options } of pendingCookies) {
      landingResponse.cookies.set(name, value, options);
    }
    for (const [name, value] of Object.entries(pendingHeaders)) {
      landingResponse.headers.set(name, value);
    }
    return landingResponse;
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
