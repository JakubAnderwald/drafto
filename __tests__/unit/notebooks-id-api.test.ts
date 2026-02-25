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

const { PATCH, DELETE } = await import("@/app/api/notebooks/[id]/route");

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
}

const params = Promise.resolve({ id: "nb-1" });

describe("PATCH /api/notebooks/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Updated" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, { params });
    expect(response.status).toBe(401);
  });

  it("returns 400 when name is missing", async () => {
    authenticateAs("user-1");

    const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, { params });
    expect(response.status).toBe(400);
  });

  it("renames a notebook", async () => {
    authenticateAs("user-1");

    const updated = { id: "nb-1", name: "Renamed", user_id: "user-1" };
    mockFrom.mockReturnValue({
      update: () => ({
        eq: () => ({
          eq: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: updated, error: null }),
            }),
          }),
        }),
      }),
    });

    const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await PATCH(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toBe("Renamed");
  });
});

describe("DELETE /api/notebooks/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, { params });
    expect(response.status).toBe(401);
  });

  it("returns 409 when notebook has notes", async () => {
    authenticateAs("user-1");

    let callCount = 0;
    mockFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // notes count check
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ count: 3, error: null }),
            }),
          }),
        };
      }
      return {};
    });

    const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, { params });
    expect(response.status).toBe(409);
  });

  it("deletes an empty notebook", async () => {
    authenticateAs("user-1");

    let callCount = 0;
    mockFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // notes count check - empty
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ count: 0, error: null }),
            }),
          }),
        };
      }
      // delete call
      return {
        delete: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }),
      };
    });

    const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, { params });
    expect(response.status).toBe(200);
  });
});
