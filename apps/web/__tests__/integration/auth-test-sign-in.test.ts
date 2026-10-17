/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The real route, gate (`isTestSignInEnabled`), redirect sanitiser and server-client wrapper run
// together. Only the Supabase client is stubbed, plus the env and the request's cookie store it
// would otherwise read from the Vercel runtime.
const mockEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_SUPABASE_URL: "https://huhzactreblzcogqkbsd.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "dev-anon-key",
  VERCEL_ENV: "preview" as "production" | "preview" | "development" | undefined,
}));
vi.mock("@/env", () => ({ env: mockEnv }));

type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };
type SetAllCookies = (cookies: CookieToSet[]) => void;

const createServerClientMock = vi.fn();
const verifyOtpMock = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    url: string,
    key: string,
    options: { cookies: { setAll: SetAllCookies } },
  ) => {
    createServerClientMock(url, key);
    return {
      auth: {
        verifyOtp: async (params: unknown) => {
          const result = await verifyOtpMock(params);
          // A verified magic link writes the session cookies, as @supabase/ssr does.
          if (!result.error) {
            options.cookies.setAll([
              { name: "sb-huhzactreblzcogqkbsd-auth-token", value: "session" },
            ]);
          }
          return result;
        },
      },
    };
  },
}));

const cookieSetMock = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: cookieSetMock }),
}));

const { GET } = await import("@/app/auth/test-sign-in/route");

const PREVIEW_ORIGIN = "https://drafto-git-feat-x-jakubanderwalds-projects.vercel.app";

function signInRequest(query: string): NextRequest {
  return new NextRequest(`${PREVIEW_ORIGIN}/auth/test-sign-in${query}`);
}

describe("GET /auth/test-sign-in through the real gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.VERCEL_ENV = "preview";
    mockEnv.NEXT_PUBLIC_SUPABASE_URL = "https://huhzactreblzcogqkbsd.supabase.co";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs a dev-backed preview visitor in and lands them on next", async () => {
    verifyOtpMock.mockResolvedValue({ error: null });

    const response = await GET(signInRequest("?token_hash=hashed-token&next=/notes"));

    expect(createServerClientMock).toHaveBeenCalledWith(
      "https://huhzactreblzcogqkbsd.supabase.co",
      "dev-anon-key",
    );
    expect(verifyOtpMock).toHaveBeenCalledWith({ token_hash: "hashed-token", type: "magiclink" });
    expect(cookieSetMock).toHaveBeenCalledWith(
      "sb-huhzactreblzcogqkbsd-auth-token",
      "session",
      undefined,
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${PREVIEW_ORIGIN}/notes`);
  });

  it("keeps an off-origin next on the preview", async () => {
    verifyOtpMock.mockResolvedValue({ error: null });

    const response = await GET(
      signInRequest(`?token_hash=hashed-token&next=${encodeURIComponent("//evil.example")}`),
    );

    expect(response.headers.get("location")).toBe(`${PREVIEW_ORIGIN}/`);
  });

  it("sends a rejected token to the login error without setting a session", async () => {
    verifyOtpMock.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });

    const response = await GET(signInRequest("?token_hash=used-token"));

    expect(cookieSetMock).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      `${PREVIEW_ORIGIN}/login?error=test-sign-in-failed`,
    );
  });

  it.each([
    ["a production deployment", "production", "https://tbmjbxxseonkciqovnpl.supabase.co"],
    [
      "a production deployment misconfigured with the dev project",
      "production",
      "https://huhzactreblzcogqkbsd.supabase.co",
    ],
    [
      "a preview pointed at the prod project",
      "preview",
      "https://tbmjbxxseonkciqovnpl.supabase.co",
    ],
    ["a local server", undefined, "https://huhzactreblzcogqkbsd.supabase.co"],
  ] as const)("answers 404 on %s and never builds a client", async (_case, vercelEnv, url) => {
    mockEnv.VERCEL_ENV = vercelEnv;
    mockEnv.NEXT_PUBLIC_SUPABASE_URL = url;

    const response = await GET(signInRequest("?token_hash=hashed-token&next=/notes"));

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(verifyOtpMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });
});
