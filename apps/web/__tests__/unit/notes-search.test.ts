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
  mockFrom.mockImplementation((table: string) => {
    if (table === "profiles") return approvedProfile;
    return {};
  });
}

describe("Search API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("GET /api/notes/search", () => {
    it("returns 401 when not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

      const { GET } = await import("@/app/api/notes/search/route");
      const request = new NextRequest("http://localhost:3000/api/notes/search?q=test");
      const response = await GET(request);
      expect(response.status).toBe(401);
    });

    it("returns 400 when q parameter is missing", async () => {
      authenticateAs("user-1");

      const { GET } = await import("@/app/api/notes/search/route");
      const request = new NextRequest("http://localhost:3000/api/notes/search");
      const response = await GET(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("required");
    });

    it("returns 400 when q parameter is empty", async () => {
      authenticateAs("user-1");

      const { GET } = await import("@/app/api/notes/search/route");
      const request = new NextRequest("http://localhost:3000/api/notes/search?q=   ");
      const response = await GET(request);
      expect(response.status).toBe(400);
    });

    it("returns 400 when q parameter exceeds 200 characters", async () => {
      authenticateAs("user-1");

      const longQuery = "a".repeat(201);
      const { GET } = await import("@/app/api/notes/search/route");
      const request = new NextRequest(`http://localhost:3000/api/notes/search?q=${longQuery}`);
      const response = await GET(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("200");
    });

    it("returns search results", async () => {
      authenticateAs("user-1");
      const searchResults = [
        {
          id: "note-1",
          title: "Test Note",
          notebook_id: "nb-1",
          is_trashed: false,
          trashed_at: null,
          updated_at: "2026-03-14T00:00:00Z",
          content_snippet: "some matching text",
        },
      ];
      mockRpc.mockResolvedValue({ data: searchResults, error: null });

      const { GET } = await import("@/app/api/notes/search/route");
      const request = new NextRequest("http://localhost:3000/api/notes/search?q=test");
      const response = await GET(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveLength(1);
      expect(body[0].title).toBe("Test Note");
      expect(mockRpc).toHaveBeenCalledWith("search_notes", { search_query: "test" });
    });

    it("returns 500 on RPC error", async () => {
      authenticateAs("user-1");
      mockRpc.mockResolvedValue({ data: null, error: { message: "RPC failed" } });

      const { GET } = await import("@/app/api/notes/search/route");
      const request = new NextRequest("http://localhost:3000/api/notes/search?q=test");
      const response = await GET(request);
      expect(response.status).toBe(500);
    });
  });
});
