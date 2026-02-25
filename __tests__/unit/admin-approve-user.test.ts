import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

const { POST } = await import("@/app/api/admin/approve-user/route");

function createRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/admin/approve-user", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/admin/approve-user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Not authenticated" },
    });

    const response = await POST(createRequest({ userId: "user-1" }));
    expect(response.status).toBe(401);
  });

  it("returns 403 when user is not an admin", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "test@test.com" } },
      error: null,
    });
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { is_admin: false }, error: null }),
        }),
      }),
      update: vi.fn(),
    });

    const response = await POST(createRequest({ userId: "user-2" }));
    expect(response.status).toBe(403);
  });

  it("returns 400 when userId is missing", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "admin-1", email: "admin@test.com" } },
      error: null,
    });
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { is_admin: true }, error: null }),
        }),
      }),
    });

    const response = await POST(createRequest({}));
    expect(response.status).toBe(400);
  });

  it("approves a user when requester is admin", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "admin-1", email: "admin@test.com" } },
      error: null,
    });

    const mockMaybeSingle = vi.fn().mockResolvedValue({ data: { id: "user-2" }, error: null });
    const mockSelect = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
    const mockEq = vi.fn().mockReturnValue({ select: mockSelect });
    const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq });

    let callCount = 0;
    mockFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: check is_admin
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { is_admin: true }, error: null }),
            }),
          }),
        };
      }
      // Second call: update profile
      return {
        update: mockUpdate,
      };
    });

    const response = await POST(createRequest({ userId: "user-2" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({ is_approved: true });
    expect(mockEq).toHaveBeenCalledWith("id", "user-2");
  });
});
