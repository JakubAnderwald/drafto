jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: jest.fn(),
    storage: {
      from: jest.fn(),
    },
  },
}));

jest.mock("@drafto/shared", () => ({
  MAX_FILE_SIZE: 25 * 1024 * 1024,
  BUCKET_NAME: "attachments",
  SIGNED_URL_EXPIRY_SECONDS: 3600,
}));

jest.mock("@/lib/data/attachment-utils", () => ({
  sanitizeFileName: (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_"),
}));

import { NativeModules } from "react-native";
import { supabase } from "@/lib/supabase";
import type { PickedFile } from "@/lib/data/attachments";

// Configure the native module mock that the source file destructures at load time.
// The react-native preset provides NativeModules as a plain object;
// we must set RNDocumentPicker on it *before* the source module is first required.
// Because jest.mock calls above are hoisted and run before imports, and the
// attachments module import below triggers the first require, we need to ensure
// NativeModules.RNDocumentPicker is set before that. We use a jest.mock for
// the source module itself, deferring to requireActual after setting up NativeModules.
const mockPick = jest.fn();

// Install the mock on NativeModules. This runs at module scope, after jest.mock
// calls are processed but before the dynamic imports below.
NativeModules.RNDocumentPicker = { pick: mockPick };

// Now import the module under test. By this point NativeModules.RNDocumentPicker
// is set, so the destructuring in the source file captures our mock.
// NOTE: We use require() to guarantee ordering (imports would be hoisted).
// eslint-disable-next-line @typescript-eslint/no-require-imports -- require needed for load ordering
const attachments = require("@/lib/data/attachments") as typeof import("@/lib/data/attachments");
const { pickImage, pickDocument, uploadAttachment, getSignedUrl, deleteAttachment } = attachments;

function createChainableMock(resolvedValue: { data?: unknown; error?: unknown }) {
  const chain: Record<string, jest.Mock> = {};
  const methods = ["select", "insert", "update", "delete", "eq", "order", "single", "returns"];
  for (const m of methods) {
    chain[m] = jest.fn(() => chain);
  }
  chain.returns = jest.fn(() => Promise.resolve(resolvedValue));
  (chain as unknown as PromiseLike<typeof resolvedValue>).then = (
    resolve?: (v: typeof resolvedValue) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(resolvedValue).then(resolve, reject);

  return chain;
}

const mockFrom = supabase.from as jest.Mock;
const mockStorageFrom = supabase.storage.from as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // Re-install the mock since clearAllMocks resets mockPick
  NativeModules.RNDocumentPicker = { pick: mockPick };
  (global.fetch as jest.Mock) = jest.fn();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------- pickImage ----------

describe("pickImage", () => {
  it("returns a PickedFile when user selects an image", async () => {
    mockPick.mockResolvedValue([
      { uri: "file:///img.png", name: "img.png", mimeType: "image/png", size: 1024 },
    ]);

    const result = await pickImage();

    expect(mockPick).toHaveBeenCalledWith(
      expect.objectContaining({ allowedUTIs: ["public.image"] }),
    );
    expect(result).toEqual({
      uri: "file:///img.png",
      fileName: "img.png",
      mimeType: "image/png",
      fileSize: 1024,
    });
  });

  it("returns null when picker returns empty results", async () => {
    mockPick.mockResolvedValue([]);

    const result = await pickImage();
    expect(result).toBeNull();
  });

  it("returns null when user cancels (USER_CANCELLED code)", async () => {
    const cancelError = new Error("User cancelled") as Error & { code?: string };
    cancelError.code = "USER_CANCELLED";
    mockPick.mockRejectedValue(cancelError);

    const result = await pickImage();
    expect(result).toBeNull();
  });

  it("returns null when user cancels (cancel in message)", async () => {
    mockPick.mockRejectedValue(new Error("Operation was cancelled by user"));

    const result = await pickImage();
    expect(result).toBeNull();
  });

  it("throws on non-cancel errors", async () => {
    mockPick.mockRejectedValue(new Error("Disk error"));

    await expect(pickImage()).rejects.toThrow("Disk error");
  });

  it("uses fallback values when name/mimeType/size are null", async () => {
    mockPick.mockResolvedValue([{ uri: "file:///x", name: null, mimeType: null, size: null }]);

    const result = await pickImage();

    expect(result).toEqual(
      expect.objectContaining({
        uri: "file:///x",
        mimeType: "application/octet-stream",
        fileSize: 0,
      }),
    );
    expect(result!.fileName).toMatch(/^image_\d+$/);
  });
});

// ---------- pickDocument ----------

describe("pickDocument", () => {
  it("returns a PickedFile when user selects a document", async () => {
    mockPick.mockResolvedValue([
      { uri: "file:///doc.pdf", name: "doc.pdf", mimeType: "application/pdf", size: 2048 },
    ]);

    const result = await pickDocument();

    // Should NOT pass allowedUTIs
    expect(mockPick).toHaveBeenCalledWith(
      expect.not.objectContaining({ allowedUTIs: expect.anything() }),
    );
    expect(result).toEqual({
      uri: "file:///doc.pdf",
      fileName: "doc.pdf",
      mimeType: "application/pdf",
      fileSize: 2048,
    });
  });

  it("returns null on cancel", async () => {
    const cancelError = new Error("User cancelled") as Error & { code?: string };
    cancelError.code = "USER_CANCELLED";
    mockPick.mockRejectedValue(cancelError);

    const result = await pickDocument();
    expect(result).toBeNull();
  });

  it("uses fallback values when name/mimeType/size are null", async () => {
    mockPick.mockResolvedValue([{ uri: "file:///y", name: null, mimeType: null, size: null }]);

    const result = await pickDocument();

    expect(result!.fileName).toMatch(/^file_\d+$/);
    expect(result!.mimeType).toBe("application/octet-stream");
    expect(result!.fileSize).toBe(0);
  });
});

// ---------- uploadAttachment ----------

describe("uploadAttachment", () => {
  const file: PickedFile = {
    uri: "file:///photo.jpg",
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    fileSize: 5000,
  };

  const fakeBlob = new Blob(["data"]);

  function setupUploadMocks(opts?: {
    uploadError?: { message: string };
    dbData?: Record<string, unknown> | null;
    dbError?: { message: string } | null;
  }) {
    (global.fetch as jest.Mock).mockResolvedValue({ blob: () => Promise.resolve(fakeBlob) });

    const uploadMock = jest.fn().mockResolvedValue({ error: opts?.uploadError ?? null });
    const removeMock = jest.fn().mockResolvedValue({ error: null });
    mockStorageFrom.mockReturnValue({ upload: uploadMock, remove: removeMock });

    const dbRecord = opts?.dbData ?? {
      id: "att-1",
      note_id: "note-1",
      file_name: "photo.jpg",
      file_path: "user-1/note-1/photo.jpg",
      file_size: 5000,
      mime_type: "image/jpeg",
    };
    const chain = createChainableMock({
      data: opts?.dbData === null ? null : dbRecord,
      error: opts?.dbError ?? null,
    });
    // Override single to return { data: attachment, error }
    chain.single = jest.fn(() =>
      Promise.resolve({
        data: opts?.dbError || opts?.dbData === null ? null : dbRecord,
        error: opts?.dbError ?? null,
      }),
    );
    mockFrom.mockReturnValue(chain);

    return { uploadMock, removeMock, chain };
  }

  it("throws when file exceeds MAX_FILE_SIZE", async () => {
    const bigFile: PickedFile = { ...file, fileSize: 26 * 1024 * 1024 };

    await expect(uploadAttachment("user-1", "note-1", bigFile)).rejects.toThrow(
      "File size exceeds 25MB limit",
    );
  });

  it("uploads file to storage and creates DB record", async () => {
    const { uploadMock } = setupUploadMocks();

    const result = await uploadAttachment("user-1", "note-1", file);

    expect(global.fetch).toHaveBeenCalledWith("file:///photo.jpg");
    expect(mockStorageFrom).toHaveBeenCalledWith("attachments");
    expect(uploadMock).toHaveBeenCalledWith(
      expect.stringContaining("user-1/note-1/"),
      fakeBlob,
      expect.objectContaining({ contentType: "image/jpeg", upsert: false }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: "att-1",
        noteId: "note-1",
        fileName: "photo.jpg",
        fileSize: 5000,
        mimeType: "image/jpeg",
      }),
    );
  });

  it("throws on storage upload error", async () => {
    setupUploadMocks({ uploadError: { message: "Storage full" } });

    await expect(uploadAttachment("user-1", "note-1", file)).rejects.toThrow(
      "Upload failed: Storage full",
    );
  });

  it("cleans up storage on DB insert failure", async () => {
    const { removeMock } = setupUploadMocks({ dbError: { message: "DB constraint" } });

    await expect(uploadAttachment("user-1", "note-1", file)).rejects.toThrow(
      "Failed to save attachment record: DB constraint",
    );
    expect(removeMock).toHaveBeenCalledWith([expect.stringContaining("user-1/note-1/")]);
  });

  it("cleans up storage when DB returns null data", async () => {
    const { removeMock } = setupUploadMocks({ dbData: null });

    await expect(uploadAttachment("user-1", "note-1", file)).rejects.toThrow(
      "Failed to save attachment record",
    );
    expect(removeMock).toHaveBeenCalled();
  });
});

// ---------- getSignedUrl ----------

describe("getSignedUrl", () => {
  it("returns a signed URL", async () => {
    const createSignedUrlMock = jest
      .fn()
      .mockResolvedValue({ data: { signedUrl: "https://signed.url/path" }, error: null });
    mockStorageFrom.mockReturnValue({ createSignedUrl: createSignedUrlMock });

    const result = await getSignedUrl("user-1/note-1/photo.jpg");

    expect(mockStorageFrom).toHaveBeenCalledWith("attachments");
    expect(createSignedUrlMock).toHaveBeenCalledWith("user-1/note-1/photo.jpg", 3600);
    expect(result).toBe("https://signed.url/path");
  });

  it("throws on error", async () => {
    const createSignedUrlMock = jest
      .fn()
      .mockResolvedValue({ data: null, error: { message: "Not found" } });
    mockStorageFrom.mockReturnValue({ createSignedUrl: createSignedUrlMock });

    await expect(getSignedUrl("bad/path")).rejects.toThrow("Failed to get signed URL: Not found");
  });

  it("throws when signedUrl is missing from data", async () => {
    const createSignedUrlMock = jest
      .fn()
      .mockResolvedValue({ data: { signedUrl: null }, error: null });
    mockStorageFrom.mockReturnValue({ createSignedUrl: createSignedUrlMock });

    await expect(getSignedUrl("some/path")).rejects.toThrow("Failed to get signed URL");
  });
});

// ---------- deleteAttachment ----------

describe("deleteAttachment", () => {
  it("deletes DB record then storage object", async () => {
    const chain = createChainableMock({ data: null, error: null });
    mockFrom.mockReturnValue(chain);

    const removeMock = jest.fn().mockResolvedValue({ error: null });
    mockStorageFrom.mockReturnValue({ remove: removeMock });

    await deleteAttachment("att-1", "user-1/note-1/photo.jpg");

    expect(mockFrom).toHaveBeenCalledWith("attachments");
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith("id", "att-1");
    expect(mockStorageFrom).toHaveBeenCalledWith("attachments");
    expect(removeMock).toHaveBeenCalledWith(["user-1/note-1/photo.jpg"]);
  });

  it("throws on DB delete error", async () => {
    const chain = createChainableMock({ data: null, error: { message: "FK constraint" } });
    mockFrom.mockReturnValue(chain);

    await expect(deleteAttachment("att-1", "path")).rejects.toThrow(
      "Failed to delete attachment: FK constraint",
    );
  });

  it("warns but does not throw on storage delete error (best effort)", async () => {
    const chain = createChainableMock({ data: null, error: null });
    mockFrom.mockReturnValue(chain);

    const removeMock = jest.fn().mockResolvedValue({ error: { message: "Storage unavailable" } });
    mockStorageFrom.mockReturnValue({ remove: removeMock });

    // Should not throw
    await deleteAttachment("att-1", "user-1/note-1/photo.jpg");

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Storage unavailable"));
  });
});
