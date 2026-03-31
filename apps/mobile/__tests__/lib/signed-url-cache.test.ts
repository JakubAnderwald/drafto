const mockGetSignedUrl = jest.fn();

jest.mock("@/lib/data/attachments", () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

import {
  getCachedSignedUrl,
  getCachedSignedUrlSync,
  invalidateCachedSignedUrl,
  clearSignedUrlCache,
  hasValidCacheEntry,
} from "@/lib/data/signed-url-cache";

beforeEach(() => {
  jest.clearAllMocks();
  clearSignedUrlCache();
  mockGetSignedUrl.mockResolvedValue("https://example.com/signed-url");
});

describe("signed-url-cache", () => {
  it("fetches and caches a signed URL", async () => {
    const url = await getCachedSignedUrl("user/note/file.jpg");

    expect(url).toBe("https://example.com/signed-url");
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);

    // Second call should use cache
    const url2 = await getCachedSignedUrl("user/note/file.jpg");
    expect(url2).toBe("https://example.com/signed-url");
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
  });

  it("getCachedSignedUrlSync returns null for uncached paths", () => {
    expect(getCachedSignedUrlSync("uncached/path.jpg")).toBeNull();
  });

  it("getCachedSignedUrlSync returns cached URL", async () => {
    await getCachedSignedUrl("user/note/file.jpg");
    expect(getCachedSignedUrlSync("user/note/file.jpg")).toBe("https://example.com/signed-url");
  });

  it("invalidateCachedSignedUrl removes a specific entry", async () => {
    await getCachedSignedUrl("user/note/file.jpg");
    expect(hasValidCacheEntry("user/note/file.jpg")).toBe(true);

    invalidateCachedSignedUrl("user/note/file.jpg");
    expect(hasValidCacheEntry("user/note/file.jpg")).toBe(false);
  });

  it("clearSignedUrlCache removes all entries", async () => {
    await getCachedSignedUrl("user/note/a.jpg");
    await getCachedSignedUrl("user/note/b.jpg");
    expect(hasValidCacheEntry("user/note/a.jpg")).toBe(true);
    expect(hasValidCacheEntry("user/note/b.jpg")).toBe(true);

    clearSignedUrlCache();
    expect(hasValidCacheEntry("user/note/a.jpg")).toBe(false);
    expect(hasValidCacheEntry("user/note/b.jpg")).toBe(false);
  });

  it("refetches after invalidation", async () => {
    await getCachedSignedUrl("user/note/file.jpg");
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);

    invalidateCachedSignedUrl("user/note/file.jpg");
    mockGetSignedUrl.mockResolvedValueOnce("https://example.com/new-url");

    const url = await getCachedSignedUrl("user/note/file.jpg");
    expect(url).toBe("https://example.com/new-url");
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
  });

  it("different file paths are cached independently", async () => {
    mockGetSignedUrl
      .mockResolvedValueOnce("https://example.com/url-a")
      .mockResolvedValueOnce("https://example.com/url-b");

    const a = await getCachedSignedUrl("user/note/a.jpg");
    const b = await getCachedSignedUrl("user/note/b.jpg");

    expect(a).toBe("https://example.com/url-a");
    expect(b).toBe("https://example.com/url-b");
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
  });
});
