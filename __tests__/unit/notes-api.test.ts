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

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
}

const params = Promise.resolve({ id: "note-1" });

describe("Notes API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/notes/[id]", () => {
    it("returns 401 when not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params });
      expect(response.status).toBe(401);
    });

    it("returns note data", async () => {
      authenticateAs("user-1");
      const note = { id: "note-1", title: "Test", content: null };
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: note, error: null }),
            }),
          }),
        }),
      });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe("Test");
    });
  });

  describe("PATCH /api/notes/[id]", () => {
    it("updates note title", async () => {
      authenticateAs("user-1");
      const updated = { id: "note-1", title: "Updated" };
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

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await PATCH(request, { params });
      expect(response.status).toBe(200);
    });

    it("returns 400 when no fields provided", async () => {
      authenticateAs("user-1");

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const response = await PATCH(request, { params });
      expect(response.status).toBe(400);
    });
  });

  describe("DELETE /api/notes/[id]", () => {
    it("soft deletes a note", async () => {
      authenticateAs("user-1");
      mockFrom.mockReturnValue({
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }),
      });

      const { DELETE } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params });
      expect(response.status).toBe(200);
    });
  });
});
