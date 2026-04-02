const mockUpload = jest.fn();
const mockRemove = jest.fn();
const mockCreateSignedUrl = jest.fn();
const mockInsert = jest.fn();
const mockDelete = jest.fn();
const mockSelect = jest.fn();
const mockSingle = jest.fn();
const mockEq = jest.fn();

function buildDbChain() {
  const chain: Record<string, jest.Mock> = {
    insert: mockInsert,
    delete: mockDelete,
    select: mockSelect,
    single: mockSingle,
    eq: mockEq,
  };
  for (const fn of Object.values(chain)) {
    fn.mockReturnValue(chain);
  }
  return chain;
}

jest.mock("@drafto/shared", () => ({
  MAX_FILE_SIZE: 25 * 1024 * 1024,
  BUCKET_NAME: "attachments",
  SIGNED_URL_EXPIRY_SECONDS: 3600,
}));

jest.mock("@/lib/supabase", () => ({
  supabase: {
    storage: {
      from: jest.fn(() => ({
        upload: (...args: unknown[]) => mockUpload(...args),
        remove: (...args: unknown[]) => mockRemove(...args),
        createSignedUrl: (...args: unknown[]) => mockCreateSignedUrl(...args),
      })),
    },
    from: jest.fn(),
  },
}));

jest.mock("@/lib/data/attachment-utils", () => ({
  sanitizeFileName: (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_"),
}));

// Mock global fetch
const mockFetch = jest.fn();
const originalFetch = global.fetch;
beforeAll(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

import { uploadAttachment, getSignedUrl, deleteAttachment } from "@/lib/data/attachments";
import { supabase } from "@/lib/supabase";

const mockFrom = supabase.from as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("uploadAttachment", () => {
  const file = {
    uri: "file:///test/photo.jpg",
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    fileSize: 1024,
  };

  it("uploads file to storage and creates DB record", async () => {
    const mockBlob = { size: 1024 };
    mockFetch.mockResolvedValue({ blob: jest.fn().mockResolvedValue(mockBlob) });
    mockUpload.mockResolvedValue({ error: null });

    const dbChain = buildDbChain();
    dbChain.single.mockResolvedValue({
      data: {
        id: "att-1",
        note_id: "note-1",
        file_name: "photo.jpg",
        file_path: "user-1/note-1/photo.jpg",
        file_size: 1024,
        mime_type: "image/jpeg",
      },
      error: null,
    });
    mockFrom.mockReturnValue(dbChain);

    const result = await uploadAttachment("user-1", "note-1", file);

    expect(mockUpload).toHaveBeenCalledWith("user-1/note-1/photo.jpg", mockBlob, {
      contentType: "image/jpeg",
      upsert: false,
    });
    expect(result.id).toBe("att-1");
    expect(result.fileName).toBe("photo.jpg");
  });

  it("throws when file exceeds max size", async () => {
    const largeFile = { ...file, fileSize: 30 * 1024 * 1024 };

    await expect(uploadAttachment("user-1", "note-1", largeFile)).rejects.toThrow(
      "File size exceeds 25MB limit",
    );
  });

  it("throws on upload error", async () => {
    mockFetch.mockResolvedValue({ blob: jest.fn().mockResolvedValue({}) });
    mockUpload.mockResolvedValue({ error: { message: "Storage full" } });

    await expect(uploadAttachment("user-1", "note-1", file)).rejects.toThrow(
      "Upload failed: Storage full",
    );
  });

  it("cleans up storage if DB insert fails", async () => {
    mockFetch.mockResolvedValue({ blob: jest.fn().mockResolvedValue({}) });
    mockUpload.mockResolvedValue({ error: null });

    const dbChain = buildDbChain();
    dbChain.single.mockResolvedValue({ data: null, error: { message: "DB error" } });
    mockFrom.mockReturnValue(dbChain);

    await expect(uploadAttachment("user-1", "note-1", file)).rejects.toThrow(
      "Failed to save attachment record",
    );
    expect(mockRemove).toHaveBeenCalledWith(["user-1/note-1/photo.jpg"]);
  });
});

describe("getSignedUrl", () => {
  it("returns signed URL for a file path", async () => {
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://example.com/signed" },
      error: null,
    });

    const url = await getSignedUrl("user-1/note-1/photo.jpg");

    expect(url).toBe("https://example.com/signed");
    expect(mockCreateSignedUrl).toHaveBeenCalledWith("user-1/note-1/photo.jpg", 3600);
  });

  it("throws on error", async () => {
    mockCreateSignedUrl.mockResolvedValue({ data: null, error: { message: "Not found" } });

    await expect(getSignedUrl("missing")).rejects.toThrow("Failed to get signed URL");
  });
});

describe("deleteAttachment", () => {
  it("deletes DB record then storage object", async () => {
    const dbChain = buildDbChain();
    dbChain.eq.mockResolvedValue({ error: null });
    mockFrom.mockReturnValue(dbChain);
    mockRemove.mockResolvedValue({ error: null });

    await deleteAttachment("att-1", "user-1/note-1/photo.jpg");

    expect(mockFrom).toHaveBeenCalledWith("attachments");
    expect(dbChain.delete).toHaveBeenCalled();
    expect(dbChain.eq).toHaveBeenCalledWith("id", "att-1");
    expect(mockRemove).toHaveBeenCalledWith(["user-1/note-1/photo.jpg"]);
  });

  it("throws when DB delete fails", async () => {
    const dbChain = buildDbChain();
    dbChain.eq.mockResolvedValue({ error: { message: "DB error" } });
    mockFrom.mockReturnValue(dbChain);

    await expect(deleteAttachment("att-1", "path")).rejects.toThrow(
      "Failed to delete attachment: DB error",
    );
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("warns but does not throw when storage delete fails", async () => {
    const dbChain = buildDbChain();
    dbChain.eq.mockResolvedValue({ error: null });
    mockFrom.mockReturnValue(dbChain);
    mockRemove.mockResolvedValue({ error: { message: "Storage error" } });

    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    await deleteAttachment("att-1", "path");

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Storage error"));
    warnSpy.mockRestore();
  });
});
