import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ImportBatchRequest } from "@/lib/import/types";

// Mock dependencies
const mockGetAuthenticatedUser = vi.fn();
const mockErrorResponse = vi.fn();
const mockSuccessResponse = vi.fn();
const mockConvertEnmlToBlocks = vi.fn();

vi.mock("@/lib/api/utils", () => ({
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
  errorResponse: (...args: unknown[]) => mockErrorResponse(...args),
  successResponse: (...args: unknown[]) => mockSuccessResponse(...args),
}));

vi.mock("@/lib/import/enml-to-blocknote", () => ({
  convertEnmlToBlocks: (...args: unknown[]) => mockConvertEnmlToBlocks(...args),
}));

// Mock Supabase client methods
const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockSingle = vi.fn();
const mockUpdate = vi.fn();
const mockEq = vi.fn();
const mockUpload = vi.fn();
const mockCreateSignedUrl = vi.fn();
const mockRemove = vi.fn();

const mockSupabase = {
  from: vi.fn(() => ({
    insert: mockInsert.mockReturnValue({
      select: mockSelect.mockReturnValue({
        single: mockSingle,
      }),
    }),
    update: mockUpdate.mockReturnValue({
      eq: mockEq.mockReturnValue({ error: null }),
    }),
  })),
  storage: {
    from: vi.fn(() => ({
      upload: mockUpload,
      createSignedUrl: mockCreateSignedUrl,
      remove: mockRemove,
    })),
  },
};

describe("POST /api/import/evernote", () => {
  let POST: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockErrorResponse.mockImplementation(
      (msg: string, status: number) => new Response(JSON.stringify({ error: msg }), { status }),
    );
    mockSuccessResponse.mockImplementation(
      (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    );
    mockConvertEnmlToBlocks.mockReturnValue([{ type: "paragraph", content: [] }]);

    // Default: authenticated user
    mockGetAuthenticatedUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "test@test.com" }, supabase: mockSupabase },
      error: null,
    });

    vi.resetModules();
    const mod = await import("@/app/api/import/evernote/route");
    POST = mod.POST;
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAuthenticatedUser.mockResolvedValue({
      data: null,
      error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: [] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 for empty notes array", async () => {
    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: [] }),
    });

    await POST(req);
    expect(mockErrorResponse).toHaveBeenCalledWith("No notes provided", 400);
  });

  it("returns 400 for more than 5 notes", async () => {
    const notes = Array.from({ length: 6 }, (_, i) => ({
      title: `Note ${i}`,
      content: "<en-note></en-note>",
      created: "2023-01-01T00:00:00.000Z",
      updated: "2023-01-01T00:00:00.000Z",
      resources: [],
    }));

    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });

    await POST(req);
    expect(mockErrorResponse).toHaveBeenCalledWith("Maximum 5 notes per batch", 400);
  });

  it("creates a notebook when notebookId is not provided", async () => {
    mockSingle.mockResolvedValueOnce({
      data: { id: "nb-1" },
      error: null,
    });
    // Note insert
    mockSingle.mockResolvedValueOnce({
      data: { id: "note-1" },
      error: null,
    });

    const body: ImportBatchRequest = {
      notebookName: "Test Notebook",
      notes: [
        {
          title: "Note 1",
          content: "<en-note><p>Hello</p></en-note>",
          created: "2023-01-01T00:00:00.000Z",
          updated: "2023-01-01T00:00:00.000Z",
          resources: [],
        },
      ],
    };

    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await POST(req);

    expect(mockSupabase.from).toHaveBeenCalledWith("notebooks");
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ name: "Test Notebook" }));
    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({ notebookId: "nb-1", notesImported: 1 }),
      200,
    );
  });

  it("handles partial failure — continues on note error", async () => {
    // Notebook creation
    mockSingle.mockResolvedValueOnce({
      data: { id: "nb-1" },
      error: null,
    });
    // First note insert succeeds
    mockSingle.mockResolvedValueOnce({
      data: { id: "note-1" },
      error: null,
    });
    // Second note insert fails
    mockSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "DB error" },
    });

    const body: ImportBatchRequest = {
      notebookName: "Import",
      notes: [
        {
          title: "Good Note",
          content: "<en-note><p>ok</p></en-note>",
          created: "2023-01-01T00:00:00.000Z",
          updated: "2023-01-01T00:00:00.000Z",
          resources: [],
        },
        {
          title: "Bad Note",
          content: "<en-note><p>fail</p></en-note>",
          created: "2023-01-01T00:00:00.000Z",
          updated: "2023-01-01T00:00:00.000Z",
          resources: [],
        },
      ],
    };

    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await POST(req);

    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        notesImported: 1,
        notesFailed: 1,
        errors: expect.arrayContaining([expect.stringContaining("Bad Note")]),
      }),
      200,
    );
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    await POST(req);
    expect(mockErrorResponse).toHaveBeenCalledWith("Invalid JSON body", 400);
  });

  it("uses existing notebookId when provided", async () => {
    // Note insert
    mockSingle.mockResolvedValueOnce({
      data: { id: "note-1" },
      error: null,
    });

    const body: ImportBatchRequest = {
      notebookId: "existing-nb",
      notes: [
        {
          title: "Note 1",
          content: "<en-note><p>Hello</p></en-note>",
          created: "2023-01-01T00:00:00.000Z",
          updated: "2023-01-01T00:00:00.000Z",
          resources: [],
        },
      ],
    };

    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await POST(req);

    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({ notebookId: "existing-nb", notesImported: 1 }),
      200,
    );
  });

  it("returns 500 when notebook creation fails", async () => {
    mockSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "DB error" },
    });

    const body: ImportBatchRequest = {
      notebookName: "Fail Notebook",
      notes: [
        {
          title: "Note",
          content: "<en-note></en-note>",
          created: "2023-01-01T00:00:00.000Z",
          updated: "2023-01-01T00:00:00.000Z",
          resources: [],
        },
      ],
    };

    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await POST(req);
    expect(mockErrorResponse).toHaveBeenCalledWith("Failed to create notebook", 500);
  });

  it("uploads attachments and maps them for ENML conversion", async () => {
    // Notebook creation
    mockSingle.mockResolvedValueOnce({
      data: { id: "nb-1" },
      error: null,
    });
    // Note insert
    mockSingle.mockResolvedValueOnce({
      data: { id: "note-1" },
      error: null,
    });
    // Attachment DB insert
    mockSingle.mockResolvedValueOnce({
      data: { id: "att-1" },
      error: null,
    });

    mockUpload.mockResolvedValue({ error: null });
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://storage.example.com/file.png" },
      error: null,
    });

    const body: ImportBatchRequest = {
      notebookName: "Import",
      notes: [
        {
          title: "Note with attachment",
          content: '<en-note><en-media type="image/png" hash="abc123"/></en-note>',
          created: "2023-01-01T00:00:00.000Z",
          updated: "2023-01-01T00:00:00.000Z",
          resources: [
            {
              data: "aGVsbG8=", // base64 "hello"
              mime: "image/png",
              hash: "abc123",
              fileName: "photo.png",
            },
          ],
        },
      ],
    };

    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await POST(req);

    expect(mockUpload).toHaveBeenCalled();
    expect(mockCreateSignedUrl).toHaveBeenCalled();
    expect(mockConvertEnmlToBlocks).toHaveBeenCalledWith(expect.any(String), expect.any(Map));
    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({ notesImported: 1 }),
      200,
    );
  });

  it("continues import when attachment upload fails", async () => {
    // Notebook creation
    mockSingle.mockResolvedValueOnce({
      data: { id: "nb-1" },
      error: null,
    });
    // Note insert
    mockSingle.mockResolvedValueOnce({
      data: { id: "note-1" },
      error: null,
    });

    mockUpload.mockResolvedValue({ error: { message: "Upload failed" } });

    const body: ImportBatchRequest = {
      notebookName: "Import",
      notes: [
        {
          title: "Note with bad attachment",
          content: "<en-note><p>Hello</p></en-note>",
          created: "2023-01-01T00:00:00.000Z",
          updated: "2023-01-01T00:00:00.000Z",
          resources: [
            {
              data: "aGVsbG8=",
              mime: "image/png",
              hash: "abc",
              fileName: "bad.png",
            },
          ],
        },
      ],
    };

    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await POST(req);

    // Note should still be imported even if attachment fails
    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({ notesImported: 1 }),
      200,
    );
  });

  it("cleans up storage when attachment DB insert fails", async () => {
    // Notebook creation
    mockSingle.mockResolvedValueOnce({
      data: { id: "nb-1" },
      error: null,
    });
    // Note insert
    mockSingle.mockResolvedValueOnce({
      data: { id: "note-1" },
      error: null,
    });
    // Attachment DB insert fails
    mockSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "DB insert failed" },
    });

    mockUpload.mockResolvedValue({ error: null });
    mockRemove.mockResolvedValue({ error: null });

    const body: ImportBatchRequest = {
      notebookName: "Import",
      notes: [
        {
          title: "Note",
          content: "<en-note><p>Hello</p></en-note>",
          created: "2023-01-01T00:00:00.000Z",
          updated: "2023-01-01T00:00:00.000Z",
          resources: [
            {
              data: "aGVsbG8=",
              mime: "image/png",
              hash: "abc",
              fileName: "file.png",
            },
          ],
        },
      ],
    };

    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await POST(req);

    // Should clean up the uploaded file when DB insert fails
    expect(mockRemove).toHaveBeenCalled();
    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({ notesImported: 1 }),
      200,
    );
  });

  it("handles content update failure", async () => {
    // Notebook creation
    mockSingle.mockResolvedValueOnce({
      data: { id: "nb-1" },
      error: null,
    });
    // Note insert
    mockSingle.mockResolvedValueOnce({
      data: { id: "note-1" },
      error: null,
    });

    // Make update fail
    mockEq.mockReturnValueOnce({ error: { message: "Update failed" } });

    const body: ImportBatchRequest = {
      notebookName: "Import",
      notes: [
        {
          title: "Update Fail Note",
          content: "<en-note><p>Hello</p></en-note>",
          created: "2023-01-01T00:00:00.000Z",
          updated: "2023-01-01T00:00:00.000Z",
          resources: [],
        },
      ],
    };

    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await POST(req);

    expect(mockSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        notesFailed: 1,
        errors: expect.arrayContaining([expect.stringContaining("Update Fail Note")]),
      }),
      200,
    );
  });

  it("returns 400 when notes is not an array", async () => {
    const req = new Request("http://localhost/api/import/evernote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "not-array" }),
    });

    await POST(req);
    expect(mockErrorResponse).toHaveBeenCalledWith("No notes provided", 400);
  });
});
