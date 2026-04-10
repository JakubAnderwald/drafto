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

function createUploadUrlRequest(body: Record<string, unknown>, noteId = "note-1"): NextRequest {
  return new NextRequest(`http://localhost:3000/api/notes/${noteId}/attachments/upload-url`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function createConfirmRequest(body: Record<string, unknown>, noteId = "note-1"): NextRequest {
  return new NextRequest(`http://localhost:3000/api/notes/${noteId}/attachments/confirm`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function mockNoteExists(noteId = "note-1") {
  mockFrom.mockImplementation((table: string) => {
    if (table === "profiles") return approvedProfile;
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
  mockFrom.mockImplementation((table: string) => {
    if (table === "profiles") return approvedProfile;
    return {
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
    };
  });
}

// ============================================================
// upload-url endpoint tests
// ============================================================

describe("POST /api/notes/[id]/attachments/upload-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Not auth" },
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/upload-url/route");
    const request = createUploadUrlRequest({
      fileName: "test.png",
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(401);
  });

  it("returns 404 when note does not exist", async () => {
    authenticateAs("user-1");
    mockNoteNotFound();

    const { POST } = await import("@/app/api/notes/[id]/attachments/upload-url/route");
    const request = createUploadUrlRequest({
      fileName: "test.png",
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(404);
  });

  it("returns 400 when fileName is missing", async () => {
    authenticateAs("user-1");
    mockNoteExists();

    const { POST } = await import("@/app/api/notes/[id]/attachments/upload-url/route");
    const request = createUploadUrlRequest({
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(400);
  });

  it("returns 400 when fileSize is zero", async () => {
    authenticateAs("user-1");
    mockNoteExists();

    const { POST } = await import("@/app/api/notes/[id]/attachments/upload-url/route");
    const request = createUploadUrlRequest({
      fileName: "test.png",
      fileSize: 0,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(400);
  });

  it("returns 413 when fileSize exceeds 25MB limit", async () => {
    authenticateAs("user-1");
    mockNoteExists();

    const { POST } = await import("@/app/api/notes/[id]/attachments/upload-url/route");
    const request = createUploadUrlRequest({
      fileName: "large.bin",
      fileSize: 26214401,
      mimeType: "application/octet-stream",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(413);
  });

  it("returns signed upload URL on success", async () => {
    authenticateAs("user-1");
    mockNoteExists();
    mockStorageFrom.mockReturnValue({
      createSignedUploadUrl: vi.fn().mockResolvedValue({
        data: {
          signedUrl: "https://test.supabase.co/storage/v1/upload/sign/attachments/path?token=xyz",
          token: "upload-token-123",
        },
        error: null,
      }),
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/upload-url/route");
    const request = createUploadUrlRequest({
      fileName: "test.png",
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.signedUrl).toContain("token=xyz");
    expect(body.token).toBe("upload-token-123");
    expect(body.filePath).toMatch(/^user-1\/note-1\/test-\d+\.png$/);
    expect(body.fileName).toMatch(/^test-\d+\.png$/);
  });

  it("sanitizes path traversal characters in filenames", async () => {
    authenticateAs("user-1");
    mockNoteExists();
    mockStorageFrom.mockReturnValue({
      createSignedUploadUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://test.supabase.co/signed", token: "tok" },
        error: null,
      }),
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/upload-url/route");
    const request = createUploadUrlRequest({
      fileName: "../../etc/passwd",
      fileSize: 100,
      mimeType: "text/plain",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.filePath).not.toContain("..");
    expect(body.filePath).toMatch(/^user-1\/note-1\//);
  });
});

// ============================================================
// confirm endpoint tests
// ============================================================

describe("POST /api/notes/[id]/attachments/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Not auth" },
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const request = createConfirmRequest({
      filePath: "user-1/note-1/test.png",
      fileName: "test.png",
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(401);
  });

  it("returns 404 when note does not exist", async () => {
    authenticateAs("user-1");
    mockNoteNotFound();

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const request = createConfirmRequest({
      filePath: "user-1/note-1/test.png",
      fileName: "test.png",
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(404);
  });

  it("returns 403 when filePath does not match user/note", async () => {
    authenticateAs("user-1");
    mockNoteExists();

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const request = createConfirmRequest({
      filePath: "user-2/note-1/test.png",
      fileName: "test.png",
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Invalid file path");
  });

  it("returns 400 when file not found in storage", async () => {
    authenticateAs("user-1");
    mockNoteExists();
    mockStorageFrom.mockReturnValue({
      createSignedUrl: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "Object not found" },
      }),
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const request = createConfirmRequest({
      filePath: "user-1/note-1/test.png",
      fileName: "test.png",
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("File not found in storage");
  });

  it("creates attachment record and returns signed URL on success", async () => {
    authenticateAs("user-1");
    mockNoteExists();
    mockStorageFrom.mockReturnValue({
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://test.supabase.co/storage/signed/test?token=abc" },
        error: null,
      }),
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const request = createConfirmRequest({
      filePath: "user-1/note-1/test-12345.png",
      fileName: "test-12345.png",
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBe("att-1");
    expect(body.url).toContain("token=abc");
  });

  it("cleans up DB record when signed URL generation fails", async () => {
    authenticateAs("user-1");
    const mockDelete = vi.fn();

    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      if (table === "notes") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { id: "note-1" }, error: null }),
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
                    file_name: "test.png",
                    file_path: "user-1/note-1/test.png",
                    file_size: 1024,
                    mime_type: "image/png",
                    created_at: "2026-03-02T00:00:00Z",
                  },
                  error: null,
                }),
            }),
          }),
          delete: () => ({
            eq: mockDelete,
          }),
        };
      }
      return {};
    });

    let callCount = 0;
    mockStorageFrom.mockReturnValue({
      createSignedUrl: vi.fn().mockImplementation(() => {
        callCount++;
        // First call (verify existence) succeeds, second call (7-day URL) fails
        if (callCount === 1) {
          return Promise.resolve({
            data: { signedUrl: "https://test.supabase.co/ok" },
            error: null,
          });
        }
        return Promise.resolve({
          data: null,
          error: { message: "Signing error" },
        });
      }),
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const request = createConfirmRequest({
      filePath: "user-1/note-1/test.png",
      fileName: "test.png",
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(500);
    expect(mockDelete).toHaveBeenCalledWith("id", "att-1");
  });
});
