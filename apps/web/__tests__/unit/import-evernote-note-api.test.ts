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

const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockSingle = vi.fn();

const mockSupabase = {
  from: vi.fn(() => ({
    insert: mockInsert.mockReturnValue({
      select: mockSelect.mockReturnValue({ single: mockSingle }),
    }),
  })),
};

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
    mockSingle.mockResolvedValueOnce({ data: { id: "nb-1" }, error: null }); // notebook
    mockSingle.mockResolvedValueOnce({ data: { id: "note-1" }, error: null }); // note

    await POST(makeRequest(noteBody));

    expect(mockSupabase.from).toHaveBeenCalledWith("notebooks");
    expect(mockSupabase.from).toHaveBeenCalledWith("notes");
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "My Note",
        created_at: "2023-01-01T00:00:00.000Z",
        updated_at: "2023-02-02T00:00:00.000Z",
      }),
    );
    expect(mockSuccessResponse).toHaveBeenCalledWith({ notebookId: "nb-1", noteId: "note-1" }, 201);
  });

  it("reuses an existing notebookId without creating a notebook", async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: "note-1" }, error: null }); // note only

    await POST(makeRequest({ ...noteBody, notebookId: "existing-nb", notebookName: undefined }));

    expect(mockSupabase.from).not.toHaveBeenCalledWith("notebooks");
    expect(mockSuccessResponse).toHaveBeenCalledWith(
      { notebookId: "existing-nb", noteId: "note-1" },
      201,
    );
  });

  it("returns 400 when title is missing", async () => {
    await POST(makeRequest({ created: "x", updated: "y" }));
    expect(mockErrorResponse).toHaveBeenCalledWith("title is required", 400);
  });

  it("returns 500 when note insert fails", async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: "nb-1" }, error: null });
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });

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
