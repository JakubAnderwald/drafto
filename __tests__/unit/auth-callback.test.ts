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

  it("redirects to login when no code provided", async () => {
    const request = new NextRequest("http://localhost:3000/auth/callback");
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });
});
