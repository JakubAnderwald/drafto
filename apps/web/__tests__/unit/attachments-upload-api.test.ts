import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  STORAGE_QUOTA_EXCEEDED_CODE,
  STORAGE_QUOTA_EXCEEDED_MESSAGE,
} from "@drafto/shared";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockCaptureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockStorageFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    rpc: mockRpc,
    storage: { from: mockStorageFrom },
  }),
}));

/** What get_my_storage_usage returns for the caller: one row; quota null = unlimited. */
function mockStorageUsage(usedBytes: number, quotaBytes: number | null) {
  mockRpc.mockResolvedValue({
    data: [{ used_bytes: usedBytes, quota_bytes: quotaBytes }],
    error: null,
  });
}

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
    mockStorageUsage(0, DEFAULT_STORAGE_QUOTA_BYTES);
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

  it("returns 413 when fileSize exceeds 50MB limit", async () => {
    authenticateAs("user-1");
    mockNoteExists();

    const { POST } = await import("@/app/api/notes/[id]/attachments/upload-url/route");
    const request = createUploadUrlRequest({
      fileName: "large.bin",
      fileSize: 52428801,
      mimeType: "application/octet-stream",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(413);
    const body = await response.json();
    // The per-file limit is not the storage quota: no quota code on this 413.
    expect(body.code).toBeUndefined();
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
    expect(body.filePath).toMatch(/^user-1\/note-1\/test-\d+-[a-z0-9]+\.png$/);
    expect(body.fileName).toMatch(/^test-\d+-[a-z0-9]+\.png$/);
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

describe("POST /api/notes/[id]/attachments/upload-url storage quota", () => {
  const mockCreateSignedUploadUrl = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAs("user-1");
    mockNoteExists();
    mockCreateSignedUploadUrl.mockResolvedValue({
      data: { signedUrl: "https://test.supabase.co/signed", token: "tok" },
      error: null,
    });
    mockStorageFrom.mockReturnValue({ createSignedUploadUrl: mockCreateSignedUploadUrl });
  });

  async function requestUploadUrl(fileSize: number) {
    const { POST } = await import("@/app/api/notes/[id]/attachments/upload-url/route");
    return POST(
      createUploadUrlRequest({ fileName: "photo.png", fileSize, mimeType: "image/png" }),
      { params },
    );
  }

  it("hands out an upload URL when the file fits under the quota", async () => {
    mockStorageUsage(10 * 1024 * 1024, DEFAULT_STORAGE_QUOTA_BYTES);

    const response = await requestUploadUrl(1024);

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith("get_my_storage_usage");
    expect(mockCreateSignedUploadUrl).toHaveBeenCalled();
  });

  it("allows an upload that lands exactly on the quota", async () => {
    mockStorageUsage(DEFAULT_STORAGE_QUOTA_BYTES - 1024, DEFAULT_STORAGE_QUOTA_BYTES);

    const response = await requestUploadUrl(1024);

    expect(response.status).toBe(200);
    expect(mockCreateSignedUploadUrl).toHaveBeenCalled();
  });

  it("refuses an upload that would go over the quota with the quota 413", async () => {
    const usedBytes = DEFAULT_STORAGE_QUOTA_BYTES - 1000;
    mockStorageUsage(usedBytes, DEFAULT_STORAGE_QUOTA_BYTES);

    const response = await requestUploadUrl(1024);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: STORAGE_QUOTA_EXCEEDED_MESSAGE,
      code: STORAGE_QUOTA_EXCEEDED_CODE,
      usedBytes,
      quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      status: 413,
    });
    expect(mockCreateSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("refuses any upload once the storage is full", async () => {
    mockStorageUsage(DEFAULT_STORAGE_QUOTA_BYTES, DEFAULT_STORAGE_QUOTA_BYTES);

    const response = await requestUploadUrl(1);

    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe(STORAGE_QUOTA_EXCEEDED_CODE);
  });

  it("parses bigint usage that arrives as numeric strings", async () => {
    mockRpc.mockResolvedValue({
      data: [{ used_bytes: String(DEFAULT_STORAGE_QUOTA_BYTES), quota_bytes: "52428800" }],
      error: null,
    });

    const response = await requestUploadUrl(1024);

    expect(response.status).toBe(413);
  });

  it("never refuses a user with an unlimited quota", async () => {
    mockStorageUsage(10 * DEFAULT_STORAGE_QUOTA_BYTES, null);

    const response = await requestUploadUrl(1024);

    expect(response.status).toBe(200);
    expect(mockCreateSignedUploadUrl).toHaveBeenCalled();
  });

  it("lets the upload through when the usage can't be read (the trigger still enforces)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });

    const response = await requestUploadUrl(1024);

    expect(response.status).toBe(200);
    expect(mockCreateSignedUploadUrl).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[storage-quota] Failed to read storage usage:",
      "function does not exist",
    );
    expect(mockCaptureException).toHaveBeenCalledWith(
      { message: "function does not exist" },
      { extra: { where: "storage-quota:get-usage" } },
    );
    consoleError.mockRestore();
  });

  it("lets the upload through when the usage RPC throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("fetch failed");
    mockRpc.mockRejectedValue(failure);

    const response = await requestUploadUrl(1024);

    expect(response.status).toBe(200);
    expect(mockCreateSignedUploadUrl).toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(failure, {
      extra: { where: "storage-quota:get-usage" },
    });
    consoleError.mockRestore();
  });

  it("lets the upload through when the usage RPC returns no row", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue({ data: [], error: null });

    const response = await requestUploadUrl(1024);

    expect(response.status).toBe(200);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// ============================================================
// confirm endpoint tests
// ============================================================

describe("POST /api/notes/[id]/attachments/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageUsage(0, DEFAULT_STORAGE_QUOTA_BYTES);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Not auth" },
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const request = createConfirmRequest({
      filePath: "user-1/note-1/test.png",
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
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(404);
  });

  it("returns 413 when fileSize exceeds 50MB limit", async () => {
    authenticateAs("user-1");
    mockNoteExists();

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const request = createConfirmRequest({
      filePath: "user-1/note-1/huge.bin",
      fileSize: 52428801,
      mimeType: "application/octet-stream",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toBe("File size exceeds 50MB limit");
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

  it.each([
    "user-1/note-1/",
    "user-1/note-1/a/b.png",
    "user-1/note-1/Show #40.mp3",
    "user-1/note-1/100%.pdf",
  ])("returns 400 for a file name upload-url would not produce (%s)", async (filePath) => {
    authenticateAs("user-1");
    mockNoteExists();

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const request = createConfirmRequest({ filePath, fileSize: 1024, mimeType: "audio/mpeg" });
    const response = await POST(request, { params });
    expect(response.status).toBe(400);
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
    const mockRemove = vi.fn().mockResolvedValue({ error: null });
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
      remove: mockRemove,
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const request = createConfirmRequest({
      filePath: "user-1/note-1/test.png",
      fileSize: 1024,
      mimeType: "image/png",
    });
    const response = await POST(request, { params });
    expect(response.status).toBe(500);
    expect(mockDelete).toHaveBeenCalledWith("id", "att-1");
    expect(mockRemove).toHaveBeenCalledWith(["user-1/note-1/test.png"]);
  });

  function mockAttachmentInsertFails(error: { message: string; code?: string }) {
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
              single: () => Promise.resolve({ data: null, error }),
            }),
          }),
        };
      }
      return {};
    });
  }

  it("maps the quota trigger's refusal to the quota 413 and removes the uploaded object", async () => {
    authenticateAs("user-1");
    mockAttachmentInsertFails({ message: "storage_quota_exceeded", code: "P0001" });
    const usedBytes = DEFAULT_STORAGE_QUOTA_BYTES - 512;
    mockStorageUsage(usedBytes, DEFAULT_STORAGE_QUOTA_BYTES);
    const mockRemove = vi.fn().mockResolvedValue({ error: null });
    mockStorageFrom.mockReturnValue({
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://test.supabase.co/ok" },
        error: null,
      }),
      remove: mockRemove,
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const response = await POST(
      createConfirmRequest({
        filePath: "user-1/note-1/photo.png",
        fileSize: 1024,
        mimeType: "image/png",
      }),
      { params },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: STORAGE_QUOTA_EXCEEDED_MESSAGE,
      code: STORAGE_QUOTA_EXCEEDED_CODE,
      usedBytes,
      quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      status: 413,
    });
    expect(mockRemove).toHaveBeenCalledWith(["user-1/note-1/photo.png"]);
  });

  it("still answers the quota 413, without numbers, when the usage can't be read", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    authenticateAs("user-1");
    mockAttachmentInsertFails({ message: "storage_quota_exceeded", code: "P0001" });
    mockRpc.mockResolvedValue({ data: null, error: { message: "timeout" } });
    mockStorageFrom.mockReturnValue({
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://test.supabase.co/ok" },
        error: null,
      }),
      remove: vi.fn().mockResolvedValue({ error: null }),
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const response = await POST(
      createConfirmRequest({
        filePath: "user-1/note-1/photo.png",
        fileSize: 1024,
        mimeType: "image/png",
      }),
      { params },
    );

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.code).toBe(STORAGE_QUOTA_EXCEEDED_CODE);
    expect(body.usedBytes).toBeNull();
    expect(body.quotaBytes).toBeNull();
    consoleError.mockRestore();
  });

  it("keeps answering 500 for any other insert failure", async () => {
    authenticateAs("user-1");
    mockAttachmentInsertFails({ message: "duplicate key value", code: "23505" });
    const mockRemove = vi.fn().mockResolvedValue({ error: null });
    mockStorageFrom.mockReturnValue({
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://test.supabase.co/ok" },
        error: null,
      }),
      remove: mockRemove,
    });

    const { POST } = await import("@/app/api/notes/[id]/attachments/confirm/route");
    const response = await POST(
      createConfirmRequest({
        filePath: "user-1/note-1/photo.png",
        fileSize: 1024,
        mimeType: "image/png",
      }),
      { params },
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Failed to save attachment record");
    expect(mockRemove).toHaveBeenCalledWith(["user-1/note-1/photo.png"]);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
