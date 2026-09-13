import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { ImportNoteRequest } from "@/lib/import/types";

const mockGetAuthenticatedUser = vi.fn();
const mockErrorResponse = vi.fn();
const mockSuccessResponse = vi.fn();

vi.mock("@/lib/api/utils", () => ({
  getAuthenticatedUserFast: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
  errorResponse: (...args: unknown[]) => mockErrorResponse(...args),
  successResponse: (...args: unknown[]) => mockSuccessResponse(...args),
}));

// A chainable query builder whose .single() resolves queued results in order,
// so it can serve both the ownership lookup (select→eq→eq→single) and the
// inserts (insert→select→single).
const singleResults: Array<{ data: unknown; error: unknown }> = [];
const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const builder = {
  insert: (...a: unknown[]) => {
    mockInsert(...a);
    return builder;
  },
  select: (...a: unknown[]) => {
    mockSelect(...a);
    return builder;
  },
  eq: (...a: unknown[]) => {
    mockEq(...a);
    return builder;
  },
  single: () =>
    Promise.resolve(
      singleResults.shift() ?? { data: null, error: { message: "no result queued" } },
    ),
};
const mockFrom = vi.fn(() => builder);
const mockSupabase = { from: mockFrom };

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/import/evernote/note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/import/evernote/note", () => {
  let POST: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    singleResults.length = 0;
    mockErrorResponse.mockImplementation(
      (msg: string, status: number) => new Response(JSON.stringify({ error: msg }), { status }),
    );
    mockSuccessResponse.mockImplementation(
      (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    );
    mockGetAuthenticatedUser.mockResolvedValue({
      data: { user: { id: "user-1" }, supabase: mockSupabase },
      error: null,
    });
    vi.resetModules();
    const mod = await import("@/app/api/import/evernote/note/route");
    POST = mod.POST;
  });

  const noteBody: ImportNoteRequest = {
    notebookName: "Imported",
    title: "My Note",
    created: "2023-01-01T00:00:00.000Z",
    updated: "2023-02-02T00:00:00.000Z",
  };

  it("creates the notebook then the note, preserving title and timestamps", async () => {
    singleResults.push({ data: { id: "nb-1" }, error: null }); // notebook insert
    singleResults.push({ data: { id: "note-1" }, error: null }); // note insert

    await POST(makeRequest(noteBody));

    expect(mockFrom).toHaveBeenCalledWith("notebooks");
    expect(mockFrom).toHaveBeenCalledWith("notes");
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "My Note",
        created_at: "2023-01-01T00:00:00.000Z",
        updated_at: "2023-02-02T00:00:00.000Z",
      }),
    );
    expect(mockSuccessResponse).toHaveBeenCalledWith({ notebookId: "nb-1", noteId: "note-1" }, 201);
  });

  it("reuses an existing OWNED notebookId without creating a notebook", async () => {
    singleResults.push({ data: { id: "existing-nb" }, error: null }); // ownership lookup
    singleResults.push({ data: { id: "note-1" }, error: null }); // note insert

    await POST(makeRequest({ ...noteBody, notebookId: "existing-nb", notebookName: undefined }));

    // The ownership lookup ran, but no notebook was inserted (only the note).
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockEq).toHaveBeenCalledWith("user_id", "user-1");
    expect(mockSuccessResponse).toHaveBeenCalledWith(
      { notebookId: "existing-nb", noteId: "note-1" },
      201,
    );
  });

  it("rejects a notebookId not owned by the user (no note written)", async () => {
    singleResults.push({ data: null, error: { message: "not found" } }); // ownership lookup fails

    await POST(makeRequest({ ...noteBody, notebookId: "foreign-nb", notebookName: undefined }));

    expect(mockErrorResponse).toHaveBeenCalledWith("Notebook not found", 404);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 400 when title is missing", async () => {
    await POST(makeRequest({ created: "x", updated: "y" }));
    expect(mockErrorResponse).toHaveBeenCalledWith("title is required", 400);
  });

  it("returns 500 when note insert fails", async () => {
    singleResults.push({ data: { id: "nb-1" }, error: null }); // notebook insert ok
    singleResults.push({ data: null, error: { message: "boom" } }); // note insert fails

    await POST(makeRequest(noteBody));
    expect(mockErrorResponse).toHaveBeenCalledWith(
      expect.stringContaining("Failed to create note"),
      500,
    );
  });

  it("returns the auth error when unauthenticated", async () => {
    mockGetAuthenticatedUser.mockResolvedValue({
      data: null,
      error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });
    const res = await POST(makeRequest(noteBody));
    expect(res.status).toBe(401);
  });
});
