const mockUpload = jest.fn();
const mockUpsert = jest.fn();
const mockQuery = jest.fn();
const mockDatabaseWrite = jest.fn((fn: () => Promise<unknown>) => fn());
const mockDatabaseGet = jest.fn();
const mockFileBytes = jest.fn();
const mockFileDelete = jest.fn();
const mockFileCopy = jest.fn();

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
    exists: true,
    create: jest.fn(),
    list: jest.fn().mockReturnValue([]),
  }));
  return {
    File: mockFile,
    Directory: mockDirectory,
    Paths: { document: "/mock/documents" },
  };
});

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

import { processPendingUploads } from "@/lib/data/attachment-queue";

beforeEach(() => {
  jest.clearAllMocks();
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

    expect(result).toEqual({ uploaded: 0, failed: 1 });
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

    expect(result).toEqual({ uploaded: 1, failed: 0 });
    expect(mockUpload).toHaveBeenCalledWith("user-1/note-1/photo.jpg", expect.any(Blob), {
      contentType: "image/jpeg",
      upsert: false,
    });
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

    expect(result).toEqual({ uploaded: 1, failed: 1 });
  });

  it("returns zeros when no pending uploads exist", async () => {
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([]) });
    mockDatabaseGet.mockReturnValue({
      query: (...args: unknown[]) => mockQuery(...args),
    });

    const result = await processPendingUploads();

    expect(result).toEqual({ uploaded: 0, failed: 0 });
  });
});
