import { localAttachmentSrcFor, resolveAttachmentSrc } from "@/lib/data/attachment-resolver";

import { toLocalAttachmentSrc } from "@drafto/shared";

const mockGetCachedAttachmentUri = jest.fn();
const mockDownloadToCache = jest.fn();
const mockEvict = jest.fn();
jest.mock("@/lib/data/attachment-cache", () => ({
  getCachedAttachmentUri: (...args: unknown[]) => mockGetCachedAttachmentUri(...args),
  downloadToCache: (...args: unknown[]) => mockDownloadToCache(...args),
  evictAttachmentCache: () => mockEvict(),
}));

const mockGetCachedSignedUrl = jest.fn();
jest.mock("@/lib/data/attachments", () => ({
  getSignedUrl: (...args: unknown[]) => mockGetCachedSignedUrl(...args),
}));

const FILE_PATH = "u/n/photo.jpg";
const CACHED_URI = "file:///docs/attachment-cache/u/n/photo.jpg";
// Desktop has no signed-URL memo: mockGetCachedSignedUrl stands in for getSignedUrl.

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCachedAttachmentUri.mockResolvedValue(null);
  mockGetCachedSignedUrl.mockResolvedValue("https://signed/photo.jpg");
  mockDownloadToCache.mockResolvedValue(CACHED_URI);
  mockEvict.mockResolvedValue(undefined);
});

describe("resolveAttachmentSrc", () => {
  it("shows a cached image from its local file, with no network call (works offline)", async () => {
    mockGetCachedAttachmentUri.mockResolvedValue(CACHED_URI);
    await expect(resolveAttachmentSrc(FILE_PATH, "image")).resolves.toBe(
      toLocalAttachmentSrc(CACHED_URI, FILE_PATH),
    );
    expect(mockGetCachedSignedUrl).not.toHaveBeenCalled();
  });

  it("uses a signed URL for an uncached image and caches it in the background", async () => {
    await expect(resolveAttachmentSrc(FILE_PATH)).resolves.toBe("https://signed/photo.jpg");
    expect(mockDownloadToCache).toHaveBeenCalledWith(FILE_PATH, "https://signed/photo.jpg");
    await flush();
    expect(mockEvict).toHaveBeenCalled();
  });

  it("keeps the signed URL when the background download fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockDownloadToCache.mockRejectedValue(new Error("network"));
    await expect(resolveAttachmentSrc(FILE_PATH)).resolves.toBe("https://signed/photo.jpg");
    await flush();
    expect(mockEvict).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rejects when there is no copy and no network, so attachment:// stays", async () => {
    mockGetCachedSignedUrl.mockRejectedValue(new Error("offline"));
    await expect(resolveAttachmentSrc(FILE_PATH, "image")).rejects.toThrow("offline");
    expect(mockDownloadToCache).not.toHaveBeenCalled();
  });

  it("keeps a signed URL for a link and caches nothing", async () => {
    mockGetCachedAttachmentUri.mockResolvedValue(CACHED_URI);
    await expect(resolveAttachmentSrc("u/n/r.pdf", "link")).resolves.toBe(
      "https://signed/photo.jpg",
    );
    expect(mockGetCachedAttachmentUri).not.toHaveBeenCalled();
    expect(mockDownloadToCache).not.toHaveBeenCalled();
  });
});

describe("localAttachmentSrcFor", () => {
  it("shows a just-picked image from its local file", async () => {
    await expect(
      localAttachmentSrcFor({ filePath: FILE_PATH, localUri: CACHED_URI }),
    ).resolves.toBe(toLocalAttachmentSrc(CACHED_URI, FILE_PATH));
  });

  it("falls back to the cache once the upload cleared localUri", async () => {
    mockGetCachedAttachmentUri.mockResolvedValue(CACHED_URI);
    await expect(localAttachmentSrcFor({ filePath: FILE_PATH, localUri: null })).resolves.toBe(
      toLocalAttachmentSrc(CACHED_URI, FILE_PATH),
    );
  });

  it("falls back to attachment:// when there is no local copy", async () => {
    await expect(localAttachmentSrcFor({ filePath: FILE_PATH, localUri: null })).resolves.toBe(
      `attachment://${FILE_PATH}`,
    );
  });
});
