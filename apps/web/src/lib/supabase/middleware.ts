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
  // Sign in with Apple's return URL for account deletion on Android and macOS: Apple POSTs
  // the answer cross-site, so the request carries no session. The route relays it to the app.
  "/auth/apple/revocation",
  "/forgot-password",
  "/reset-password",
  // `config.matcher` in `middleware.ts` already skips these two, so the entries are a backstop.
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

// @supabase/ssr names its cookies `sb-<project ref>-auth-token` (chunked as `.0`, `.1`…, plus
// `-code-verifier` during PKCE) unless a client sets `cookieOptions.name`. None of ours do
// (`client.ts`, `server.ts`, this file). If one ever does, change this check with it, or every
// signed-in request is treated as signed out.
function hasSupabaseCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some(({ name }) => name.startsWith("sb-"));
}

// An API call made with `fetch()`. Browsers send `Sec-Fetch-Mode: navigate` only when they load a
// page, which an `/api/*` URL is only for the emailed one-click approval link
// (`/api/admin/approve-user/one-click`). That link keeps the redirect, so a signed-out admin
// lands on the login page instead of a raw JSON error. `fetch()` never sends `navigate`.
function isApiRequest(request: NextRequest): boolean {
  return (
    request.nextUrl.pathname.startsWith("/api/") &&
    request.headers.get("sec-fetch-mode") !== "navigate"
  );
}

type ApiDenial = { status: 401 | 403; error: string };

const UNAUTHORIZED: ApiDenial = { status: 401, error: "Unauthorized" };
const FORBIDDEN: ApiDenial = { status: 403, error: "Forbidden" };

// Turns away a request the gate below doesn't let through. A page gets a 307 to `pagePath`. An API
// call gets a JSON error instead: `fetch()` follows redirects, so a 307 would hand the caller the
// login page's HTML (a 200, or a 405 for a non-GET) and the client would never see the 401 that
// `handleAuthError` (`src/lib/handle-auth-error.ts`) acts on.
function denyRequest(request: NextRequest, apiDenial: ApiDenial, pagePath: string): NextResponse {
  if (isApiRequest(request)) {
    return NextResponse.json({ error: apiDenial.error }, { status: apiDenial.status });
  }
  const url = request.nextUrl.clone();
  url.pathname = pagePath;
  return NextResponse.redirect(url);
}

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

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

  // Without a Supabase cookie there is no session, so getUser() could only return no user. Skip
  // building the client: crawlers, bot probes and signed-out visitors take this path, and each
  // middleware run bills Vercel Active CPU. They then take the same signed-out branches below.
  const supabase = hasSupabaseCookie(request)
    ? createServerClient<Database>(
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
      )
    : null;

  const user = supabase ? (await supabase.auth.getUser()).data.user : null;

  // Public routes: allow access regardless of auth state
  if (isPublicRoute(pathname)) {
    return supabaseResponse;
  }

  // Signed-out `/` is the public landing page; signed-in users get the app at the same URL.
  // A rewrite keeps the URL and answers 200. The old 307 to /login made Google index the login
  // form under `/` and ignore /login's own canonical. When the session lookup cleared a stale
  // cookie, Supabase's no-cache headers go with it. Unlike `next()`, a bare `rewrite()` forwards
  // no request headers, so they are passed explicitly: the page renders with the CSP nonce
  // `middleware.ts` put on them.
  if (!user && pathname === "/") {
    const landingUrl = request.nextUrl.clone();
    landingUrl.pathname = LANDING_PAGE_PATH;
    const landingResponse = NextResponse.rewrite(landingUrl, {
      request: { headers: request.headers },
    });
    for (const { name, value, options } of pendingCookies) {
      landingResponse.cookies.set(name, value, options);
    }
    for (const [name, value] of Object.entries(pendingHeaders)) {
      landingResponse.headers.set(name, value);
    }
    return landingResponse;
  }

  // No user: an API call gets 401, a page goes to login. (A user implies a client; the check just
  // narrows the type.)
  if (!user || !supabase) {
    return denyRequest(request, UNAUTHORIZED, "/login");
  }

  // Check if user is approved
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_approved")
    .eq("id", user.id)
    .single();

  if (profileError) {
    console.error("[middleware] Profile query failed:", profileError);
    return denyRequest(request, UNAUTHORIZED, "/login");
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

  // Unapproved user: an API call gets 403, a page goes to the waiting page
  if (!profile?.is_approved) {
    return denyRequest(request, FORBIDDEN, "/waiting-for-approval");
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
