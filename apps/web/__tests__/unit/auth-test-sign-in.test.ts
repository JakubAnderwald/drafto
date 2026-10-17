import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";
import type { isTestSignInEnabled } from "@/lib/auth/test-sign-in";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://huhzactreblzcogqkbsd.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    VERCEL_ENV: "preview",
  },
}));

// The gate itself is covered in test-sign-in.test.ts; here it is switched on and off directly.
const mockIsEnabled = vi.fn<typeof isTestSignInEnabled>();
vi.mock("@/lib/auth/test-sign-in", () => ({
  isTestSignInEnabled: mockIsEnabled,
}));

const mockVerifyOtp = vi.fn();
const mockCreateClient = vi.fn(async () => ({ auth: { verifyOtp: mockVerifyOtp } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

const { GET } = await import("@/app/auth/test-sign-in/route");

const TOKEN = "hashed-token-abc123";

function request(query: string): NextRequest {
  return new NextRequest(`https://drafto-git-pr-1.vercel.app/auth/test-sign-in${query}`);
}

function location(response: Response): URL {
  return new URL(response.headers.get("location")!);
}

describe("GET /auth/test-sign-in", () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("asks the gate with VERCEL_ENV and the Supabase URL", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });

    await GET(request(`?token_hash=${TOKEN}`));

    expect(mockIsEnabled).toHaveBeenCalledWith({
      vercelEnv: "preview",
      supabaseUrl: "https://huhzactreblzcogqkbsd.supabase.co",
    });
  });

  it("answers 404 and does no other work when disabled", async () => {
    mockIsEnabled.mockReturnValue(false);

    const response = await GET(request(`?token_hash=${TOKEN}&next=/notes`));

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe("");
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it("verifies the token as a magic link and redirects to next", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });

    const response = await GET(request(`?token_hash=${TOKEN}&next=/notes/123`));

    expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN, type: "magiclink" });
    expect(response.status).toBe(307);
    expect(location(response).origin).toBe("https://drafto-git-pr-1.vercel.app");
    expect(location(response).pathname).toBe("/notes/123");
  });

  it("redirects to / when next is missing", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });

    const response = await GET(request(`?token_hash=${TOKEN}`));

    expect(response.status).toBe(307);
    expect(location(response).pathname).toBe("/");
  });

  it.each(["//evil.example", "https://evil.example"])(
    "sanitises next=%s to / on this origin",
    async (next) => {
      mockVerifyOtp.mockResolvedValue({ error: null });

      const response = await GET(request(`?token_hash=${TOKEN}&next=${encodeURIComponent(next)}`));

      expect(response.status).toBe(307);
      expect(location(response).origin).toBe("https://drafto-git-pr-1.vercel.app");
      expect(location(response).pathname).toBe("/");
    },
  );

  it("redirects to the login error when verifyOtp returns an error", async () => {
    mockVerifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });

    const response = await GET(request(`?token_hash=${TOKEN}&next=/notes`));

    expect(response.status).toBe(307);
    expect(location(response).pathname).toBe("/login");
    expect(location(response).searchParams.get("error")).toBe("test-sign-in-failed");
    expect(consoleError).toHaveBeenCalledWith(
      "[auth/test-sign-in] verifyOtp failed:",
      "Token has expired or is invalid",
    );
  });

  it("redirects to the login error without calling verifyOtp when there is no token", async () => {
    const response = await GET(request("?next=/notes"));

    expect(response.status).toBe(307);
    expect(location(response).pathname).toBe("/login");
    expect(location(response).searchParams.get("error")).toBe("test-sign-in-failed");
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it("treats an empty token as missing", async () => {
    const response = await GET(request("?token_hash="));

    expect(location(response).pathname).toBe("/login");
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it("redirects to the login error when verifyOtp throws", async () => {
    mockVerifyOtp.mockRejectedValue(new Error("fetch failed"));

    const response = await GET(request(`?token_hash=${TOKEN}`));

    expect(response.status).toBe(307);
    expect(location(response).pathname).toBe("/login");
    expect(location(response).searchParams.get("error")).toBe("test-sign-in-failed");
    expect(consoleError).toHaveBeenCalledWith(
      "[auth/test-sign-in] verifyOtp threw unexpectedly:",
      "fetch failed",
    );
  });

  it("redirects to the login error when creating the client throws", async () => {
    mockCreateClient.mockRejectedValueOnce(new Error("cookies unavailable"));

    const response = await GET(request(`?token_hash=${TOKEN}`));

    expect(location(response).pathname).toBe("/login");
    expect(location(response).searchParams.get("error")).toBe("test-sign-in-failed");
  });

  it("never logs the token", async () => {
    mockVerifyOtp
      .mockResolvedValueOnce({ error: { message: "Token has expired or is invalid" } })
      .mockRejectedValueOnce(new Error("fetch failed"));

    await GET(request(`?token_hash=${TOKEN}`));
    await GET(request(`?token_hash=${TOKEN}`));

    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(TOKEN);
  });
});
