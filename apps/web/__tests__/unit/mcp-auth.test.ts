import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: mockFrom,
  }),
}));

const { authenticateMcpRequest } = await import("@/lib/api/mcp-auth");

describe("authenticateMcpRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws on missing Authorization header", async () => {
    await expect(authenticateMcpRequest(null)).rejects.toThrow(
      "Missing or invalid Authorization header",
    );
  });

  it("throws on non-Bearer auth header", async () => {
    await expect(authenticateMcpRequest("Basic abc123")).rejects.toThrow(
      "Missing or invalid Authorization header",
    );
  });

  it("throws on empty Bearer token", async () => {
    await expect(authenticateMcpRequest("Bearer ")).rejects.toThrow("Empty API key");
  });

  it("throws when API key is not found", async () => {
    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: { message: "Not found" } }),
        }),
      }),
    }));

    await expect(authenticateMcpRequest("Bearer dk_somefakekey12345")).rejects.toThrow(
      "Invalid API key",
    );
  });

  it("throws when API key is revoked", async () => {
    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: { id: "key-1", user_id: "user-1", revoked_at: "2026-01-01" },
              error: null,
            }),
        }),
      }),
    }));

    await expect(authenticateMcpRequest("Bearer dk_somefakekey12345")).rejects.toThrow(
      "API key has been revoked",
    );
  });

  it("throws when user is not approved", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "api_keys") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: "key-1", user_id: "user-1", revoked_at: null },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { is_approved: false },
                  error: null,
                }),
            }),
          }),
        };
      }
      return {};
    });

    await expect(authenticateMcpRequest("Bearer dk_somefakekey12345")).rejects.toThrow(
      "User account is not approved",
    );
  });

  it("returns userId and supabase client when authentication succeeds", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "api_keys") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: "key-1", user_id: "user-1", revoked_at: null },
                  error: null,
                }),
            }),
          }),
          update: () => ({
            eq: () => ({
              then: (cb: () => void) => cb(),
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { is_approved: true },
                  error: null,
                }),
            }),
          }),
        };
      }
      return {};
    });

    const result = await authenticateMcpRequest("Bearer dk_somefakekey12345");
    expect(result.userId).toBe("user-1");
    expect(result.supabase).toBeDefined();
  });
});
