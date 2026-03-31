const mockUpload = jest.fn();
const mockUpsert = jest.fn();
const mockQuery = jest.fn();
const mockFetch = jest.fn();
const mockDatabaseWrite = jest.fn((fn: () => Promise<unknown>) => fn());
const mockDatabaseGet = jest.fn();

jest.mock("expo-file-system", () => {
  const mockFile = jest.fn().mockImplementation((...args: unknown[]) => ({
    uri: typeof args[0] === "string" ? args[0] : `file:///mock/${args[1]}`,
    exists: true,
    copy: jest.fn(),
    delete: jest.fn(),
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

// Mock global fetch
const originalFetch = global.fetch;
beforeAll(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

import { processPendingUploads } from "@/lib/data/attachment-queue";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("processPendingUploads", () => {
  it("skips upload when blob is empty", async () => {
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

    // Return an empty blob (simulates corrupted/deleted local file)
    mockFetch.mockResolvedValue({
      blob: jest.fn().mockResolvedValue({ size: 0 }),
    });

    const uploaded = await processPendingUploads();

    expect(uploaded).toBe(0);
    // Should NOT have attempted the storage upload
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("proceeds with upload when blob has content", async () => {
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
});
