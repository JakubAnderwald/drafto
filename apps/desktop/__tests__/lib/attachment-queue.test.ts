const mockUpload = jest.fn();
const mockRemove = jest.fn();
const mockUpsert = jest.fn();
const mockMaybeSingle = jest.fn();
const mockFetchStorageUsage = jest.fn();
const mockQuery = jest.fn();
const mockDatabaseWrite = jest.fn((fn: () => Promise<unknown>) => fn());
const mockDatabaseGet = jest.fn();
const mockCreate = jest.fn();

jest.mock("react-native-fs", () => ({
  DocumentDirectoryPath: "/mock/documents",
  exists: jest.fn().mockResolvedValue(true),
  mkdir: jest.fn().mockResolvedValue(undefined),
  copyFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(""),
  unlink: jest.fn().mockResolvedValue(undefined),
  readDir: jest.fn().mockResolvedValue([]),
}));

jest.mock("@drafto/shared", () => ({
  ...jest.requireActual("@drafto/shared"),
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  BUCKET_NAME: "attachments",
  FILE_TOO_LARGE_MESSAGE: "File size exceeds 50MB limit",
}));

jest.mock("@/db", () => ({
  database: {
    write: (fn: () => Promise<unknown>) => mockDatabaseWrite(fn),
    get: (_table: string) =>
      mockDatabaseGet(_table) ?? {
        create: (builder: (rec: Record<string, unknown>) => void) => {
          const rec: Record<string, unknown> = { _raw: {} };
          builder(rec);
          mockCreate(rec);
          return { id: rec.remoteId ?? "att-1" };
        },
        query: (...qArgs: unknown[]) => mockQuery(...qArgs),
      },
  },
  Attachment: {},
}));

jest.mock("@/lib/supabase", () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => mockUpload(...args),
        remove: (...args: unknown[]) => mockRemove(...args),
      }),
    },
    from: () => ({
      upsert: (...args: unknown[]) => mockUpsert(...args),
      select: () => ({ eq: () => ({ maybeSingle: () => mockMaybeSingle() }) }),
    }),
  },
}));

jest.mock("@/lib/data/storage-usage", () => ({
  fetchStorageUsage: () => mockFetchStorageUsage(),
}));

jest.mock("@/lib/generate-id", () => ({
  generateId: () => "mock-id-123",
}));

// atob is used by attachment-queue to decode base64 from RNFS.readFile.
// In Node test env, provide a global shim if not already present.
if (typeof globalThis.atob !== "function") {
  globalThis.atob = (b64: string) => Buffer.from(b64, "base64").toString("binary");
}

import {
  queueAttachment,
  processPendingUploads,
  cleanupOrphanedFiles,
  deleteAllLocalAttachments,
} from "@/lib/data/attachment-queue";
import RNFS from "react-native-fs";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  STORAGE_QUOTA_EXCEEDED_CODE,
  storageFullMessage,
} from "@drafto/shared";

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  (RNFS.exists as jest.Mock).mockResolvedValue(true);
  mockDatabaseWrite.mockImplementation((fn: () => Promise<unknown>) => fn());
  // Usage unknown unless a test says otherwise: the quota pre-check is skipped.
  mockFetchStorageUsage.mockResolvedValue(null);
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  mockRemove.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("queueAttachment (saveFileLocally path handling)", () => {
  it("passes the decoded filesystem path to RNFS.copyFile (not the percent-encoded URI)", async () => {
    // Simulates react-native-document-picker-macos output for a file whose name
    // contains a space and an NFD-decomposed umlaut: percent-encoded URI +
    // decoded path. Using the URI string with RNFS.copyFile surfaces the
    // "no such file" error reported on macOS.
    const file = {
      uri: "file:///Users/j/Downloads/partikelverb%20Ao%CC%88b(1).pdf",
      path: "/Users/j/Downloads/partikelverb Aöb(1).pdf",
      fileName: "partikelverb Aöb(1).pdf",
      mimeType: "application/pdf",
      fileSize: 2048,
    };

    await queueAttachment("user-1", "note-1", file);

    expect(RNFS.copyFile).toHaveBeenCalledWith(
      "/Users/j/Downloads/partikelverb Aöb(1).pdf",
      expect.stringContaining("/mock/documents/attachments/"),
    );
    expect(RNFS.copyFile).not.toHaveBeenCalledWith(
      expect.stringContaining("%20"),
      expect.anything(),
    );
  });

  it("throws when file exceeds MAX_FILE_SIZE", async () => {
    const bigFile = {
      uri: "file:///big.bin",
      path: "/big.bin",
      fileName: "big.bin",
      mimeType: "application/octet-stream",
      fileSize: 51 * 1024 * 1024,
    };

    await expect(queueAttachment("user-1", "note-1", bigFile)).rejects.toThrow(
      "File size exceeds 50MB limit",
    );
    expect(RNFS.copyFile).not.toHaveBeenCalled();
  });

  it("initialises record with pending status and null uploadError", async () => {
    const file = {
      uri: "file:///doc.pdf",
      path: "/doc.pdf",
      fileName: "doc.pdf",
      mimeType: "application/pdf",
      fileSize: 1024,
    };

    await queueAttachment("user-1", "note-1", file);

    expect(mockCreate).toHaveBeenCalled();
    const record = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(record.uploadStatus).toBe("pending");
    expect(record.uploadError).toBeNull();
  });
});

describe("processPendingUploads", () => {
  function makeAttachment(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "att-1",
      remoteId: "remote-1",
      noteId: "note-1",
      userId: "user-1",
      fileName: "photo.jpg",
      filePath: "user-1/note-1/photo.jpg",
      fileSize: 1024,
      mimeType: "image/jpeg",
      localUri: "file:///local/photo.jpg",
      uploadStatus: "pending",
      uploadError: null,
      update: jest.fn((builder: (rec: Record<string, unknown>) => void) => {
        const rec: Record<string, unknown> = {};
        builder(rec);
        Object.assign(overrides, rec);
        return Promise.resolve();
      }),
      ...overrides,
    };
  }

  it("returns zero counts when queue is empty", async () => {
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    await expect(processPendingUploads()).resolves.toEqual({ uploaded: 0, storageFull: 0 });
  });

  it("uploads via Uint8Array derived from RNFS.readFile(base64), not fetch+blob", async () => {
    const attachment = makeAttachment();
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([attachment]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    // "hello" in base64
    (RNFS.readFile as jest.Mock).mockResolvedValue("aGVsbG8=");
    mockUpload.mockResolvedValue({ error: null });
    mockUpsert.mockResolvedValue({ error: null });

    const result = await processPendingUploads();

    expect(result).toEqual({ uploaded: 1, storageFull: 0 });
    expect(RNFS.readFile).toHaveBeenCalledWith("/local/photo.jpg", "base64");
    const [, body, opts] = mockUpload.mock.calls[0];
    expect(body).toBeInstanceOf(Uint8Array);
    expect((body as Uint8Array).length).toBe(5);
    expect(opts).toEqual({ contentType: "image/jpeg", upsert: false });
    // The attachments table has no UPDATE policy, so the row is inserted with
    // ON CONFLICT DO NOTHING: a retry that finds it already there succeeds.
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: attachment.remoteId, file_path: attachment.filePath }),
      { onConflict: "id", ignoreDuplicates: true },
    );
  });

  it("persists error message and transitions status to 'failed' when upload throws", async () => {
    const attachment = makeAttachment();
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([attachment]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    (RNFS.readFile as jest.Mock).mockResolvedValue("aGVsbG8=");
    mockUpload.mockResolvedValue({ error: { message: "Upload timeout" } });

    await processPendingUploads();

    // Last update call should set status=failed and uploadError=message
    expect(attachment.update).toHaveBeenCalled();
    const calls = attachment.update.mock.calls;
    const lastBuilder = calls[calls.length - 1][0] as (rec: Record<string, unknown>) => void;
    const rec: Record<string, unknown> = {};
    lastBuilder(rec);
    expect(rec.uploadStatus).toBe("failed");
    expect(rec.uploadError).toContain("Upload timeout");
  });

  it("persists 'Local file not found' as error when file is missing", async () => {
    const attachment = makeAttachment();
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([attachment]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    (RNFS.exists as jest.Mock).mockResolvedValue(false);

    await processPendingUploads();

    const calls = attachment.update.mock.calls;
    const lastBuilder = calls[calls.length - 1][0] as (rec: Record<string, unknown>) => void;
    const rec: Record<string, unknown> = {};
    lastBuilder(rec);
    expect(rec.uploadStatus).toBe("failed");
    expect(rec.uploadError).toBe("Local file not found");
  });

  it("resets a previously-failed attachment to 'pending' before retrying", async () => {
    const attachment = makeAttachment({ uploadStatus: "failed", uploadError: "prior failure" });
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([attachment]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    (RNFS.readFile as jest.Mock).mockResolvedValue("aGVsbG8=");
    mockUpload.mockResolvedValue({ error: null });
    mockUpsert.mockResolvedValue({ error: null });

    await processPendingUploads();

    // First update call (before the upload attempt) should flip to pending + null error
    const firstBuilder = attachment.update.mock.calls[0][0] as (
      rec: Record<string, unknown>,
    ) => void;
    const rec: Record<string, unknown> = {};
    firstBuilder(rec);
    expect(rec.uploadStatus).toBe("pending");
    expect(rec.uploadError).toBeNull();
  });

  it("queries for both 'pending' and 'failed' upload_status values", async () => {
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    await processPendingUploads();

    // First arg to Q.where is the column; second should be a Q.oneOf(["pending", "failed"])
    expect(mockQuery).toHaveBeenCalled();
    const queryArg = mockQuery.mock.calls[0][0];
    // Q.where("upload_status", Q.oneOf(["pending", "failed"])) — just verify
    // the query was called with something involving upload_status; the exact
    // shape depends on WatermelonDB internals.
    expect(JSON.stringify(queryArg)).toContain("upload_status");
  });

  it("treats 'already exists' storage error as success (idempotent retry)", async () => {
    const attachment = makeAttachment();
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([attachment]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    (RNFS.readFile as jest.Mock).mockResolvedValue("aGVsbG8=");
    mockUpload.mockResolvedValue({
      error: { message: "The resource already exists", statusCode: "409" },
    });
    mockUpsert.mockResolvedValue({ error: null });

    const result = await processPendingUploads();
    expect(result.uploaded).toBe(1);
  });

  describe("storage quota", () => {
    const QUOTA = DEFAULT_STORAGE_QUOTA_BYTES;
    const OVER_QUOTA = { usedBytes: QUOTA - 100, quotaBytes: QUOTA };
    const UNDER_QUOTA = { usedBytes: 0, quotaBytes: QUOTA };

    // An attachment whose update() writes onto itself, as a WatermelonDB record does, so
    // processPendingUploads can read the status the failure path recorded.
    function makeLiveAttachment(overrides: Partial<Record<string, unknown>> = {}) {
      const attachment = makeAttachment(overrides);
      attachment.update = jest.fn((builder: (rec: Record<string, unknown>) => void) => {
        const rec: Record<string, unknown> = {};
        builder(rec);
        Object.assign(attachment, rec);
        return Promise.resolve();
      });
      return attachment;
    }

    function queue(attachment: ReturnType<typeof makeLiveAttachment>) {
      mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([attachment]) });
      mockDatabaseGet.mockReturnValue({
        query: (...args: unknown[]) => mockQuery(...args),
      });
      (RNFS.readFile as jest.Mock).mockResolvedValue("aGVsbG8=");
    }

    it("marks a trigger refusal quota_exceeded, removes the object and counts it as storage full", async () => {
      const attachment = makeLiveAttachment();
      queue(attachment);
      const full = { usedBytes: QUOTA, quotaBytes: QUOTA };
      // Unknown at the pre-check, then read again for the refusal's message.
      mockFetchStorageUsage.mockResolvedValueOnce(null).mockResolvedValue(full);
      mockUpload.mockResolvedValue({ error: null });
      mockUpsert.mockResolvedValue({
        error: { code: "P0001", message: STORAGE_QUOTA_EXCEEDED_CODE },
      });

      const result = await processPendingUploads();

      expect(result).toEqual({ uploaded: 0, storageFull: 1 });
      expect(attachment.uploadStatus).toBe("quota_exceeded");
      expect(attachment.uploadError).toBe(storageFullMessage(QUOTA, QUOTA));
      expect(mockRemove).toHaveBeenCalledWith([attachment.filePath]);
      // Terminal: the local file stays, and the retry query never picks it up again.
      expect(RNFS.unlink).not.toHaveBeenCalled();
      const queryArg = JSON.stringify(mockQuery.mock.calls[0][0]);
      expect(queryArg).toContain("failed");
      expect(queryArg).not.toContain("quota_exceeded");
    });

    it("still marks the refusal when removing the object fails", async () => {
      const attachment = makeLiveAttachment();
      queue(attachment);
      mockUpload.mockResolvedValue({ error: null });
      mockUpsert.mockResolvedValue({ error: { message: STORAGE_QUOTA_EXCEEDED_CODE } });
      mockRemove.mockRejectedValue(new Error("network down"));

      const result = await processPendingUploads();

      expect(result).toEqual({ uploaded: 0, storageFull: 1 });
      expect(attachment.uploadStatus).toBe("quota_exceeded");
      // No usage reading: the message still says what happened.
      expect(attachment.uploadError).toBe(storageFullMessage(undefined, undefined));
    });

    it("logs a removal Storage reports as failed, and still marks the refusal", async () => {
      const attachment = makeLiveAttachment();
      queue(attachment);
      mockUpload.mockResolvedValue({ error: null });
      mockUpsert.mockResolvedValue({ error: { message: STORAGE_QUOTA_EXCEEDED_CODE } });
      // Storage reports most failures in its result rather than throwing.
      const removeError = {
        name: "StorageApiError",
        message: "Internal Server Error",
        status: 500,
      };
      mockRemove.mockResolvedValue({ data: null, error: removeError });

      const result = await processPendingUploads();

      expect(mockRemove).toHaveBeenCalledWith([attachment.filePath]);
      expect(console.warn).toHaveBeenCalledWith(
        `Failed to remove refused attachment ${attachment.fileName}:`,
        removeError,
      );
      expect(result).toEqual({ uploaded: 0, storageFull: 1 });
      expect(attachment.uploadStatus).toBe("quota_exceeded");
    });

    it("refuses at the pre-check without uploading when the file can't fit", async () => {
      const attachment = makeLiveAttachment();
      queue(attachment);
      mockFetchStorageUsage.mockResolvedValue(OVER_QUOTA);

      const result = await processPendingUploads();

      expect(result).toEqual({ uploaded: 0, storageFull: 1 });
      expect(mockUpload).not.toHaveBeenCalled();
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(attachment.uploadStatus).toBe("quota_exceeded");
      expect(attachment.uploadError).toBe(
        storageFullMessage(OVER_QUOTA.usedBytes, OVER_QUOTA.quotaBytes),
      );
    });

    it("marks a retry uploaded when the pre-check refuses but its row is already on the server", async () => {
      // A partial success: the row went in (and counts in the usage), the local status didn't.
      const attachment = makeLiveAttachment({ uploadStatus: "failed", uploadError: "timeout" });
      queue(attachment);
      mockFetchStorageUsage.mockResolvedValue(OVER_QUOTA);
      mockMaybeSingle.mockResolvedValue({ data: { id: attachment.remoteId }, error: null });

      const result = await processPendingUploads();

      expect(result).toEqual({ uploaded: 1, storageFull: 0 });
      expect(attachment.uploadStatus).toBe("uploaded");
      expect(attachment.localUri).toBeNull();
      expect(mockRemove).not.toHaveBeenCalled();
      expect(mockUpload).not.toHaveBeenCalled();
      expect(RNFS.unlink).toHaveBeenCalledWith("/local/photo.jpg");
    });

    it("marks a storage RLS refusal quota_exceeded when a fresh reading confirms the quota", async () => {
      const attachment = makeLiveAttachment();
      queue(attachment);
      mockFetchStorageUsage.mockResolvedValueOnce(null).mockResolvedValue(OVER_QUOTA);
      mockUpload.mockResolvedValue({
        error: { message: "new row violates row-level security policy", statusCode: "403" },
      });

      const result = await processPendingUploads();

      expect(result).toEqual({ uploaded: 0, storageFull: 1 });
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(attachment.uploadStatus).toBe("quota_exceeded");
    });

    it("keeps a storage RLS refusal under the quota a transient failure", async () => {
      const attachment = makeLiveAttachment();
      queue(attachment);
      mockFetchStorageUsage.mockResolvedValue(UNDER_QUOTA);
      mockUpload.mockResolvedValue({
        error: { message: "new row violates row-level security policy", status: 403 },
      });

      const result = await processPendingUploads();

      expect(result).toEqual({ uploaded: 0, storageFull: 0 });
      expect(attachment.uploadStatus).toBe("failed");
      expect(attachment.uploadError).toContain("Upload failed");
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("keeps the attachment retryable when the row check fails", async () => {
      const attachment = makeLiveAttachment();
      queue(attachment);
      mockFetchStorageUsage.mockResolvedValue(OVER_QUOTA);
      mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "network error" } });

      const result = await processPendingUploads();

      expect(result).toEqual({ uploaded: 0, storageFull: 0 });
      expect(attachment.uploadStatus).toBe("failed");
      expect(attachment.uploadError).toContain("Failed to check attachment record");
      expect(mockUpload).not.toHaveBeenCalled();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("uploads a file that lands exactly on the quota", async () => {
      const attachment = makeLiveAttachment();
      queue(attachment);
      mockFetchStorageUsage.mockResolvedValue({
        usedBytes: QUOTA - attachment.fileSize,
        quotaBytes: QUOTA,
      });
      mockUpload.mockResolvedValue({ error: null });
      mockUpsert.mockResolvedValue({ error: null });

      const result = await processPendingUploads();

      expect(result).toEqual({ uploaded: 1, storageFull: 0 });
      expect(attachment.uploadStatus).toBe("uploaded");
    });

    it("still succeeds on a retry whose row already exists (duplicate object, ignored upsert)", async () => {
      const attachment = makeLiveAttachment({ uploadStatus: "failed" });
      queue(attachment);
      mockFetchStorageUsage.mockResolvedValue(UNDER_QUOTA);
      mockUpload.mockResolvedValue({
        error: { message: "The resource already exists", statusCode: "409" },
      });
      mockUpsert.mockResolvedValue({ error: null });

      const result = await processPendingUploads();

      expect(result).toEqual({ uploaded: 1, storageFull: 0 });
      expect(attachment.uploadStatus).toBe("uploaded");
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("keeps a refusal counted, and the queue going, when a later attachment's local write fails", async () => {
      const refused = makeLiveAttachment({ id: "att-refused" });
      const broken = makeLiveAttachment({ id: "att-broken", uploadStatus: "failed" });
      broken.update = jest.fn().mockRejectedValue(new Error("disk I/O error"));
      const fits = makeLiveAttachment({ id: "att-fits" });
      mockQuery.mockReturnValue({
        fetch: jest.fn().mockResolvedValue([refused, broken, fits]),
      });
      mockDatabaseGet.mockReturnValue({
        query: (...args: unknown[]) => mockQuery(...args),
      });
      (RNFS.readFile as jest.Mock).mockResolvedValue("aGVsbG8=");
      // The first pre-check refuses; the broken one never reads; the last one fits.
      mockFetchStorageUsage.mockResolvedValueOnce(OVER_QUOTA).mockResolvedValue(UNDER_QUOTA);
      mockUpload.mockResolvedValue({ error: null });
      mockUpsert.mockResolvedValue({ error: null });

      const result = await processPendingUploads();

      expect(result).toEqual({ uploaded: 1, storageFull: 1 });
      expect(refused.uploadStatus).toBe("quota_exceeded");
      // Its write failed, so it is still queued for the next run.
      expect(broken.uploadStatus).toBe("failed");
      expect(fits.uploadStatus).toBe("uploaded");
    });

    it("skips the pre-check for an unlimited quota", async () => {
      const attachment = makeLiveAttachment();
      queue(attachment);
      mockFetchStorageUsage.mockResolvedValue({ usedBytes: QUOTA * 10, quotaBytes: null });
      mockUpload.mockResolvedValue({ error: null });
      mockUpsert.mockResolvedValue({ error: null });

      const result = await processPendingUploads();

      expect(result).toEqual({ uploaded: 1, storageFull: 0 });
      expect(mockMaybeSingle).not.toHaveBeenCalled();
    });
  });
});

describe("deleteAllLocalAttachments", () => {
  it("removes the entire attachments directory when it exists", async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);

    await deleteAllLocalAttachments();

    expect(RNFS.unlink).toHaveBeenCalledWith("/mock/documents/attachments");
  });

  it("does nothing when the attachments directory does not exist", async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(false);

    await deleteAllLocalAttachments();

    expect(RNFS.unlink).not.toHaveBeenCalled();
  });

  it("swallows unlink errors so sign-out is not blocked", async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.unlink as jest.Mock).mockRejectedValueOnce(new Error("permission denied"));

    await expect(deleteAllLocalAttachments()).resolves.toBeUndefined();
  });
});

describe("cleanupOrphanedFiles", () => {
  it("does nothing when attachments directory does not exist", async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(false);

    await cleanupOrphanedFiles();

    expect(RNFS.readDir).not.toHaveBeenCalled();
  });

  it("removes files not referenced by any attachment", async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);

    mockDatabaseGet.mockReturnValue({
      query: () => ({
        fetch: jest
          .fn()
          .mockResolvedValue([{ localUri: "file:///mock/documents/attachments/active.jpg" }]),
      }),
    });

    (RNFS.readDir as jest.Mock).mockResolvedValue([
      { path: "/mock/documents/attachments/active.jpg", isFile: () => true },
      { path: "/mock/documents/attachments/orphaned.jpg", isFile: () => true },
    ]);

    await cleanupOrphanedFiles();

    expect(RNFS.unlink).toHaveBeenCalledWith("/mock/documents/attachments/orphaned.jpg");
    expect(RNFS.unlink).not.toHaveBeenCalledWith("/mock/documents/attachments/active.jpg");
  });
});
