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

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
}

const params = Promise.resolve({ id: "note-1" });

function createFileRequest(file: File | null, noteId = "note-1"): NextRequest {
  const request = new NextRequest(`http://localhost:3000/api/notes/${noteId}/attachments`, {
    method: "POST",
  });
  const formData = new FormData();
  if (file) {
    formData.append("file", file);
  }
  // Mock formData() to avoid serialization issues in test environment
  vi.spyOn(request, "formData").mockResolvedValue(formData);
  return request;
}

function mockNoteExists(noteId = "note-1") {
  mockFrom.mockImplementation((table: string) => {
    if (table === "notes") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: noteId },
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
                  note_id: noteId,
                  user_id: "user-1",
                  file_name: "test.png",
                  file_path: `user-1/${noteId}/test.png`,
                  file_size: 1024,
                  mime_type: "image/png",
                  created_at: "2026-03-02T00:00:00Z",
                },
                error: null,
              }),
          }),
        }),
      };
    }
    return {};
  });
}

function mockNoteNotFound() {
  mockFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: null,
              error: { message: "Not found" },
            }),
        }),
      }),
    }),
  });
}

function mockStorageUploadSuccess() {
  mockStorageFrom.mockReturnValue({
    upload: () => Promise.resolve({ data: { path: "user-1/note-1/test.png" }, error: null }),
    createSignedUrl: () =>
      Promise.resolve({
        data: {
          signedUrl:
            "https://test.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/test.png?token=abc",
        },
        error: null,
      }),
    remove: vi.fn(),
  });
}

function mockStorageUploadFailure() {
  mockStorageFrom.mockReturnValue({
    upload: () => Promise.resolve({ data: null, error: { message: "Storage error" } }),
    remove: vi.fn(),
  });
}

describe("POST /api/notes/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Not auth" },
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/route");
    const file = new File(["test content"], "test.png", {
      type: "image/png",
    });
    const request = createFileRequest(file);
    const response = await POST(request, { params });
    expect(response.status).toBe(401);
  });

  it("returns 404 when note does not exist", async () => {
    authenticateAs("user-1");
    mockNoteNotFound();

    const { POST } = await import("@/app/api/notes/[id]/attachments/route");
    const file = new File(["test content"], "test.png", {
      type: "image/png",
    });
    const request = createFileRequest(file);
    const response = await POST(request, { params });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Note not found");
  });

  it("returns 400 when no file is provided", async () => {
    authenticateAs("user-1");
    mockNoteExists();

    const { POST } = await import("@/app/api/notes/[id]/attachments/route");
    const request = createFileRequest(null);
    const response = await POST(request, { params });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("No file provided");
  });

  it("returns 400 when file is empty", async () => {
    authenticateAs("user-1");
    mockNoteExists();

    const { POST } = await import("@/app/api/notes/[id]/attachments/route");
    const file = new File([], "empty.txt", { type: "text/plain" });
    const request = createFileRequest(file);
    const response = await POST(request, { params });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("File is empty");
  });

  it("returns 413 when file exceeds 25MB limit", async () => {
    authenticateAs("user-1");
    mockNoteExists();

    const { POST } = await import("@/app/api/notes/[id]/attachments/route");
    // Create a file that exceeds 25MB (26214401 bytes)
    const largeContent = new ArrayBuffer(26214401);
    const file = new File([largeContent], "large.bin", {
      type: "application/octet-stream",
    });
    const request = createFileRequest(file);
    const response = await POST(request, { params });
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toBe("File size exceeds 25MB limit");
  });

  it("returns 500 when storage upload fails", async () => {
    authenticateAs("user-1");
    mockNoteExists();
    mockStorageUploadFailure();

    const { POST } = await import("@/app/api/notes/[id]/attachments/route");
    const file = new File(["test content"], "test.png", {
      type: "image/png",
    });
    const request = createFileRequest(file);
    const response = await POST(request, { params });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to upload file");
  });

  it("uploads file and creates attachment record successfully", async () => {
    authenticateAs("user-1");
    mockNoteExists();
    mockStorageUploadSuccess();

    const { POST } = await import("@/app/api/notes/[id]/attachments/route");
    const file = new File(["test content"], "test.png", {
      type: "image/png",
    });
    const request = createFileRequest(file);
    const response = await POST(request, { params });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBe("att-1");
    expect(body.file_name).toBe("test.png");
    expect(body.mime_type).toBe("image/png");
    expect(body.note_id).toBe("note-1");
    expect(body.url).toContain("token=abc");
  });

  it("cleans up storage when DB insert fails", async () => {
    authenticateAs("user-1");
    const mockRemove = vi.fn().mockResolvedValue({ error: null });
    mockStorageFrom.mockReturnValue({
      upload: () =>
        Promise.resolve({
          data: { path: "user-1/note-1/test.png" },
          error: null,
        }),
      remove: mockRemove,
    });

    // Mock notes table success, attachments table failure
    mockFrom.mockImplementation((table: string) => {
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
                  data: null,
                  error: { message: "DB error" },
                }),
            }),
          }),
        };
      }
      return {};
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/route");
    const file = new File(["test content"], "test.png", {
      type: "image/png",
    });
    const request = createFileRequest(file);
    const response = await POST(request, { params });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to save attachment record");
    expect(mockRemove).toHaveBeenCalledWith(["user-1/note-1/test.png"]);
  });
});
