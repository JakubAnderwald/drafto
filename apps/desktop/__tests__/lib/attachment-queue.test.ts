const mockUpload = jest.fn();
const mockUpsert = jest.fn();
const mockQuery = jest.fn();
const mockFetch = jest.fn();
const mockDatabaseWrite = jest.fn((fn: () => Promise<unknown>) => fn());
const mockDatabaseGet = jest.fn();

jest.mock("react-native-fs", () => ({
  DocumentDirectoryPath: "/mock/documents",
  exists: jest.fn().mockResolvedValue(true),
  mkdir: jest.fn().mockResolvedValue(undefined),
  copyFile: jest.fn().mockResolvedValue(undefined),
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
        create: jest.fn().mockResolvedValue({ id: "att-1" }),
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

// Mock global fetch
const originalFetch = global.fetch;
beforeAll(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

import { processPendingUploads, cleanupOrphanedFiles } from "@/lib/data/attachment-queue";
import RNFS from "react-native-fs";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("processPendingUploads", () => {
  it("returns 0 when no pending attachments", async () => {
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    const uploaded = await processPendingUploads();
    expect(uploaded).toBe(0);
  });

  it("skips upload when local file does not exist", async () => {
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

    (RNFS.exists as jest.Mock).mockResolvedValue(false);

    const uploaded = await processPendingUploads();
    expect(uploaded).toBe(0);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("uploads attachment and marks as uploaded on success", async () => {
    const mockUpdate = jest.fn();
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
      update: mockUpdate,
    };

    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([mockAttachment]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    (RNFS.exists as jest.Mock).mockResolvedValue(true);

    const mockBlob = { size: 1024 };
    mockFetch.mockResolvedValue({
      blob: jest.fn().mockResolvedValue(mockBlob),
    });
    mockUpload.mockResolvedValue({ error: null });
    mockUpsert.mockResolvedValue({ error: null });
    mockDatabaseWrite.mockImplementation((fn: () => Promise<unknown>) => fn());

    const uploaded = await processPendingUploads();

    expect(uploaded).toBe(1);
    expect(mockUpload).toHaveBeenCalledWith("user-1/note-1/photo.jpg", mockBlob, {
      contentType: "image/jpeg",
      upsert: false,
    });
  });

  it("continues with next attachment on individual failure", async () => {
    const att1 = {
      id: "att-1",
      remoteId: "remote-1",
      noteId: "note-1",
      userId: "user-1",
      fileName: "fail.jpg",
      filePath: "user-1/note-1/fail.jpg",
      fileSize: 1024,
      mimeType: "image/jpeg",
      localUri: "file:///local/fail.jpg",
      uploadStatus: "pending",
      update: jest.fn(),
    };

    const att2 = {
      id: "att-2",
      remoteId: "remote-2",
      noteId: "note-1",
      userId: "user-1",
      fileName: "ok.jpg",
      filePath: "user-1/note-1/ok.jpg",
      fileSize: 2048,
      mimeType: "image/jpeg",
      localUri: "file:///local/ok.jpg",
      uploadStatus: "pending",
      update: jest.fn(),
    };

    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([att1, att2]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    (RNFS.exists as jest.Mock).mockResolvedValue(true);

    // First attachment fails at fetch, second succeeds
    mockFetch.mockRejectedValueOnce(new Error("File read error")).mockResolvedValueOnce({
      blob: jest.fn().mockResolvedValue({ size: 2048 }),
    });

    mockUpload.mockResolvedValue({ error: null });
    mockUpsert.mockResolvedValue({ error: null });
    mockDatabaseWrite.mockImplementation((fn: () => Promise<unknown>) => fn());

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
