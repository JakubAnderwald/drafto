import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { DEFAULT_STORAGE_QUOTA_BYTES } from "@drafto/shared";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
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

const approvedProfile = {
  select: () => ({
    eq: () => ({
      single: () => Promise.resolve({ data: { is_approved: true }, error: null }),
    }),
  }),
};

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
  mockFrom.mockImplementation((table: string) => (table === "profiles" ? approvedProfile : {}));
}

function createRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/storage-usage", { method: "GET", headers });
}

describe("GET /api/storage-usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const { GET } = await import("@/app/api/storage-usage/route");
    const response = await GET(createRequest());

    expect(response.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns the caller's usage and quota", async () => {
    authenticateAs("user-1");
    mockRpc.mockResolvedValue({
      data: [{ used_bytes: 13002342, quota_bytes: DEFAULT_STORAGE_QUOTA_BYTES }],
      error: null,
    });

    const { GET } = await import("@/app/api/storage-usage/route");
    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      usedBytes: 13002342,
      quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
    });
    expect(mockRpc).toHaveBeenCalledWith("get_my_storage_usage");
  });

  it("uses the middleware's verified-user headers without a second auth round-trip", async () => {
    mockRpc.mockResolvedValue({ data: [{ used_bytes: 0, quota_bytes: 1024 }], error: null });

    const { GET } = await import("@/app/api/storage-usage/route");
    const response = await GET(
      createRequest({
        "x-verified-user-id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        "x-verified-user-email": "test@test.com",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ usedBytes: 0, quotaBytes: 1024 });
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("returns a null quota for an unlimited user", async () => {
    authenticateAs("admin-1");
    mockRpc.mockResolvedValue({
      data: [{ used_bytes: "734003200", quota_bytes: null }],
      error: null,
    });

    const { GET } = await import("@/app/api/storage-usage/route");
    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ usedBytes: 734003200, quotaBytes: null });
  });

  it("returns 500 when the usage RPC fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    authenticateAs("user-1");
    mockRpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });

    const { GET } = await import("@/app/api/storage-usage/route");
    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Failed to load storage usage");
    consoleError.mockRestore();
  });

  it("returns 500 when the RPC returns no row", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    authenticateAs("user-1");
    mockRpc.mockResolvedValue({ data: [], error: null });

    const { GET } = await import("@/app/api/storage-usage/route");
    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    consoleError.mockRestore();
  });
});
