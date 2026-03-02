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

describe("Trash API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/notes/trash", () => {
    it("returns 401 when not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

      const { GET } = await import("@/app/api/notes/trash/route");
      const response = await GET();
      expect(response.status).toBe(401);
    });

    it("returns trashed notes", async () => {
      authenticateAs("user-1");
      const trashedNotes = [
        { id: "note-1", title: "Trashed Note", notebook_id: "nb-1", trashed_at: "2026-01-01" },
      ];
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: trashedNotes, error: null }),
            }),
          }),
        }),
      });

      const { GET } = await import("@/app/api/notes/trash/route");
      const response = await GET();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveLength(1);
      expect(body[0].title).toBe("Trashed Note");
    });

    it("returns 500 on database error", async () => {
      authenticateAs("user-1");
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: null, error: { message: "DB error" } }),
            }),
          }),
        }),
      });

      const { GET } = await import("@/app/api/notes/trash/route");
      const response = await GET();
      expect(response.status).toBe(500);
    });
  });

  describe("DELETE /api/notes/[id]/permanent", () => {
    it("returns 401 when not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

      const { DELETE } = await import("@/app/api/notes/[id]/permanent/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/permanent", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params });
      expect(response.status).toBe(401);
    });

    it("returns 404 when note not found", async () => {
      authenticateAs("user-1");
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: null, error: { message: "Not found" } }),
            }),
          }),
        }),
      });

      const { DELETE } = await import("@/app/api/notes/[id]/permanent/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/permanent", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params });
      expect(response.status).toBe(404);
    });

    it("returns 400 when note is not trashed", async () => {
      authenticateAs("user-1");
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: { id: "note-1", is_trashed: false }, error: null }),
            }),
          }),
        }),
      });

      const { DELETE } = await import("@/app/api/notes/[id]/permanent/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/permanent", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("must be in trash");
    });

    it("permanently deletes a trashed note", async () => {
      authenticateAs("user-1");
      let callCount = 0;
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: { id: "note-1", is_trashed: true }, error: null }),
            }),
          }),
        }),
        delete: () => ({
          eq: () => ({
            eq: () => {
              callCount++;
              return Promise.resolve({ error: null });
            },
          }),
        }),
      });

      const { DELETE } = await import("@/app/api/notes/[id]/permanent/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/permanent", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params });
      expect(response.status).toBe(200);
      expect(callCount).toBe(1);
    });
  });

  describe("PATCH /api/notes/[id] (restore)", () => {
    it("restores a trashed note", async () => {
      authenticateAs("user-1");
      const restored = { id: "note-1", title: "Test", is_trashed: false, trashed_at: null };
      mockFrom.mockReturnValue({
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: restored, error: null }),
              }),
            }),
          }),
        }),
      });

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({ is_trashed: false }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await PATCH(request, { params });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.is_trashed).toBe(false);
    });
  });
});
