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
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: note, error: null }),
              }),
            }),
          }),
        };
      });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe("Test");
    });

    it("converts TipTap content to BlockNote format on read", async () => {
      authenticateAs("user-1");
      const tiptapContent = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
      };
      const note = { id: "note-1", title: "Test", content: tiptapContent };
      const mockUpdate = vi.fn().mockReturnValue({
        eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
      });
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: note, error: null }),
              }),
            }),
          }),
          update: mockUpdate,
        };
      });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params });
      expect(response.status).toBe(200);
      const body = await response.json();
      // Should be converted to BlockNote array format
      expect(Array.isArray(body.content)).toBe(true);
      expect(body.content[0].type).toBe("paragraph");
      // Should persist the conversion back to DB with BlockNote content
      expect(mockUpdate).toHaveBeenCalledWith({
        content: expect.arrayContaining([expect.objectContaining({ type: "paragraph" })]),
      });
    });
  });

  describe("PATCH /api/notes/[id]", () => {
    it("updates note title", async () => {
      authenticateAs("user-1");
      const updated = { id: "note-1", title: "Updated" };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: () => Promise.resolve({ data: updated, error: null }),
                }),
              }),
            }),
          }),
        };
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

    it("updates note notebook_id (move between notebooks)", async () => {
      authenticateAs("user-1");
      const updated = { id: "note-1", title: "Test", notebook_id: "nb-2" };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: () => Promise.resolve({ data: updated, error: null }),
                }),
              }),
            }),
          }),
        };
      });

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({ notebook_id: "nb-2" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await PATCH(request, { params });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.notebook_id).toBe("nb-2");
    });

    it("returns 400 when no fields provided", async () => {
      authenticateAs("user-1");
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {};
      });

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
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          }),
        };
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
