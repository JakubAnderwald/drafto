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

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

const { GET, POST } = await import("@/app/api/api-keys/route");

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
}

describe("GET /api/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const response = await GET(new NextRequest("http://localhost:3000/api/api-keys"));
    expect(response.status).toBe(401);
  });

  it("returns API keys for authenticated user", async () => {
    authenticateAs("user-1");

    const keys = [
      {
        id: "key-1",
        key_prefix: "dk_abcde",
        name: "Claude Desktop",
        created_at: "2026-04-11T00:00:00Z",
        last_used_at: null,
        revoked_at: null,
      },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return {
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: keys, error: null }),
          }),
        }),
      };
    });

    const response = await GET(new NextRequest("http://localhost:3000/api/api-keys"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Claude Desktop");
  });
});

describe("POST /api/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const req = new NextRequest("http://localhost/api/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: "Test Key" }),
    });

    const response = await POST(req);
    expect(response.status).toBe(401);
  });

  it("creates a new API key and returns the raw key", async () => {
    authenticateAs("user-1");

    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return {
        insert: () => ({
          select: () => ({
            single: () =>
              Promise.resolve({
                data: { id: "key-new", key_prefix: "dk_test1", name: "Test Key" },
                error: null,
              }),
          }),
        }),
      };
    });

    const req = new NextRequest("http://localhost/api/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: "Test Key" }),
    });

    const response = await POST(req);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.key).toMatch(/^dk_/);
    expect(body.key).toHaveLength(51); // dk_ + 48 hex chars
    expect(body.id).toBe("key-new");
  });
});
