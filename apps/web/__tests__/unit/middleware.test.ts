import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock env before importing middleware
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  },
}));

const mockCaptureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException: mockCaptureException }));

const mockGetClaims = vi.fn();
// The middleware verifies the session locally with getClaims() (ADR-0098). getUser() is a call to
// Supabase Auth per request, so every test checks it is never made.
const mockGetUser = vi.fn();
const mockFrom = vi.fn();

type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };
type SetAllCookies = (cookies: CookieToSet[], headers: Record<string, string>) => void;
let setAllCookies: SetAllCookies = () => {};

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { cookies: { setAll: SetAllCookies } },
  ) => {
    setAllCookies = options.cookies.setAll;
    return {
      auth: { getClaims: mockGetClaims, getUser: mockGetUser },
      from: mockFrom,
    };
  },
}));

// Import after mocks are set up
const { updateSession } = await import("@/lib/supabase/middleware");

// A Supabase auth cookie. Without one the middleware skips the session lookup entirely.
const SESSION_COOKIE = "sb-test-auth-token=session";

// What getClaims() resolves to for a verified access token with these claims.
function signedIn(claims: Record<string, unknown> = { sub: "user-1", email: "test@test.com" }) {
  return {
    data: { claims, header: { alg: "ES256", kid: "test-kid" }, signature: new Uint8Array() },
    error: null,
  };
}

// No session, or a refresh that failed and cleared the cookies.
const SIGNED_OUT = { data: null, error: null };

function createRequest(path: string, { session = false } = {}): NextRequest {
  return new NextRequest(
    new URL(path, "http://localhost:3000"),
    session ? { headers: { cookie: SESSION_COOKIE } } : undefined,
  );
}

describe("Auth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("allows access to public routes without auth", async () => {
    mockGetClaims.mockResolvedValue(SIGNED_OUT);

    const publicRoutes = [
      "/login",
      "/signup",
      "/auth/callback",
      "/auth/desktop/callback",
      "/auth/desktop/recovery",
      "/auth/test-sign-in",
      "/auth/apple/revocation",
      "/forgot-password",
      "/reset-password",
      "/api/health",
      "/api/webhooks/new-signup",
      "/api/account",
      "/api/cron/cleanup-trash",
      "/account/delete",
      "/privacy",
      "/support",
      "/robots.txt",
      "/sitemap.xml",
      "/.well-known/apple-app-site-association",
      "/.well-known/assetlinks.json",
      "/.well-known/mcptry-verify.txt",
    ];

    for (const route of publicRoutes) {
      const response = await updateSession(createRequest(route));
      expect(response.status).toBe(200);
    }
  });

  it.each(["/privacy", "/support", "/account/delete"])(
    "serves %s to a signed-out visitor instead of redirecting to /login",
    async (route) => {
      // The store listings link to these pages, and store reviewers open them signed out.
      mockGetClaims.mockResolvedValue(SIGNED_OUT);

      const response = await updateSession(createRequest(route));

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(mockFrom).not.toHaveBeenCalled();
    },
  );

  it("does not treat a lookalike path as the public privacy page", async () => {
    mockGetClaims.mockResolvedValue(SIGNED_OUT);

    const response = await updateSession(createRequest("/privacy-settings"));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("passes a cookie-less DELETE /api/account through to the route instead of redirecting", async () => {
    // Native apps authenticate this route with a bearer token and send no cookie.
    // A redirect would be followed by fetch and land on the login page's HTML.
    mockGetClaims.mockResolvedValue(SIGNED_OUT);

    const response = await updateSession(
      new NextRequest(new URL("/api/account", "http://localhost:3000"), {
        method: "DELETE",
        headers: { Authorization: "Bearer native-access-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("passes Vercel Cron's cookie-less GET /api/cron/cleanup-trash through to the route", async () => {
    // Vercel Cron sends the cron secret as a bearer token and no cookie; the route checks it.
    mockGetClaims.mockResolvedValue(SIGNED_OUT);

    const response = await updateSession(
      new NextRequest(new URL("/api/cron/cleanup-trash", "http://localhost:3000"), {
        headers: { Authorization: "Bearer cron-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("passes Apple's cookie-less form POST to /auth/apple/revocation through to the route", async () => {
    // Apple posts the revocation answer cross-site, so no session cookie comes with it.
    const response = await updateSession(
      new NextRequest(new URL("/auth/apple/revocation", "http://localhost:3000"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "state=android.abcdefghijklmnop&code=c.apple",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(mockGetClaims).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated users to /login", async () => {
    mockGetClaims.mockResolvedValue(SIGNED_OUT);

    const response = await updateSession(createRequest("/settings"));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("serves signed-out / the landing page through a rewrite instead of redirecting", async () => {
    // A redirect to /login made Google index the login form under `/`.
    mockGetClaims.mockResolvedValue(SIGNED_OUT);

    const response = await updateSession(createRequest("/?utm_source=store"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const rewrite = new URL(response.headers.get("x-middleware-rewrite")!);
    expect(rewrite.pathname).toBe("/welcome");
    expect(rewrite.search).toBe("?utm_source=store");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("passes refreshed session cookies and their no-cache headers on with the landing page rewrite", async () => {
    // An expired session is cleared during getClaims(). The browser must still get the cleared
    // cookie, and no cache may store the static landing page together with it.
    mockGetClaims.mockImplementationOnce(async () => {
      setAllCookies([{ name: "sb-test-auth-token", value: "", options: { maxAge: 0 } }], {
        "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
        Expires: "0",
      });
      return SIGNED_OUT;
    });

    const response = await updateSession(createRequest("/", { session: true }));

    expect(response.headers.get("x-middleware-rewrite")).not.toBeNull();
    expect(response.cookies.get("sb-test-auth-token")?.value).toBe("");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
    expect(response.headers.get("expires")).toBe("0");
  });

  it("forwards the request headers with the landing page rewrite", async () => {
    // `middleware.ts` puts the CSP nonce on the request headers. A bare `rewrite()` forwards
    // none, and the landing page would render without the nonce, its scripts blocked.
    const response = await updateSession(
      new NextRequest(new URL("/", "http://localhost:3000"), {
        headers: { "x-nonce": "landing-nonce", "content-security-policy": "script-src 'none'" },
      }),
    );

    expect(response.headers.get("x-middleware-rewrite")).not.toBeNull();
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe("landing-nonce");
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(
      "script-src 'none'",
    );
  });

  it.each([
    ["/login", 200, null],
    ["/api/mcp", 200, null],
    ["/settings", 307, "/login"],
    ["/wp-admin/install.php", 307, "/login"],
  ])(
    "answers %s without a session lookup when the request has no Supabase cookie",
    async (route, status, location) => {
      // Crawlers, bot probes and signed-out visitors carry no session, and every middleware run
      // bills Vercel Active CPU, so the Supabase client is never built for them.
      const response = await updateSession(createRequest(route));

      expect(response.status).toBe(status);
      const header = response.headers.get("location");
      expect(header && new URL(header).pathname).toBe(location);
      expect(mockGetClaims).not.toHaveBeenCalled();
      expect(mockFrom).not.toHaveBeenCalled();
    },
  );

  it("rewrites cookie-less / to the landing page without a session lookup", async () => {
    const response = await updateSession(createRequest("/?utm_source=store"));

    const rewrite = new URL(response.headers.get("x-middleware-rewrite")!);
    expect(rewrite.pathname).toBe("/welcome");
    expect(rewrite.search).toBe("?utm_source=store");
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it("refuses a cookie-less request to a protected API route even with a verified-user header", async () => {
    const response = await updateSession(
      new NextRequest(new URL("/api/notes", "http://localhost:3000"), {
        headers: { "x-verified-user-id": "00000000-0000-0000-0000-000000000001" },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(response.headers.get("location")).toBeNull();
    // The forged header never reaches the route: nothing is forwarded on a refusal.
    expect(response.headers.get("x-middleware-request-x-verified-user-id")).toBeNull();
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it("still looks up the session when a Supabase cookie is present", async () => {
    mockGetClaims.mockResolvedValue(SIGNED_OUT);

    const response = await updateSession(createRequest("/settings", { session: true }));

    expect(mockGetClaims).toHaveBeenCalledOnce();
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("serves a public route to a visitor whose session cookie is stale", async () => {
    // getClaims() finds no session for the cookie. /login must still answer, not redirect to itself.
    mockGetClaims.mockResolvedValue(SIGNED_OUT);

    const response = await updateSession(createRequest("/login", { session: true }));

    expect(mockGetClaims).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("overwrites client-sent verified-user headers with the session's user", async () => {
    mockGetClaims.mockResolvedValue(signedIn());
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { is_approved: true }, error: null }),
        }),
      }),
    });

    const response = await updateSession(
      new NextRequest(new URL("/api/notes", "http://localhost:3000"), {
        headers: {
          cookie: SESSION_COOKIE,
          "x-verified-user-id": "someone-else",
          "x-verified-user-email": "someone@else.com",
        },
      }),
    );

    // NextResponse.next({ request: { headers } }) forwards each request header to the route as
    // `x-middleware-request-<name>`.
    expect(response.headers.get("x-middleware-request-x-verified-user-id")).toBe("user-1");
    expect(response.headers.get("x-middleware-request-x-verified-user-email")).toBe(
      "test@test.com",
    );
  });

  it("sends a direct visit to the landing page's route to / without a session lookup", async () => {
    const response = await updateSession(createRequest("/welcome"));

    expect(response.status).toBe(308);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/");
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it("redirects unapproved users to /waiting-for-approval", async () => {
    mockGetClaims.mockResolvedValue(signedIn());
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { is_approved: false }, error: null }),
        }),
      }),
    });

    const response = await updateSession(createRequest("/", { session: true }));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/waiting-for-approval");
  });

  it("allows approved users to access protected routes", async () => {
    mockGetClaims.mockResolvedValue(signedIn());
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { is_approved: true }, error: null }),
        }),
      }),
    });

    const response = await updateSession(createRequest("/", { session: true }));

    expect(response.status).toBe(200);
    // Signed in, `/` is the app, not the landing page.
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("allows unapproved users to see /waiting-for-approval", async () => {
    mockGetClaims.mockResolvedValue(signedIn());
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { is_approved: false }, error: null }),
        }),
      }),
    });

    const response = await updateSession(createRequest("/waiting-for-approval", { session: true }));

    expect(response.status).toBe(200);
  });

  it("redirects to /login when profile query fails", async () => {
    mockGetClaims.mockResolvedValue(signedIn());
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: { message: "DB error" } }),
        }),
      }),
    });

    const response = await updateSession(createRequest("/", { session: true }));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("redirects approved users away from /waiting-for-approval", async () => {
    mockGetClaims.mockResolvedValue(signedIn());
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { is_approved: true }, error: null }),
        }),
      }),
    });

    const response = await updateSession(createRequest("/waiting-for-approval", { session: true }));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/");
  });

  // `fetch()` follows a 307, so a redirect would hand an API caller the login page's HTML (a 200,
  // or a 405 for a non-GET) and `handleAuthError` would never see a 401 (#460).
  describe("API requests", () => {
    function signInWithProfile(result: {
      data: { is_approved: boolean } | null;
      error: { message: string } | null;
    }) {
      mockGetClaims.mockResolvedValue(signedIn());
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve(result),
          }),
        }),
      });
    }

    function apiRequest(
      path: string,
      { session = false, method = "GET", headers = {} as Record<string, string> } = {},
    ): NextRequest {
      return new NextRequest(new URL(path, "http://localhost:3000"), {
        method,
        headers: session ? { ...headers, cookie: SESSION_COOKIE } : headers,
      });
    }

    it.each([
      ["without a session cookie", false],
      ["with a stale session cookie", true],
    ])("answers a signed-out API fetch %s with 401 JSON", async (_label, session) => {
      mockGetClaims.mockResolvedValue(SIGNED_OUT);

      const response = await updateSession(apiRequest("/api/notebooks/abc/notes", { session }));

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "Unauthorized" });
      expect(response.headers.get("location")).toBeNull();
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it.each(["POST", "PATCH", "DELETE"])(
      "answers a signed-out %s API fetch with 401 JSON instead of a redirect",
      async (method) => {
        // A followed redirect turned these into a 405 from the login page.
        const response = await updateSession(
          apiRequest("/api/notes/note-1", { method, headers: { "sec-fetch-mode": "cors" } }),
        );

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "Unauthorized" });
        expect(response.headers.get("location")).toBeNull();
      },
    );

    it("answers an API fetch with 401 JSON when the profile query fails", async () => {
      signInWithProfile({ data: null, error: { message: "DB error" } });

      const response = await updateSession(apiRequest("/api/notes", { session: true }));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
      expect(response.headers.get("location")).toBeNull();
    });

    it("answers an unapproved user's API fetch with 403 JSON", async () => {
      signInWithProfile({ data: { is_approved: false }, error: null });

      const response = await updateSession(apiRequest("/api/notes", { session: true }));

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Forbidden" });
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-middleware-request-x-verified-user-id")).toBeNull();
    });

    it("still redirects an unapproved user's page request to /waiting-for-approval", async () => {
      signInWithProfile({ data: { is_approved: false }, error: null });

      const response = await updateSession(createRequest("/settings", { session: true }));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/waiting-for-approval");
    });

    it("redirects a signed-out navigation to an API URL to /login", async () => {
      // An `/api/*` URL opened as a page, not with `fetch()`: a signed-out user must reach the
      // login page, not a raw JSON error.
      const response = await updateSession(
        apiRequest("/api/storage-usage", {
          headers: { "sec-fetch-mode": "navigate" },
        }),
      );

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/login");
    });

    it("redirects an unapproved user's navigation to an API URL to /waiting-for-approval", async () => {
      signInWithProfile({ data: { is_approved: false }, error: null });

      const response = await updateSession(
        apiRequest("/api/storage-usage", {
          session: true,
          headers: { "sec-fetch-mode": "navigate" },
        }),
      );

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/waiting-for-approval");
    });

    it("treats only paths under /api/ as API calls", async () => {
      // A lookalike page path keeps the page behaviour.
      const response = await updateSession(createRequest("/apiary"));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    });

    it("lets an approved user's API fetch through to the route", async () => {
      signInWithProfile({ data: { is_approved: true }, error: null });

      const response = await updateSession(apiRequest("/api/notes", { session: true }));

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-middleware-request-x-verified-user-id")).toBe("user-1");
    });
  });

  // The session is verified locally with getClaims() (ADR-0098): anything it can't verify is
  // signed out, and a verified token's claims become the forwarded user.
  describe("session verification", () => {
    function approvedProfile() {
      const eq = vi.fn(() => ({
        single: () => Promise.resolve({ data: { is_approved: true }, error: null }),
      }));
      mockFrom.mockReturnValue({ select: () => ({ eq }) });
      return eq;
    }

    function apiFetch(path: string): NextRequest {
      return new NextRequest(new URL(path, "http://localhost:3000"), {
        headers: { cookie: SESSION_COOKIE, "sec-fetch-mode": "cors" },
      });
    }

    it("calls getClaims() without a token, so an expiring session is refreshed first", async () => {
      mockGetClaims.mockResolvedValue(signedIn());
      approvedProfile();

      await updateSession(createRequest("/settings", { session: true }));

      expect(mockGetClaims).toHaveBeenCalledOnce();
      expect(mockGetClaims).toHaveBeenCalledWith();
    });

    it("runs the profiles approval query once, for the verified sub", async () => {
      mockGetClaims.mockResolvedValue(signedIn({ sub: "user-42", email: "a@b.c" }));
      const eq = approvedProfile();

      const response = await updateSession(createRequest("/settings", { session: true }));

      expect(response.status).toBe(200);
      expect(mockFrom).toHaveBeenCalledOnce();
      expect(mockFrom).toHaveBeenCalledWith("profiles");
      expect(eq).toHaveBeenCalledOnce();
      expect(eq).toHaveBeenCalledWith("id", "user-42");
      expect(response.headers.get("x-middleware-request-x-verified-user-id")).toBe("user-42");
      expect(response.headers.get("x-middleware-request-x-verified-user-email")).toBe("a@b.c");
    });

    // An invalid, tampered or expired-without-refresh token: getClaims() returns an auth error.
    const INVALID_TOKEN = {
      data: null,
      error: { name: "AuthInvalidJwtError", message: "Invalid JWT signature", status: 400 },
    };

    it("sends a page request with an invalid token to /login", async () => {
      mockGetClaims.mockResolvedValue(INVALID_TOKEN);

      const response = await updateSession(createRequest("/settings", { session: true }));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it("answers an API fetch with an invalid token with 401 JSON", async () => {
      mockGetClaims.mockResolvedValue(INVALID_TOKEN);

      const response = await updateSession(apiFetch("/api/notebooks"));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
      expect(response.headers.get("x-middleware-request-x-verified-user-id")).toBeNull();
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it("rewrites / to the landing page for an invalid token", async () => {
      mockGetClaims.mockResolvedValue(INVALID_TOKEN);

      const response = await updateSession(createRequest("/", { session: true }));

      expect(new URL(response.headers.get("x-middleware-rewrite")!).pathname).toBe("/welcome");
    });

    it("treats a getClaims() that throws as signed out instead of failing the request", async () => {
      // auth-js re-throws errors that aren't auth errors. A tampered cookie can reach some, such
      // as an unknown `alg` sent with a real `kid`.
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockGetClaims.mockRejectedValue(new Error("Invalid alg claim"));

      const page = await updateSession(createRequest("/settings", { session: true }));
      const api = await updateSession(apiFetch("/api/notebooks"));

      expect(page.status).toBe(307);
      expect(new URL(page.headers.get("location")!).pathname).toBe("/login");
      expect(api.status).toBe(401);
      expect(mockFrom).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[middleware] Session verification failed:",
        expect.any(Error),
      );
      // Reported to Sentry, but at most once a minute: the second request isn't reported again.
      expect(mockCaptureException).toHaveBeenCalledOnce();
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
        extra: { where: "middleware:session-claims" },
      });
      consoleError.mockRestore();
    });

    it.each([
      ["no sub claim", { role: "authenticated" }],
      ["an empty sub claim", { sub: "", email: "test@test.com" }],
      ["a sub claim that isn't a string", { sub: 42, email: "test@test.com" }],
    ])("treats a token with %s as signed out", async (_label, claims) => {
      mockGetClaims.mockResolvedValue(signedIn(claims));

      const response = await updateSession(apiFetch("/api/notebooks"));

      expect(response.status).toBe(401);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it.each([
      ["no email claim", { sub: "user-1" }],
      ["an email claim that isn't a string", { sub: "user-1", email: null }],
    ])("forwards an empty verified email for a token with %s", async (_label, claims) => {
      mockGetClaims.mockResolvedValue(signedIn(claims));
      approvedProfile();

      const response = await updateSession(apiFetch("/api/notes"));

      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-request-x-verified-user-id")).toBe("user-1");
      expect(response.headers.get("x-middleware-request-x-verified-user-email")).toBe("");
    });

    // A refresh inside getClaims() writes the new session through the client's setAll hook.
    function refreshDuringGetClaims(): void {
      mockGetClaims.mockImplementationOnce(async () => {
        setAllCookies(
          [{ name: "sb-test-auth-token", value: "refreshed-session", options: { path: "/" } }],
          { "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0" },
        );
        return signedIn();
      });
    }

    it("puts refreshed session cookies on an approved user's pass-through", async () => {
      refreshDuringGetClaims();
      approvedProfile();

      const response = await updateSession(createRequest("/settings", { session: true }));

      expect(response.status).toBe(200);
      expect(response.cookies.get("sb-test-auth-token")?.value).toBe("refreshed-session");
      expect(response.headers.get("x-middleware-request-x-verified-user-id")).toBe("user-1");
    });

    it("puts refreshed session cookies on the waiting page for an unapproved user", async () => {
      refreshDuringGetClaims();
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: { is_approved: false }, error: null }),
          }),
        }),
      });

      const response = await updateSession(
        createRequest("/waiting-for-approval", { session: true }),
      );

      expect(response.status).toBe(200);
      expect(response.cookies.get("sb-test-auth-token")?.value).toBe("refreshed-session");
    });

    it("puts refreshed session cookies on a public route", async () => {
      refreshDuringGetClaims();

      const response = await updateSession(createRequest("/login", { session: true }));

      expect(response.status).toBe(200);
      expect(response.cookies.get("sb-test-auth-token")?.value).toBe("refreshed-session");
    });
  });
});
