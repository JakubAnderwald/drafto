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

const { PATCH, DELETE } = await import("@/app/api/notebooks/[id]/route");

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
    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return {};
    });

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
    afterTasks.length = 0;
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

    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      // notes count check
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ count: 3, error: null }),
            }),
          }),
        }),
      };
    });

    const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, { params });
    expect(response.status).toBe(409);
    expect(mockRemoveUserOrphanedAttachments).not.toHaveBeenCalled();
  });

  it("deletes an empty notebook", async () => {
    authenticateAs("user-1");

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      callCount++;
      if (callCount === 1) {
        // notes count check - empty
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ count: 0, error: null }),
              }),
            }),
          }),
        };
      }
      // delete call
      return {
        delete: () => ({
          eq: () => ({
            eq: () => {
              calls.push("delete-notebook");
              return Promise.resolve({ error: null });
            },
          }),
        }),
      };
    });
    const calls: string[] = [];
    mockRemoveUserOrphanedAttachments.mockImplementation(() => {
      calls.push("remove-files");
      return Promise.resolve();
    });

    const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, { params });
    expect(response.status).toBe(200);
    // Its trashed notes cascade with it, so their files are swept once the response is sent.
    expect(calls).toEqual(["delete-notebook"]);
    await runAfterTasks();
    expect(calls).toEqual(["delete-notebook", "remove-files"]);
    expect(mockRemoveUserOrphanedAttachments).toHaveBeenCalledWith("user-1", "web-notebooks");
  });

  it("returns 500 and sweeps nothing when the delete fails", async () => {
    authenticateAs("user-1");

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      callCount++;
      if (callCount === 1) {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ count: 0, error: null }),
              }),
            }),
          }),
        };
      }
      return {
        delete: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: { message: "DB error" } }),
          }),
        }),
      };
    });

    const request = new NextRequest("http://localhost:3000/api/notebooks/nb-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, { params });
    expect(response.status).toBe(500);
    expect(afterTasks).toHaveLength(0);
  });
});
