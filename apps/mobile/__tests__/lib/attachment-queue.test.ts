import { DEFAULT_STORAGE_QUOTA_BYTES, storageFullMessage } from "@drafto/shared";
import type { StorageUsage } from "@drafto/shared";

import type { Attachment } from "@/db";

const mockUpload = jest.fn();
const mockUpsert = jest.fn();
const mockQuery = jest.fn();
const mockDatabaseWrite = jest.fn((fn: () => Promise<unknown>) => fn());
const mockDatabaseGet = jest.fn();
const mockFileBytes = jest.fn();
const mockFileDelete = jest.fn();
const mockFileCopy = jest.fn();
const mockDirDelete = jest.fn();
const mockDirExists = jest.fn(() => true);

jest.mock("expo-file-system", () => {
  const mockFile = jest.fn().mockImplementation((...args: unknown[]) => ({
    uri: typeof args[0] === "string" ? args[0] : `file:///mock/${args[1]}`,
    exists: true,
    size: 1024,
    copy: mockFileCopy,
    delete: mockFileDelete,
    bytes: mockFileBytes,
  }));
  const mockDirectory = jest.fn().mockImplementation(() => ({
    get exists() {
      return mockDirExists();
    },
    create: jest.fn(),
    delete: mockDirDelete,
    list: jest.fn().mockReturnValue([]),
  }));
  return {
    File: mockFile,
    Directory: mockDirectory,
    Paths: { document: "/mock/documents" },
  };
});

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
        create: jest.fn().mockResolvedValue({ id: "att-1" }),
        query: (...qArgs: unknown[]) => mockQuery(...qArgs),
      },
  },
}));

const mockRemove = jest.fn();
const mockSelectEq = jest.fn();
const mockMaybeSingle = jest.fn();
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
      // The quota refusal's "is this row already on the server?" check.
      select: () => ({
        eq: (...args: unknown[]) => {
          mockSelectEq(...args);
          return { maybeSingle: () => mockMaybeSingle() };
        },
      }),
    }),
  },
}));

const mockFetchStorageUsage = jest.fn();
jest.mock("@/lib/data/storage-usage", () => ({
  fetchStorageUsage: () => mockFetchStorageUsage(),
}));

jest.mock("@/lib/generate-id", () => ({
  generateId: () => "mock-id-123",
}));

import {
  processPendingUploads,
  uploadAttachment,
  deleteAllLocalAttachments,
} from "@/lib/data/attachment-queue";

beforeEach(() => {
  jest.clearAllMocks();
  mockDirExists.mockReturnValue(true);
  // Unknown usage: the queue skips its pre-check, as before the quota existed.
  mockFetchStorageUsage.mockResolvedValue(null);
  mockRemove.mockResolvedValue({ data: [], error: null });
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
});

describe("processPendingUploads", () => {
  it("skips upload when file bytes are empty", async () => {
    const mockAttachment = {
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
      update: jest.fn(),
    };

    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([mockAttachment]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    // Return empty bytes (simulates corrupted/deleted local file)
    mockFileBytes.mockResolvedValue(new Uint8Array(0));

    const result = await processPendingUploads();

    expect(result).toEqual({ uploaded: 0, failed: 1, storageFull: 0 });
    // Should NOT have attempted the storage upload
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("proceeds with upload when file has content", async () => {
    const mockAttachment = {
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
      update: jest.fn(),
    };

    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([mockAttachment]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    const fileBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    mockFileBytes.mockResolvedValue(fileBytes);

    mockUpload.mockResolvedValue({ error: null });
    mockUpsert.mockResolvedValue({ error: null });
    mockDatabaseWrite.mockImplementation((fn: () => Promise<unknown>) => fn());

    const result = await processPendingUploads();

    expect(result).toEqual({ uploaded: 1, failed: 0, storageFull: 0 });
    expect(mockUpload).toHaveBeenCalledWith("user-1/note-1/photo.jpg", expect.any(Uint8Array), {
      contentType: "image/jpeg",
      upsert: false,
    });
    // The attachments table has no UPDATE policy, so the row is inserted with
    // ON CONFLICT DO NOTHING: a retry that finds it already there succeeds.
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "remote-1", file_path: "user-1/note-1/photo.jpg" }),
      { onConflict: "id", ignoreDuplicates: true },
    );
    expect(mockAttachment.update).toHaveBeenCalled();
  });

  it("returns correct counts when some uploads fail", async () => {
    const successAttachment = {
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
      update: jest.fn(),
    };

    const failAttachment = {
      id: "att-2",
      remoteId: "remote-2",
      noteId: "note-1",
      userId: "user-1",
      fileName: "doc.pdf",
      filePath: "user-1/note-1/doc.pdf",
      fileSize: 2048,
      mimeType: "application/pdf",
      localUri: "file:///local/doc.pdf",
      uploadStatus: "pending",
      update: jest.fn(),
    };

    mockQuery.mockReturnValue({
      fetch: jest.fn().mockResolvedValue([successAttachment, failAttachment]),
    });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    const fileBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    // First call succeeds, second returns empty bytes
    mockFileBytes.mockResolvedValueOnce(fileBytes).mockResolvedValueOnce(new Uint8Array(0));

    mockUpload.mockResolvedValue({ error: null });
    mockUpsert.mockResolvedValue({ error: null });
    mockDatabaseWrite.mockImplementation((fn: () => Promise<unknown>) => fn());

    const result = await processPendingUploads();

    expect(result).toEqual({ uploaded: 1, failed: 1, storageFull: 0 });
  });

  it("returns zeros when no pending uploads exist", async () => {
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    const result = await processPendingUploads();

    expect(result).toEqual({ uploaded: 0, failed: 0, storageFull: 0 });
  });
});

describe("storage quota (issue #794)", () => {
  const QUOTA = DEFAULT_STORAGE_QUOTA_BYTES;
  const FILE_SIZE = 1024;
  /** Usage this file still fits in, and usage it doesn't. */
  const ROOM: StorageUsage = { usedBytes: QUOTA - FILE_SIZE, quotaBytes: QUOTA };
  const FULL: StorageUsage = { usedBytes: QUOTA - FILE_SIZE + 1, quotaBytes: QUOTA };
  const QUOTA_TRIGGER_ERROR = {
    message: "storage_quota_exceeded",
    code: "P0001",
    details: null,
    hint: null,
  };
  const POLICY_REFUSAL = {
    message: "new row violates row-level security policy",
    statusCode: "403",
  };

  type Fields = { uploadStatus: string; uploadError: string | null; localUri: string | null };

  function makeAttachment(uploadStatus = "pending") {
    const fields: Fields = {
      uploadStatus,
      uploadError: null,
      localUri: "file:///local/photo.jpg",
    };
    const attachment = {
      id: "att-1",
      remoteId: "remote-1",
      noteId: "note-1",
      userId: "user-1",
      fileName: "photo.jpg",
      filePath: "user-1/note-1/photo.jpg",
      fileSize: FILE_SIZE,
      mimeType: "image/jpeg",
      get localUri() {
        return fields.localUri;
      },
      get uploadStatus() {
        return fields.uploadStatus;
      },
      get uploadError() {
        return fields.uploadError;
      },
      update: jest.fn(async (apply: (record: Fields) => void) => apply(fields)),
    };
    return { attachment: attachment as unknown as Attachment, fields };
  }

  /** The local table: the queue's query only returns pending and failed rows. */
  function serveQueue(...attachments: Attachment[]): void {
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });
    mockQuery.mockImplementation(() => ({
      fetch: jest.fn(async () =>
        attachments.filter((a) => a.uploadStatus === "pending" || a.uploadStatus === "failed"),
      ),
    }));
  }

  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mockUpload.mockResolvedValue({ error: null });
    mockUpsert.mockResolvedValue({ error: null });
    mockDatabaseWrite.mockImplementation((fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("records the trigger's refusal as storage full, removes the object, and never retries it", async () => {
    mockUpsert.mockResolvedValue({ error: QUOTA_TRIGGER_ERROR });
    const { attachment, fields } = makeAttachment();
    serveQueue(attachment);

    await expect(processPendingUploads()).resolves.toEqual({
      uploaded: 0,
      failed: 0,
      storageFull: 1,
    });

    expect(fields.uploadStatus).toBe("quota_exceeded");
    expect(fields.uploadError).toBe(storageFullMessage(null, null));
    // The row was refused, so the object just uploaded is an orphan.
    expect(mockRemove).toHaveBeenCalledWith(["user-1/note-1/photo.jpg"]);
    // Kept locally: the attachment still shows on this device.
    expect(fields.localUri).toBe("file:///local/photo.jpg");

    mockUpload.mockClear();
    await expect(processPendingUploads()).resolves.toEqual({
      uploaded: 0,
      failed: 0,
      storageFull: 0,
    });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("says how full storage is when the trigger refuses and usage can be read", async () => {
    mockFetchStorageUsage.mockResolvedValueOnce(null).mockResolvedValueOnce(FULL);
    mockUpsert.mockResolvedValue({ error: QUOTA_TRIGGER_ERROR });
    const { attachment, fields } = makeAttachment();

    await expect(uploadAttachment(attachment)).resolves.toBe(false);

    expect(fields.uploadStatus).toBe("quota_exceeded");
    expect(fields.uploadError).toBe(storageFullMessage(FULL.usedBytes, FULL.quotaBytes));
  });

  it("refuses up front, without uploading, when the file would go over the quota", async () => {
    mockFetchStorageUsage.mockResolvedValue(FULL);
    const { attachment, fields } = makeAttachment();
    serveQueue(attachment);

    await expect(processPendingUploads()).resolves.toEqual({
      uploaded: 0,
      failed: 0,
      storageFull: 1,
    });

    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockSelectEq).toHaveBeenCalledWith("id", "remote-1");
    expect(fields.uploadStatus).toBe("quota_exceeded");
    expect(fields.uploadError).toBe(storageFullMessage(FULL.usedBytes, FULL.quotaBytes));
    // An earlier attempt may have uploaded the object before its row was refused.
    expect(mockRemove).toHaveBeenCalledWith(["user-1/note-1/photo.jpg"]);
  });

  it("uploads a file that lands exactly on the quota", async () => {
    mockFetchStorageUsage.mockResolvedValue(ROOM);
    const { attachment, fields } = makeAttachment();

    await expect(uploadAttachment(attachment)).resolves.toBe(true);

    expect(mockUpload).toHaveBeenCalled();
    expect(fields.uploadStatus).toBe("uploaded");
  });

  it("marks a retry uploaded, keeping its object, when its row is already on the server", async () => {
    // A partial success: the row reached the server (and counts in the usage)
    // but the local status wasn't updated before the app quit.
    mockFetchStorageUsage.mockResolvedValue(FULL);
    mockMaybeSingle.mockResolvedValue({ data: { id: "remote-1" }, error: null });
    const { attachment, fields } = makeAttachment("failed");
    serveQueue(attachment);

    await expect(processPendingUploads()).resolves.toEqual({
      uploaded: 1,
      failed: 0,
      storageFull: 0,
    });

    expect(fields).toEqual({ uploadStatus: "uploaded", uploadError: null, localUri: null });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("treats the bucket policy's 403 as storage full when fresh usage confirms it", async () => {
    // Room at the pre-check; by the upload, another device has filled storage.
    mockFetchStorageUsage.mockResolvedValueOnce(ROOM).mockResolvedValueOnce(FULL);
    mockUpload.mockResolvedValue({ error: POLICY_REFUSAL });
    const { attachment, fields } = makeAttachment();

    await expect(uploadAttachment(attachment)).resolves.toBe(false);

    expect(fields.uploadStatus).toBe("quota_exceeded");
    expect(fields.uploadError).toBe(storageFullMessage(FULL.usedBytes, FULL.quotaBytes));
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalledWith(["user-1/note-1/photo.jpg"]);
  });

  it("keeps the bucket policy's 403 a transient failure while usage is under the quota", async () => {
    mockFetchStorageUsage.mockResolvedValue(ROOM);
    mockUpload.mockResolvedValue({ error: POLICY_REFUSAL });
    const { attachment, fields } = makeAttachment();
    serveQueue(attachment);

    await expect(processPendingUploads()).resolves.toEqual({
      uploaded: 0,
      failed: 1,
      storageFull: 0,
    });

    expect(fields.uploadStatus).toBe("failed");
    expect(fields.uploadError).toBe(`Upload failed: ${POLICY_REFUSAL.message}`);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("keeps a 403 transient when usage can't be read", async () => {
    mockUpload.mockResolvedValue({ error: { message: "Forbidden", status: 403 } });
    const { attachment, fields } = makeAttachment();

    await expect(uploadAttachment(attachment)).resolves.toBe(false);

    expect(fields.uploadStatus).toBe("failed");
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it("retries later, rather than giving up, when the row check fails", async () => {
    mockFetchStorageUsage.mockResolvedValue(FULL);
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "timeout" } });
    const { attachment, fields } = makeAttachment();
    serveQueue(attachment);

    await expect(processPendingUploads()).resolves.toEqual({
      uploaded: 0,
      failed: 1,
      storageFull: 0,
    });

    expect(fields.uploadStatus).toBe("failed");
    expect(fields.uploadError).toBe("Failed to check attachment record: timeout");
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("still completes a retry whose object and row are already on the server", async () => {
    mockFetchStorageUsage.mockResolvedValue(ROOM);
    mockUpload.mockResolvedValue({ error: { message: "The resource already exists" } });
    // ON CONFLICT DO NOTHING finds the row and the trigger lets it through.
    mockUpsert.mockResolvedValue({ error: null });
    const { attachment, fields } = makeAttachment("failed");

    await expect(uploadAttachment(attachment)).resolves.toBe(true);

    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ id: "remote-1" }), {
      onConflict: "id",
      ignoreDuplicates: true,
    });
    expect(fields.uploadStatus).toBe("uploaded");
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("still records storage full when removing the orphaned object fails", async () => {
    mockFetchStorageUsage.mockResolvedValue(FULL);
    mockRemove.mockRejectedValue(new Error("Network request failed"));
    const { attachment, fields } = makeAttachment();

    await expect(uploadAttachment(attachment)).resolves.toBe(false);

    expect(fields.uploadStatus).toBe("quota_exceeded");
  });
});

describe("deleteAllLocalAttachments", () => {
  it("deletes the attachments directory when it exists", async () => {
    mockDirExists.mockReturnValue(true);

    await deleteAllLocalAttachments();

    expect(mockDirDelete).toHaveBeenCalled();
  });

  it("does nothing when the attachments directory does not exist", async () => {
    mockDirExists.mockReturnValue(false);

    await deleteAllLocalAttachments();

    expect(mockDirDelete).not.toHaveBeenCalled();
  });

  it("swallows deletion errors so sign-out is not blocked", async () => {
    mockDirExists.mockReturnValue(true);
    mockDirDelete.mockImplementationOnce(() => {
      throw new Error("delete failed");
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(deleteAllLocalAttachments()).resolves.toBeUndefined();

    warnSpy.mockRestore();
  });
});
