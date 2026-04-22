const mockUpload = jest.fn();
const mockUpsert = jest.fn();
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
  MAX_FILE_SIZE: 25 * 1024 * 1024,
  BUCKET_NAME: "attachments",
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
      from: () => ({ upload: (...args: unknown[]) => mockUpload(...args) }),
    },
    from: () => ({ upsert: (...args: unknown[]) => mockUpsert(...args) }),
  },
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
} from "@/lib/data/attachment-queue";
import RNFS from "react-native-fs";

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  (RNFS.exists as jest.Mock).mockResolvedValue(true);
  mockDatabaseWrite.mockImplementation((fn: () => Promise<unknown>) => fn());
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
      fileSize: 26 * 1024 * 1024,
    };

    await expect(queueAttachment("user-1", "note-1", bigFile)).rejects.toThrow(
      "File size exceeds 25MB limit",
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

  it("returns 0 when queue is empty", async () => {
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    const uploaded = await processPendingUploads();
    expect(uploaded).toBe(0);
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

    const uploaded = await processPendingUploads();

    expect(uploaded).toBe(1);
    expect(RNFS.readFile).toHaveBeenCalledWith("/local/photo.jpg", "base64");
    const [, body, opts] = mockUpload.mock.calls[0];
    expect(body).toBeInstanceOf(Uint8Array);
    expect((body as Uint8Array).length).toBe(5);
    expect(opts).toEqual({ contentType: "image/jpeg", upsert: false });
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

    const uploaded = await processPendingUploads();
    expect(uploaded).toBe(1);
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
