import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockExchangeCode = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { exchangeCodeForSession: mockExchangeCode },
  }),
}));

const mockReportError = vi.fn();
vi.mock("@/lib/report-error", () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

const { GET } = await import("@/app/auth/callback/route");

describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exchanges code and redirects to next URL", async () => {
    mockExchangeCode.mockResolvedValue({ error: null });

    const request = new NextRequest(
      "http://localhost:3000/auth/callback?code=test-code&next=/reset-password",
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/reset-password");
    expect(mockExchangeCode).toHaveBeenCalledWith("test-code");
  });

  it("redirects to / when no next param", async () => {
    mockExchangeCode.mockResolvedValue({ error: null });

    const request = new NextRequest("http://localhost:3000/auth/callback?code=test-code");
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/");
  });

  it("redirects to login with error when code exchange fails", async () => {
    mockExchangeCode.mockResolvedValue({ error: { message: "Invalid code" } });

    const request = new NextRequest("http://localhost:3000/auth/callback?code=bad-code");
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("auth-callback-error");
  });

  it("reports a returned AuthError as a throttled warning (expired or reused links are routine)", async () => {
    const authError = { message: "Invalid code", status: 400 };
    mockExchangeCode.mockResolvedValue({ error: authError });

    const request = new NextRequest("http://localhost:3000/auth/callback?code=bad-code");
    await GET(request);

    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(authError, "auth:callback", {
      level: "warning",
      throttleMs: 60_000,
    });
  });

  it("reports a thrown error at error level, throttled under its own where, and still redirects to login", async () => {
    const thrown = new Error("network down");
    mockExchangeCode.mockRejectedValue(thrown);

    const request = new NextRequest("http://localhost:3000/auth/callback?code=test-code");
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("auth-callback-error");
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(thrown, "auth:callback:exchange-threw", {
      throttleMs: 60_000,
    });
  });

  it("reports nothing when the code exchange succeeds", async () => {
    mockExchangeCode.mockResolvedValue({ error: null });

    await GET(new NextRequest("http://localhost:3000/auth/callback?code=test-code"));

    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("redirects to login when no code provided", async () => {
    const request = new NextRequest("http://localhost:3000/auth/callback");
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });
});
