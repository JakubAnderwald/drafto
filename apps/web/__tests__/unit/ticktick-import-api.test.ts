import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { TickTickImportBatchRequest, TickTickItem } from "@/lib/import/ticktick-types";

const mockGetAuthenticatedUser = vi.fn();
const mockErrorResponse = vi.fn();
const mockSuccessResponse = vi.fn();

vi.mock("@/lib/api/utils", () => ({
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
  getAuthenticatedUserFast: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
  errorResponse: (...args: unknown[]) => mockErrorResponse(...args),
  successResponse: (...args: unknown[]) => mockSuccessResponse(...args),
}));

const notebookSingle = vi.fn();
const noteInsert = vi.fn();

const mockSupabase = {
  from: vi.fn((table: string) => {
    if (table === "notebooks") {
      return {
        insert: vi.fn(() => ({
          select: vi.fn(() => ({ single: notebookSingle })),
        })),
      };
    }
    return { insert: noteInsert };
  }),
};

function buildItem(overrides: Partial<TickTickItem> = {}): TickTickItem {
  return {
    folderName: "Work",
    listName: "Inbox",
    title: "Task",
    content: "body",
    isCheckList: false,
    created: "2025-01-01T00:00:00.000Z",
    updated: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("POST /api/import/ticktick", () => {
  let POST: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockErrorResponse.mockImplementation(
      (msg: string, status: number) => new Response(JSON.stringify({ error: msg }), { status }),
    );
    mockSuccessResponse.mockImplementation(
      (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    );

    mockGetAuthenticatedUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "test@test.com" }, supabase: mockSupabase },
      error: null,
    });

    noteInsert.mockResolvedValue({ error: null });

    vi.resetModules();
    const mod = await import("@/app/api/import/ticktick/route");
    POST = mod.POST;
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthenticatedUser.mockResolvedValue({
      data: null,
      error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const req = new NextRequest("http://localhost/api/import/ticktick", {
      method: "POST",
      body: JSON.stringify({ notebookName: "x", items: [] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/import/ticktick", {
      method: "POST",
      body: "not json",
    });

    await POST(req);
    expect(mockErrorResponse).toHaveBeenCalledWith("Invalid JSON body", 400);
  });

  it("returns 400 for empty items array", async () => {
    const req = new NextRequest("http://localhost/api/import/ticktick", {
      method: "POST",
      body: JSON.stringify({ notebookName: "x", items: [] }),
    });

    await POST(req);
    expect(mockErrorResponse).toHaveBeenCalledWith("No items provided", 400);
  });

  it("returns 400 when batch exceeds limit", async () => {
    const items = Array.from({ length: 21 }, (_, i) => buildItem({ title: `T${i}` }));
    const req = new NextRequest("http://localhost/api/import/ticktick", {
      method: "POST",
      body: JSON.stringify({ notebookName: "x", items }),
    });

    await POST(req);
    expect(mockErrorResponse).toHaveBeenCalledWith("Maximum 20 items per batch", 400);
  });

  it("creates a notebook on first batch and imports items", async () => {
    notebookSingle.mockResolvedValueOnce({ data: { id: "nb-1" }, error: null });

    const body: TickTickImportBatchRequest = {
      notebookName: "TickTick",
      items: [buildItem({ title: "Task A" }), buildItem({ title: "Task B" })],
    };

    const req = new NextRequest("http://localhost/api/import/ticktick", {
      method: "POST",
      body: JSON.stringify(body),
    });

    await POST(req);

    expect(mockSupabase.from).toHaveBeenCalledWith("notebooks");
    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({ notebookId: "nb-1", notesImported: 2, notesFailed: 0 }),
      200,
    );
  });

  it("reuses an existing notebookId", async () => {
    const body: TickTickImportBatchRequest = {
      notebookId: "existing-nb",
      notebookName: "Ignored",
      items: [buildItem()],
    };

    const req = new NextRequest("http://localhost/api/import/ticktick", {
      method: "POST",
      body: JSON.stringify(body),
    });

    await POST(req);

    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({ notebookId: "existing-nb", notesImported: 1 }),
      200,
    );
    expect(notebookSingle).not.toHaveBeenCalled();
  });

  it("counts failures without aborting the batch", async () => {
    notebookSingle.mockResolvedValueOnce({ data: { id: "nb-1" }, error: null });
    noteInsert
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: "constraint" } });

    const body: TickTickImportBatchRequest = {
      notebookName: "Test",
      items: [buildItem({ title: "Good" }), buildItem({ title: "Bad" })],
    };

    const req = new NextRequest("http://localhost/api/import/ticktick", {
      method: "POST",
      body: JSON.stringify(body),
    });

    await POST(req);

    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        notesImported: 1,
        notesFailed: 1,
        errors: expect.arrayContaining([expect.stringContaining("Bad")]),
      }),
      200,
    );
  });

  it("returns 500 when notebook creation fails", async () => {
    notebookSingle.mockResolvedValueOnce({ data: null, error: { message: "db error" } });

    const body: TickTickImportBatchRequest = {
      notebookName: "Fail",
      items: [buildItem()],
    };

    const req = new NextRequest("http://localhost/api/import/ticktick", {
      method: "POST",
      body: JSON.stringify(body),
    });

    await POST(req);
    expect(mockErrorResponse).toHaveBeenCalledWith("Failed to create notebook", 500);
  });

  it("rejects non-array items", async () => {
    const req = new NextRequest("http://localhost/api/import/ticktick", {
      method: "POST",
      body: JSON.stringify({ notebookName: "x", items: "not-array" }),
    });

    await POST(req);
    expect(mockErrorResponse).toHaveBeenCalledWith("No items provided", 400);
  });
});
