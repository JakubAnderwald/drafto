import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { DEFAULT_CONTENT_QUOTA_BYTES } from "@drafto/shared";

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
  return new NextRequest("http://localhost:3000/api/content-usage", { method: "GET", headers });
}

describe("GET /api/content-usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const { GET } = await import("@/app/api/content-usage/route");
    const response = await GET(createRequest());

    expect(response.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns the caller's note content usage and quota", async () => {
    authenticateAs("user-1");
    mockRpc.mockResolvedValue({
      data: [{ used_bytes: "1048576", quota_bytes: DEFAULT_CONTENT_QUOTA_BYTES }],
      error: null,
    });

    const { GET } = await import("@/app/api/content-usage/route");
    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      usedBytes: 1048576,
      quotaBytes: DEFAULT_CONTENT_QUOTA_BYTES,
    });
    expect(mockRpc).toHaveBeenCalledWith("get_my_content_usage");
  });

  it("returns a null quota for an unlimited user", async () => {
    authenticateAs("admin-1");
    mockRpc.mockResolvedValue({ data: [{ used_bytes: 5, quota_bytes: null }], error: null });

    const { GET } = await import("@/app/api/content-usage/route");
    const response = await GET(createRequest());

    expect(await response.json()).toEqual({ usedBytes: 5, quotaBytes: null });
  });

  it("returns 500 and reports to Sentry when the usage RPC fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const Sentry = await import("@sentry/nextjs");
    authenticateAs("user-1");
    const failure = { message: "permission denied" };
    mockRpc.mockResolvedValue({ data: null, error: failure });

    const { GET } = await import("@/app/api/content-usage/route");
    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Failed to load content usage");
    expect(Sentry.captureException).toHaveBeenCalledWith(failure, {
      extra: { where: "content-quota:get-usage" },
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[content-quota] Failed to read content usage:",
      "permission denied",
    );
    consoleError.mockRestore();
  });

  it("returns 500 when the RPC throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    authenticateAs("user-1");
    mockRpc.mockRejectedValue(new Error("network"));

    const { GET } = await import("@/app/api/content-usage/route");
    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    consoleError.mockRestore();
  });

  it("returns 500 when the RPC returns no row", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    authenticateAs("user-1");
    mockRpc.mockResolvedValue({ data: [], error: null });

    const { GET } = await import("@/app/api/content-usage/route");
    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      "[content-quota] get_my_content_usage returned no usable row",
    );
    consoleError.mockRestore();
  });
});
