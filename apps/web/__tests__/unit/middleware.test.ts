import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock env before importing middleware
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  },
}));

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
      auth: { getUser: mockGetUser },
      from: mockFrom,
    };
  },
}));

// Import after mocks are set up
const { updateSession } = await import("@/lib/supabase/middleware");

// A Supabase auth cookie. Without one the middleware skips the session lookup entirely.
const SESSION_COOKIE = "sb-test-auth-token=session";

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

  it("allows access to public routes without auth", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const publicRoutes = [
      "/login",
      "/signup",
      "/auth/callback",
      "/auth/desktop/callback",
      "/auth/desktop/recovery",
      "/auth/test-sign-in",
      "/forgot-password",
      "/reset-password",
      "/api/health",
      "/api/webhooks/new-signup",
      "/api/account",
      "/account/delete",
      "/privacy",
      "/support",
      "/robots.txt",
      "/sitemap.xml",
      "/.well-known/apple-app-site-association",
      "/.well-known/assetlinks.json",
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
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

      const response = await updateSession(createRequest(route));

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(mockFrom).not.toHaveBeenCalled();
    },
  );

  it("does not treat a lookalike path as the public privacy page", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await updateSession(createRequest("/privacy-settings"));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("passes a cookie-less DELETE /api/account through to the route instead of redirecting", async () => {
    // Native apps authenticate this route with a bearer token and send no cookie.
    // A redirect would be followed by fetch and land on the login page's HTML.
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

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

  it("redirects unauthenticated users to /login", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await updateSession(createRequest("/settings"));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("serves signed-out / the landing page through a rewrite instead of redirecting", async () => {
    // A redirect to /login made Google index the login form under `/`.
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await updateSession(createRequest("/?utm_source=store"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const rewrite = new URL(response.headers.get("x-middleware-rewrite")!);
    expect(rewrite.pathname).toBe("/welcome");
    expect(rewrite.search).toBe("?utm_source=store");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("passes refreshed session cookies and their no-cache headers on with the landing page rewrite", async () => {
    // An expired session is cleared during getUser(). The browser must still get the cleared
    // cookie, and no cache may store the static landing page together with it.
    mockGetUser.mockImplementationOnce(async () => {
      setAllCookies([{ name: "sb-test-auth-token", value: "", options: { maxAge: 0 } }], {
        "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
        Expires: "0",
      });
      return { data: { user: null }, error: null };
    });

    const response = await updateSession(createRequest("/", { session: true }));

    expect(response.headers.get("x-middleware-rewrite")).not.toBeNull();
    expect(response.cookies.get("sb-test-auth-token")?.value).toBe("");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
    expect(response.headers.get("expires")).toBe("0");
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
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockFrom).not.toHaveBeenCalled();
    },
  );

  it("rewrites cookie-less / to the landing page without a session lookup", async () => {
    const response = await updateSession(createRequest("/?utm_source=store"));

    const rewrite = new URL(response.headers.get("x-middleware-rewrite")!);
    expect(rewrite.pathname).toBe("/welcome");
    expect(rewrite.search).toBe("?utm_source=store");
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("does not trust a forged verified-user header on a cookie-less request", async () => {
    const response = await updateSession(
      new NextRequest(new URL("/api/notes", "http://localhost:3000"), {
        headers: { "x-verified-user-id": "someone-else" },
      }),
    );

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("still looks up the session when a Supabase cookie is present", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await updateSession(createRequest("/settings", { session: true }));

    expect(mockGetUser).toHaveBeenCalledOnce();
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("sends a direct visit to the landing page's route to / without a session lookup", async () => {
    const response = await updateSession(createRequest("/welcome"));

    expect(response.status).toBe(308);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/");
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("redirects unapproved users to /waiting-for-approval", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "test@test.com" } },
      error: null,
    });
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
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "test@test.com" } },
      error: null,
    });
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
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "test@test.com" } },
      error: null,
    });
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
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "test@test.com" } },
      error: null,
    });
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
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "test@test.com" } },
      error: null,
    });
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
});
