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

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

// Import after mocks are set up
const { updateSession } = await import("@/lib/supabase/middleware");

function createRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"));
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
      "/forgot-password",
      "/reset-password",
      "/api/health",
    ];

    for (const route of publicRoutes) {
      const response = await updateSession(createRequest(route));
      expect(response.status).toBe(200);
    }
  });

  it("redirects unauthenticated users to /login", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await updateSession(createRequest("/"));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
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

    const response = await updateSession(createRequest("/"));

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

    const response = await updateSession(createRequest("/"));

    expect(response.status).toBe(200);
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

    const response = await updateSession(createRequest("/waiting-for-approval"));

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

    const response = await updateSession(createRequest("/"));

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

    const response = await updateSession(createRequest("/waiting-for-approval"));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/");
  });
});
