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
const mockStorageFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    storage: { from: mockStorageFrom },
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

const params = Promise.resolve({ id: "att-1" });

describe("DELETE /api/attachments/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Not auth" },
    });

    const { DELETE } = await import("@/app/api/attachments/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/attachments/att-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, { params });
    expect(response.status).toBe(401);
  });

  it("returns 404 when attachment does not exist", async () => {
    authenticateAs("user-1");
    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: null, error: { message: "Not found" } }),
            }),
          }),
        }),
      };
    });

    const { DELETE } = await import("@/app/api/attachments/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/attachments/att-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, { params });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Attachment not found");
  });

  it("deletes attachment from storage and database", async () => {
    authenticateAs("user-1");
    const mockRemove = vi.fn().mockResolvedValue({ error: null });
    const mockDeleteEq = vi.fn().mockResolvedValue({ error: null });

    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      if (table === "attachments") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: "att-1", file_path: "user-1/note-1/image.png" },
                    error: null,
                  }),
              }),
            }),
          }),
          delete: () => ({
            eq: mockDeleteEq,
          }),
        };
      }
      return {};
    });

    mockStorageFrom.mockReturnValue({
      remove: mockRemove,
    });

    const { DELETE } = await import("@/app/api/attachments/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/attachments/att-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(mockRemove).toHaveBeenCalledWith(["user-1/note-1/image.png"]);
    expect(mockDeleteEq).toHaveBeenCalledWith("id", "att-1");
  });

  it("returns 500 when storage deletion fails", async () => {
    authenticateAs("user-1");

    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: "att-1", file_path: "user-1/note-1/image.png" },
                  error: null,
                }),
            }),
          }),
        }),
      };
    });

    mockStorageFrom.mockReturnValue({
      remove: vi.fn().mockResolvedValue({ error: { message: "Storage error" } }),
    });

    const { DELETE } = await import("@/app/api/attachments/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/attachments/att-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, { params });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to delete file from storage");
  });

  it("returns 500 when database deletion fails", async () => {
    authenticateAs("user-1");
    const mockDeleteEq = vi.fn().mockResolvedValue({ error: { message: "DB error" } });

    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      if (table === "attachments") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: "att-1", file_path: "user-1/note-1/image.png" },
                    error: null,
                  }),
              }),
            }),
          }),
          delete: () => ({
            eq: mockDeleteEq,
          }),
        };
      }
      return {};
    });

    mockStorageFrom.mockReturnValue({
      remove: vi.fn().mockResolvedValue({ error: null }),
    });

    const { DELETE } = await import("@/app/api/attachments/[id]/route");
    const request = new NextRequest("http://localhost:3000/api/attachments/att-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, { params });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to delete attachment record");
  });
});
