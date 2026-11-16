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

// after() runs its task once the response is sent; collect the tasks to run them later.
const afterTasks: Array<() => unknown> = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    afterTasks.push(task);
  },
}));
const runAfterTasks = () => Promise.all(afterTasks.splice(0).map((task) => task()));

const mockRemoveUserOrphanedAttachments = vi.fn();
vi.mock("@/lib/storage/remove-orphaned-attachments", () => ({
  removeUserOrphanedAttachments: (...args: unknown[]) => mockRemoveUserOrphanedAttachments(...args),
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
    // The delete's .eq() filters, as [column, value]: the route may only delete the
    // user's own note, and only while it is in the trash.
    let deleteFilters: Array<[string, unknown]>;
    const OWN_TRASHED_NOTE_FILTERS = [
      ["id", "note-1"],
      ["user_id", "user-1"],
      ["is_trashed", true],
    ];

    type DeleteResult = { data: { id: string } | null; error: { message: string } | null };
    interface DeleteFilter {
      eq: (column: string, value: unknown) => DeleteFilter;
      select: () => { single: () => Promise<DeleteResult> };
    }

    function mockNoteDelete(result: DeleteResult = { data: { id: "note-1" }, error: null }) {
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        if (table === "notes") {
          return {
            delete: () => {
              calls.push("delete-note");
              const filter: DeleteFilter = {
                eq: (column: string, value: unknown) => {
                  deleteFilters.push([column, value]);
                  return filter;
                },
                select: () => ({ single: () => Promise.resolve(result) }),
              };
              return filter;
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
      deleteFilters = [];
      afterTasks.length = 0;
      mockRemoveUserOrphanedAttachments.mockImplementation(() => {
        calls.push("remove-files");
        return Promise.resolve();
      });
    });

    it("returns 401 when not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

      const response = await callDelete();
      expect(response.status).toBe(401);
      expect(mockRemoveUserOrphanedAttachments).not.toHaveBeenCalled();
    });

    it("returns 404 and leaves storage alone when the note isn't a trashed note of the user", async () => {
      authenticateAs("user-1");
      mockNoteDelete({ data: null, error: { message: "Not found" } });

      const response = await callDelete();
      expect(response.status).toBe(404);
      expect(deleteFilters).toEqual(OWN_TRASHED_NOTE_FILTERS);
      expect(afterTasks).toHaveLength(0);
      expect(mockRemoveUserOrphanedAttachments).not.toHaveBeenCalled();
    });

    it("deletes the note, then sweeps the user's orphaned files after the response", async () => {
      authenticateAs("user-1");
      mockNoteDelete();

      const response = await callDelete();
      expect(response.status).toBe(200);
      expect(deleteFilters).toEqual(OWN_TRASHED_NOTE_FILTERS);
      // Deferred: nothing is swept until after() runs its task.
      expect(calls).toEqual(["delete-note"]);
      await runAfterTasks();
      expect(calls).toEqual(["delete-note", "remove-files"]);
      expect(mockRemoveUserOrphanedAttachments).toHaveBeenCalledWith("user-1", "web-trash");
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
