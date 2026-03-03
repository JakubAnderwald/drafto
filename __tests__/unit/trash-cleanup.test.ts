import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    CRON_SECRET: undefined, // No cron secret configured by default
  },
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
}

function mockAdminCheck(isAdmin: boolean) {
  mockFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        single: () =>
          Promise.resolve({ data: { is_approved: true, is_admin: isAdmin }, error: null }),
      }),
    }),
  });
}

function createRequest(headers?: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost:3000/api/cron/cleanup-trash", {
    method: "POST",
    headers,
  });
}

const { POST } = await import("@/app/api/cron/cleanup-trash/route");

describe("POST /api/cron/cleanup-trash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Not authenticated" },
    });

    const response = await POST(createRequest());
    expect(response.status).toBe(401);
  });

  it("returns 403 when user is not an admin", async () => {
    authenticateAs("user-1");
    mockAdminCheck(false);

    const response = await POST(createRequest());
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("calls cleanup_trashed_notes RPC and returns deleted count", async () => {
    authenticateAs("admin-1");
    mockAdminCheck(true);
    mockRpc.mockResolvedValue({ data: 5, error: null });

    const response = await POST(createRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deleted).toBe(5);
    expect(mockRpc).toHaveBeenCalledWith("cleanup_trashed_notes");
  });

  it("returns deleted count of 0 when no notes to clean up", async () => {
    authenticateAs("admin-1");
    mockAdminCheck(true);
    mockRpc.mockResolvedValue({ data: 0, error: null });

    const response = await POST(createRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deleted).toBe(0);
  });

  it("returns 500 when RPC call fails", async () => {
    authenticateAs("admin-1");
    mockAdminCheck(true);
    mockRpc.mockResolvedValue({ data: null, error: { message: "DB error" } });

    const response = await POST(createRequest());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to cleanup trashed notes");
  });

  it("returns 403 when profile query fails", async () => {
    authenticateAs("admin-1");
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: { message: "DB error" } }),
        }),
      }),
    });

    const response = await POST(createRequest());
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });
});
