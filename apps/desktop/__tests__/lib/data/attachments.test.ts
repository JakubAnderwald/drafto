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
  SIGNED_URL_EXPIRY_SECONDS: 604800,
}));

import { NativeModules } from "react-native";
import { supabase } from "@/lib/supabase";

// Configure the native module mock that the source file destructures at load time.
// The react-native preset provides NativeModules as a plain object;
// we must set RNDocumentPicker on it *before* the source module is first required.
const mockPick = jest.fn();

NativeModules.RNDocumentPicker = { pick: mockPick };

// eslint-disable-next-line @typescript-eslint/no-require-imports -- require needed for load ordering
const attachments = require("@/lib/data/attachments") as typeof import("@/lib/data/attachments");
const { pickImage, pickDocument, getSignedUrl, deleteAttachment } = attachments;

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
  NativeModules.RNDocumentPicker = { pick: mockPick };
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------- pickImage ----------

describe("pickImage", () => {
  it("returns a PickedFile with both uri and decoded path", async () => {
    mockPick.mockResolvedValue([
      {
        uri: "file:///img.png",
        path: "/img.png",
        name: "img.png",
        mimeType: "image/png",
        size: 1024,
      },
    ]);

    const result = await pickImage();

    expect(mockPick).toHaveBeenCalledWith(
      expect.objectContaining({ allowedUTIs: ["public.image"] }),
    );
    expect(result).toEqual({
      uri: "file:///img.png",
      path: "/img.png",
      fileName: "img.png",
      mimeType: "image/png",
      fileSize: 1024,
    });
  });

  it("preserves decoded path when the URI contains percent-encoded characters", async () => {
    // macOS returns NFD-decomposed ö as two code points (o + U+0308), URL-encoded as %CC%88
    mockPick.mockResolvedValue([
      {
        uri: "file:///Users/j/Downloads/partikelverb%20Ao%CC%88b(1).pdf",
        path: "/Users/j/Downloads/partikelverb Aöb(1).pdf",
        name: "partikelverb Aöb(1).pdf",
        mimeType: "application/pdf",
        size: 2048,
      },
    ]);

    const result = await pickDocument();

    // path must be the decoded filesystem path — otherwise RNFS.copyFile fails
    // with "no such file" and surfaces the percent-encoded name in the error.
    expect(result?.path).toBe("/Users/j/Downloads/partikelverb Aöb(1).pdf");
    expect(result?.uri).toContain("%20");
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
    mockPick.mockResolvedValue([
      { uri: "file:///x", path: "/x", name: null, mimeType: null, size: null },
    ]);

    const result = await pickImage();

    expect(result).toEqual(
      expect.objectContaining({
        uri: "file:///x",
        path: "/x",
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
      {
        uri: "file:///doc.pdf",
        path: "/doc.pdf",
        name: "doc.pdf",
        mimeType: "application/pdf",
        size: 2048,
      },
    ]);

    const result = await pickDocument();

    // Should NOT pass allowedUTIs
    expect(mockPick).toHaveBeenCalledWith(
      expect.not.objectContaining({ allowedUTIs: expect.anything() }),
    );
    expect(result).toEqual({
      uri: "file:///doc.pdf",
      path: "/doc.pdf",
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
    mockPick.mockResolvedValue([
      { uri: "file:///y", path: "/y", name: null, mimeType: null, size: null },
    ]);

    const result = await pickDocument();

    expect(result!.fileName).toMatch(/^file_\d+$/);
    expect(result!.mimeType).toBe("application/octet-stream");
    expect(result!.fileSize).toBe(0);
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
    expect(createSignedUrlMock).toHaveBeenCalledWith("user-1/note-1/photo.jpg", 604800);
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
