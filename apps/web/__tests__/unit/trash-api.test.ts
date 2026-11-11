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

const params = Promise.resolve({ id: "note-1" });

const mockRemoveNoteAttachments = vi.fn();
vi.mock("@/lib/storage/remove-user-attachments", () => ({
  removeNoteAttachments: (...args: unknown[]) => mockRemoveNoteAttachments(...args),
}));

const adminClient = { tag: "service-role" };
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: (...args: unknown[]) => mockCreateAdminClient(...args),
}));

const mockCaptureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

describe("Trash API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/notes/trash", () => {
    it("returns 401 when not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

      const { GET } = await import("@/app/api/notes/trash/route");
      const response = await GET(new NextRequest("http://localhost:3000/api/notes/trash"));
      expect(response.status).toBe(401);
    });

    it("returns trashed notes", async () => {
      authenticateAs("user-1");
      const trashedNotes = [
        { id: "note-1", title: "Trashed Note", notebook_id: "nb-1", trashed_at: "2026-01-01" },
      ];
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: trashedNotes, error: null }),
              }),
            }),
          }),
        };
      });

      const { GET } = await import("@/app/api/notes/trash/route");
      const response = await GET(new NextRequest("http://localhost:3000/api/notes/trash"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveLength(1);
      expect(body[0].title).toBe("Trashed Note");
    });

    it("returns 500 on database error", async () => {
      authenticateAs("user-1");
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: null, error: { message: "DB error" } }),
              }),
            }),
          }),
        };
      });

      const { GET } = await import("@/app/api/notes/trash/route");
      const response = await GET(new NextRequest("http://localhost:3000/api/notes/trash"));
      expect(response.status).toBe(500);
    });
  });

  describe("DELETE /api/notes/[id]/permanent", () => {
    // Records the order of the calls that matter: the note must be deleted
    // before its files are removed, so a failed or raced delete never costs a
    // live note its files.
    let calls: string[];

    function mockNoteDelete(
      result: { data: { id: string } | null; error: { message: string } | null } = {
        data: { id: "note-1" },
        error: null,
      },
    ) {
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        if (table === "notes") {
          return {
            delete: () => {
              calls.push("delete-note");
              return {
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      select: () => ({ single: () => Promise.resolve(result) }),
                    }),
                  }),
                }),
              };
            },
          };
        }
        return {};
      });
    }

    async function callDelete() {
      const { DELETE } = await import("@/app/api/notes/[id]/permanent/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1/permanent", {
        method: "DELETE",
      });
      return DELETE(request, { params });
    }

    beforeEach(() => {
      calls = [];
      mockCreateAdminClient.mockReturnValue(adminClient);
      mockRemoveNoteAttachments.mockImplementation(() => {
        calls.push("remove-files");
        return Promise.resolve();
      });
    });

    it("returns 401 when not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

      const response = await callDelete();
      expect(response.status).toBe(401);
      expect(mockRemoveNoteAttachments).not.toHaveBeenCalled();
    });

    it("returns 404 and leaves storage alone when the note isn't a trashed note of the user", async () => {
      authenticateAs("user-1");
      mockNoteDelete({ data: null, error: { message: "Not found" } });

      const response = await callDelete();
      expect(response.status).toBe(404);
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(mockRemoveNoteAttachments).not.toHaveBeenCalled();
    });

    it("deletes the note, then removes its folder's files with the service-role client", async () => {
      authenticateAs("user-1");
      mockNoteDelete();

      const response = await callDelete();
      expect(response.status).toBe(200);
      expect(calls).toEqual(["delete-note", "remove-files"]);
      expect(mockCreateAdminClient).toHaveBeenCalledWith("web-trash");
      expect(mockRemoveNoteAttachments).toHaveBeenCalledWith(adminClient, "user-1", "note-1");
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it("still succeeds, and reports to Sentry, when the service-role client is unavailable", async () => {
      authenticateAs("user-1");
      mockNoteDelete();
      const missingKey = new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
      mockCreateAdminClient.mockImplementation(() => {
        throw missingKey;
      });

      const response = await callDelete();
      expect(response.status).toBe(200);
      expect(calls).toEqual(["delete-note"]);
      expect(mockCaptureException).toHaveBeenCalledWith(missingKey, {
        extra: { where: "notes-permanent:storage", noteId: "note-1" },
      });
    });
  });

  describe("PATCH /api/notes/[id] (restore)", () => {
    it("returns 400 when is_trashed is not a boolean", async () => {
      authenticateAs("user-1");
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {};
      });

      const { PATCH } = await import("@/app/api/notes/[id]/route");
      const request = new NextRequest("http://localhost:3000/api/notes/note-1", {
        method: "PATCH",
        body: JSON.stringify({ is_trashed: "false" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await PATCH(request, { params });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("is_trashed must be a boolean");
    });

    it("restores a trashed note", async () => {
      authenticateAs("user-1");
      const restored = { id: "note-1", title: "Test", is_trashed: false, trashed_at: null };
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: () => Promise.resolve({ data: restored, error: null }),
                }),
              }),
            }),
          }),
        };
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
