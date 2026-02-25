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

const { GET, POST } = await import("@/app/api/notebooks/route");

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
}

describe("GET /api/notebooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("returns notebooks for authenticated user", async () => {
    authenticateAs("user-1");

    const notebooks = [
      {
        id: "nb-1",
        name: "Notes",
        user_id: "user-1",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ];

    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: notebooks, error: null }),
        }),
      }),
    });

    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Notes");
  });
});

describe("POST /api/notebooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const request = new NextRequest("http://localhost:3000/api/notebooks", {
      method: "POST",
      body: JSON.stringify({ name: "Test" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("returns 400 when name is missing", async () => {
    authenticateAs("user-1");

    const request = new NextRequest("http://localhost:3000/api/notebooks", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("creates a notebook", async () => {
    authenticateAs("user-1");

    const notebook = { id: "nb-2", name: "Work", user_id: "user-1" };
    mockFrom.mockReturnValue({
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: notebook, error: null }),
        }),
      }),
    });

    const request = new NextRequest("http://localhost:3000/api/notebooks", {
      method: "POST",
      body: JSON.stringify({ name: "Work" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.name).toBe("Work");
  });
});
