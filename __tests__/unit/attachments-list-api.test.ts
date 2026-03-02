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

describe("GET /api/notes/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Not auth" },
    });

    const { GET } = await import("@/app/api/notes/[id]/attachments/route");
    const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments");
    const response = await GET(request, { params });
    expect(response.status).toBe(401);
  });

  it("returns 404 when note does not exist", async () => {
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

    const { GET } = await import("@/app/api/notes/[id]/attachments/route");
    const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments");
    const response = await GET(request, { params });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Note not found");
  });

  it("returns attachments for a note", async () => {
    authenticateAs("user-1");
    const attachmentList = [
      {
        id: "att-1",
        note_id: "note-1",
        user_id: "user-1",
        file_name: "image.png",
        file_path: "user-1/note-1/image.png",
        file_size: 1024,
        mime_type: "image/png",
        created_at: "2026-03-02T00:00:00Z",
      },
      {
        id: "att-2",
        note_id: "note-1",
        user_id: "user-1",
        file_name: "doc.pdf",
        file_path: "user-1/note-1/doc.pdf",
        file_size: 2048,
        mime_type: "application/pdf",
        created_at: "2026-03-01T00:00:00Z",
      },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === "notes") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { id: "note-1" }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "attachments") {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: attachmentList, error: null }),
            }),
          }),
        };
      }
      return {};
    });

    const { GET } = await import("@/app/api/notes/[id]/attachments/route");
    const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments");
    const response = await GET(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(2);
    expect(body[0].file_name).toBe("image.png");
    expect(body[1].file_name).toBe("doc.pdf");
  });

  it("returns empty array when note has no attachments", async () => {
    authenticateAs("user-1");
    mockFrom.mockImplementation((table: string) => {
      if (table === "notes") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { id: "note-1" }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "attachments") {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      }
      return {};
    });

    const { GET } = await import("@/app/api/notes/[id]/attachments/route");
    const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments");
    const response = await GET(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(0);
  });

  it("returns 500 on database error", async () => {
    authenticateAs("user-1");
    mockFrom.mockImplementation((table: string) => {
      if (table === "notes") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { id: "note-1" }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "attachments") {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: null, error: { message: "DB error" } }),
            }),
          }),
        };
      }
      return {};
    });

    const { GET } = await import("@/app/api/notes/[id]/attachments/route");
    const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments");
    const response = await GET(request, { params });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to fetch attachments");
  });
});
