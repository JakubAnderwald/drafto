import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Shared mocks ---

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    CRON_SECRET: "test-cron-secret",
  },
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockStorageFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    rpc: mockRpc,
    storage: { from: mockStorageFrom },
  }),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

// --- Helpers ---

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
}

function mockApprovalStatus(isApproved: boolean, isAdmin = false) {
  mockFrom.mockImplementation((table: string) => {
    if (table === "profiles") {
      return {
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: { is_approved: isApproved, is_admin: isAdmin },
                error: null,
              }),
          }),
        }),
      };
    }
    return defaultTableMock(table);
  });
}

function defaultTableMock(table: string) {
  if (table === "notebooks") {
    return {
      select: () => ({
        order: () => Promise.resolve({ data: [], error: null }),
        eq: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: { id: "nb-1" }, error: null }),
          }),
        }),
      }),
      insert: () => ({
        select: () => ({
          single: () =>
            Promise.resolve({
              data: { id: "nb-1", name: "Test", user_id: "user-1" },
              error: null,
            }),
        }),
      }),
    };
  }
  if (table === "notes") {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: { id: "note-1" }, error: null }),
            order: () => Promise.resolve({ data: [], error: null }),
          }),
          order: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    };
  }
  return {};
}

// ============================================================
// SECURITY TEST SUITE
// ============================================================

describe("Security Audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------
  // 1. Unapproved users blocked at API layer
  // -----------------------------------------------------------
  describe("Unapproved users are blocked from all API routes", () => {
    beforeEach(() => {
      authenticateAs("unapproved-user-1");
      mockApprovalStatus(false);
    });

    it("GET /api/notebooks returns 403 for unapproved users", async () => {
      const { GET } = await import("@/app/api/notebooks/route");
      const response = await GET();
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Forbidden");
    });

    it("POST /api/notebooks returns 403 for unapproved users", async () => {
      const { POST } = await import("@/app/api/notebooks/route");
      const request = new NextRequest("http://localhost:3000/api/notebooks", {
        method: "POST",
        body: JSON.stringify({ name: "Hack" }),
        headers: { "content-type": "application/json" },
      });
      const response = await POST(request);
      expect(response.status).toBe(403);
    });

    it("POST /api/notes/[id]/attachments returns 403 for unapproved users", async () => {
      const { POST } = await import("@/app/api/notes/[id]/attachments/route");
      const file = new File(["test"], "test.png", { type: "image/png" });
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments", {
        method: "POST",
      });
      const formData = new FormData();
      formData.append("file", file);
      vi.spyOn(request, "formData").mockResolvedValue(formData);
      const response = await POST(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(403);
    });

    it("DELETE /api/attachments/[id] returns 403 for unapproved users", async () => {
      const { DELETE } = await import("@/app/api/attachments/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/attachments/att-1", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params: Promise.resolve({ id: "att-1" }) });
      expect(response.status).toBe(403);
    });

    it("PATCH /api/notebooks/[id] returns 403 for unapproved users", async () => {
      const { PATCH } = await import("@/app/api/notebooks/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
        method: "PATCH",
        body: JSON.stringify({ name: "Hack" }),
        headers: { "content-type": "application/json" },
      });
      const response = await PATCH(request, { params: Promise.resolve({ id: "nb-1" }) });
      expect(response.status).toBe(403);
    });

    it("DELETE /api/notebooks/[id] returns 403 for unapproved users", async () => {
      const { DELETE } = await import("@/app/api/notebooks/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params: Promise.resolve({ id: "nb-1" }) });
      expect(response.status).toBe(403);
    });

    it("GET /api/notebooks/[id]/notes returns 403 for unapproved users", async () => {
      const { GET } = await import("@/app/api/notebooks/[id]/notes/route");
      const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1/notes");
      const response = await GET(request, { params: Promise.resolve({ id: "nb-1" }) });
      expect(response.status).toBe(403);
    });

    it("POST /api/notebooks/[id]/notes returns 403 for unapproved users", async () => {
      const { POST } = await import("@/app/api/notebooks/[id]/notes/route");
      const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1/notes", {
        method: "POST",
      });
      const response = await POST(request, { params: Promise.resolve({ id: "nb-1" }) });
      expect(response.status).toBe(403);
    });

    it("GET /api/notes/[id] returns 403 for unapproved users", async () => {
      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(403);
    });

    it("PATCH /api/notes/[id] returns 403 for unapproved users", async () => {
      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({ title: "Hack" }),
        headers: { "content-type": "application/json" },
      });
      const response = await PATCH(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(403);
    });

    it("DELETE /api/notes/[id] returns 403 for unapproved users", async () => {
      const { DELETE } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(403);
    });

    it("GET /api/notes/trash returns 403 for unapproved users", async () => {
      const { GET } = await import("@/app/api/notes/trash/route");
      const response = await GET();
      expect(response.status).toBe(403);
    });

    it("DELETE /api/notes/[id]/permanent returns 403 for unapproved users", async () => {
      const { DELETE } = await import("@/app/api/notes/[id]/permanent/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/permanent", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(403);
    });

    it("GET /api/notes/[id]/attachments returns 403 for unapproved users", async () => {
      const { GET } = await import("@/app/api/notes/[id]/attachments/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments");
      const response = await GET(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(403);
    });
  });

  // -----------------------------------------------------------
  // 2. Cross-user data access blocked
  // -----------------------------------------------------------
  describe("Cross-user data access is blocked", () => {
    it("user cannot access another user's notebook via API", async () => {
      authenticateAs("user-2");

      // Profile check passes (approved)
      mockFrom.mockImplementation((table: string) => {
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
        if (table === "notebooks") {
          // RLS would filter: user-2 cannot see user-1's notebook
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { code: "PGRST116", message: "Not found" },
                    }),
                }),
              }),
            }),
            update: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    single: () =>
                      Promise.resolve({
                        data: null,
                        error: { code: "PGRST116", message: "Not found" },
                      }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const { PATCH } = await import("@/app/api/notebooks/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
        method: "PATCH",
        body: JSON.stringify({ name: "Stolen" }),
        headers: { "content-type": "application/json" },
      });
      const response = await PATCH(request, { params: Promise.resolve({ id: "nb-1" }) });
      expect(response.status).toBe(404);
    });

    it("user cannot access another user's note via API", async () => {
      authenticateAs("user-2");

      mockFrom.mockImplementation((table: string) => {
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
        if (table === "notes") {
          // RLS blocks: user-2 cannot see user-1's note
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { code: "PGRST116", message: "Not found" },
                    }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const { GET } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1");
      const response = await GET(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(404);
    });

    it("user cannot update another user's note", async () => {
      authenticateAs("user-2");

      mockFrom.mockImplementation((table: string) => {
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
        if (table === "notes") {
          // RLS + eq(user_id) blocks update: user-2 cannot modify user-1's note
          return {
            update: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    single: () =>
                      Promise.resolve({
                        data: null,
                        error: { code: "PGRST116", message: "Not found" },
                      }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({ title: "Stolen" }),
        headers: { "content-type": "application/json" },
      });
      const response = await PATCH(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(404);
    });

    it("user cannot permanently delete another user's trashed note", async () => {
      authenticateAs("user-2");

      mockFrom.mockImplementation((table: string) => {
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
        if (table === "attachments") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          };
        }
        if (table === "notes") {
          // RLS blocks: user-2 cannot delete user-1's note
          return {
            delete: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    select: () => ({
                      single: () =>
                        Promise.resolve({
                          data: null,
                          error: { code: "PGRST116", message: "Not found" },
                        }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const { DELETE } = await import("@/app/api/notes/[id]/permanent/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/permanent", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(404);
    });

    it("user cannot upload to another user's note", async () => {
      authenticateAs("user-2");

      mockFrom.mockImplementation((table: string) => {
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
        if (table === "notes") {
          // RLS: note belongs to user-1, user-2 can't see it
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { code: "PGRST116", message: "Not found" },
                    }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const { POST } = await import("@/app/api/notes/[id]/attachments/route");
      const file = new File(["exploit"], "malicious.bin", { type: "application/octet-stream" });
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments", {
        method: "POST",
      });
      const formData = new FormData();
      formData.append("file", file);
      vi.spyOn(request, "formData").mockResolvedValue(formData);
      const response = await POST(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Note not found");
    });

    it("user cannot delete another user's attachment", async () => {
      authenticateAs("user-2");

      mockFrom.mockImplementation((table: string) => {
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
        if (table === "attachments") {
          // RLS + .eq("user_id") blocks: user-2 cannot see user-1's attachment
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { code: "PGRST116", message: "Not found" },
                    }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const { DELETE } = await import("@/app/api/attachments/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/attachments/att-1", {
        method: "DELETE",
      });
      const response = await DELETE(request, { params: Promise.resolve({ id: "att-1" }) });
      expect(response.status).toBe(404);
    });
  });

  // -----------------------------------------------------------
  // 3. File upload security
  // -----------------------------------------------------------
  describe("File upload security", () => {
    beforeEach(() => {
      authenticateAs("user-1");
    });

    function mockApprovedWithNotes() {
      mockFrom.mockImplementation((table: string) => {
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
        if (table === "notes") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: () =>
                    Promise.resolve({
                      data: { id: "note-1" },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        if (table === "attachments") {
          return {
            insert: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: {
                      id: "att-1",
                      note_id: "note-1",
                      user_id: "user-1",
                      file_name: "sanitized_name.txt",
                      file_path: "user-1/note-1/sanitized_name.txt",
                      file_size: 100,
                      mime_type: "text/plain",
                      created_at: "2026-03-03T00:00:00Z",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        return {};
      });

      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockResolvedValue({
          data: { path: "user-1/note-1/sanitized_name.txt" },
          error: null,
        }),
        createSignedUrl: vi.fn().mockResolvedValue({
          data: { signedUrl: "https://test.supabase.co/storage/signed/test?token=abc" },
          error: null,
        }),
        remove: vi.fn(),
      });
    }

    it("sanitizes path traversal characters in filenames", async () => {
      mockApprovedWithNotes();

      const uploadMock = mockStorageFrom().upload;

      const { POST } = await import("@/app/api/notes/[id]/attachments/route");
      const file = new File(["payload"], "../../etc/passwd", { type: "text/plain" });
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments", {
        method: "POST",
      });
      const formData = new FormData();
      formData.append("file", file);
      vi.spyOn(request, "formData").mockResolvedValue(formData);

      const response = await POST(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(201);

      // The upload path should NOT contain ".." or "/"
      const uploadPath = uploadMock.mock.calls[0]?.[0] as string;
      expect(uploadPath).not.toContain("..");
      expect(uploadPath).toMatch(/^user-1\/note-1\//);
      // Slashes in the filename portion should be replaced
      const filenameInPath = uploadPath.replace("user-1/note-1/", "");
      expect(filenameInPath).not.toContain("/");
      expect(filenameInPath).not.toContain("\\");
    });

    it("sanitizes HTML-special characters in filenames", async () => {
      mockApprovedWithNotes();

      const uploadMock = mockStorageFrom().upload;

      const { POST } = await import("@/app/api/notes/[id]/attachments/route");
      const file = new File(["payload"], '<script>alert("xss")</script>.txt', {
        type: "text/plain",
      });
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments", {
        method: "POST",
      });
      const formData = new FormData();
      formData.append("file", file);
      vi.spyOn(request, "formData").mockResolvedValue(formData);

      const response = await POST(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(201);

      const uploadPath = uploadMock.mock.calls[0]?.[0] as string;
      const filenameInPath = uploadPath.replace("user-1/note-1/", "");
      expect(filenameInPath).not.toContain("<");
      expect(filenameInPath).not.toContain(">");
      expect(filenameInPath).not.toContain('"');
    });

    it("accepts file at exact 25MB boundary", async () => {
      mockApprovedWithNotes();

      const { POST } = await import("@/app/api/notes/[id]/attachments/route");
      const content = new ArrayBuffer(26214400); // exactly 25MB
      const file = new File([content], "exact25mb.bin", {
        type: "application/octet-stream",
      });
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments", {
        method: "POST",
      });
      const formData = new FormData();
      formData.append("file", file);
      vi.spyOn(request, "formData").mockResolvedValue(formData);

      const response = await POST(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(201);
    });

    it("rejects files exceeding 25MB limit", async () => {
      mockApprovedWithNotes();

      const { POST } = await import("@/app/api/notes/[id]/attachments/route");
      const largeContent = new ArrayBuffer(26214401);
      const file = new File([largeContent], "huge.bin", {
        type: "application/octet-stream",
      });
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments", {
        method: "POST",
      });
      const formData = new FormData();
      formData.append("file", file);
      vi.spyOn(request, "formData").mockResolvedValue(formData);

      const response = await POST(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(413);
    });

    it("blocks upload to a note owned by another user", async () => {
      authenticateAs("user-2");
      // user-2 is approved but does not own note-1
      mockFrom.mockImplementation((table: string) => {
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
        if (table === "notes") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { code: "PGRST116", message: "Not found" },
                    }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const { POST } = await import("@/app/api/notes/[id]/attachments/route");
      const file = new File(["test"], "test.png", { type: "image/png" });
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/attachments", {
        method: "POST",
      });
      const formData = new FormData();
      formData.append("file", file);
      vi.spyOn(request, "formData").mockResolvedValue(formData);

      const response = await POST(request, { params: Promise.resolve({ id: "note-1" }) });
      expect(response.status).toBe(404);
    });
  });

  // -----------------------------------------------------------
  // 4. Cron route security
  // -----------------------------------------------------------
  describe("Cron route security", () => {
    it("allows access with valid cron secret", async () => {
      // No user auth needed — cron secret header is sufficient
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: "Not authenticated" },
      });
      mockRpc.mockResolvedValue({ data: 3, error: null });

      const { POST } = await import("@/app/api/cron/cleanup-trash/route");
      const request = new NextRequest("http://localhost:3000/api/cron/cleanup-trash", {
        method: "POST",
        headers: { authorization: "Bearer test-cron-secret" },
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toBe(3);
    });

    it("rejects access with invalid cron secret", async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: "Not authenticated" },
      });

      const { POST } = await import("@/app/api/cron/cleanup-trash/route");
      const request = new NextRequest("http://localhost:3000/api/cron/cleanup-trash", {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret" },
      });
      const response = await POST(request);
      // Falls through to admin auth, which also fails → 401
      expect(response.status).toBe(401);
    });

    it("rejects non-admin users without cron secret", async () => {
      authenticateAs("regular-user");
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: { is_approved: true, is_admin: false },
                    error: null,
                  }),
              }),
            }),
          };
        }
        return {};
      });

      const { POST } = await import("@/app/api/cron/cleanup-trash/route");
      const request = new NextRequest("http://localhost:3000/api/cron/cleanup-trash", {
        method: "POST",
      });
      const response = await POST(request);
      expect(response.status).toBe(403);
    });
  });

  // -----------------------------------------------------------
  // 5. Admin privilege escalation prevention
  // -----------------------------------------------------------
  describe("Admin privilege escalation prevention", () => {
    it("non-admin cannot approve users via admin API", async () => {
      authenticateAs("regular-user");
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: { is_approved: true, is_admin: false },
                error: null,
              }),
          }),
        }),
        update: vi.fn(),
      });

      const { POST } = await import("@/app/api/admin/approve-user/route");
      const request = new NextRequest("http://localhost:3000/api/admin/approve-user", {
        method: "POST",
        body: JSON.stringify({ userId: "victim-user" }),
        headers: { "content-type": "application/json" },
      });
      const response = await POST(request);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Forbidden");
    });

    it("unapproved user cannot approve themselves", async () => {
      authenticateAs("sneaky-user");
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: { is_approved: false, is_admin: false },
                error: null,
              }),
          }),
        }),
      });

      const { POST } = await import("@/app/api/admin/approve-user/route");
      const request = new NextRequest("http://localhost:3000/api/admin/approve-user", {
        method: "POST",
        body: JSON.stringify({ userId: "sneaky-user" }),
        headers: { "content-type": "application/json" },
      });
      const response = await POST(request);
      // Blocked by getAuthenticatedUser() approval check
      expect(response.status).toBe(403);
    });
  });

  // -----------------------------------------------------------
  // 6. getAuthenticatedUser approval check
  // -----------------------------------------------------------
  describe("getAuthenticatedUser approval enforcement", () => {
    it("returns 403 when user exists but is not approved", async () => {
      authenticateAs("unapproved-1");
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: { is_approved: false },
                error: null,
              }),
          }),
        }),
      });

      const { getAuthenticatedUser } = await import("@/lib/api/utils");
      const result = await getAuthenticatedUser();

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.error!.status).toBe(403);
    });

    it("returns user data when user is approved", async () => {
      authenticateAs("approved-1");
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: { is_approved: true },
                error: null,
              }),
          }),
        }),
      });

      const { getAuthenticatedUser } = await import("@/lib/api/utils");
      const result = await getAuthenticatedUser();

      expect(result.error).toBeNull();
      expect(result.data!.user.id).toBe("approved-1");
    });

    it("returns 403 when profile query fails", async () => {
      authenticateAs("user-1");
      mockFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: null,
                error: { message: "DB error" },
              }),
          }),
        }),
      });

      const { getAuthenticatedUser } = await import("@/lib/api/utils");
      const result = await getAuthenticatedUser();

      expect(result.data).toBeNull();
      expect(result.error!.status).toBe(403);
    });
  });
});
