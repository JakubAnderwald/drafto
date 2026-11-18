import {
  PREFETCH_MIN_INTERVAL_MS,
  prefetchAttachmentImages,
  resetAttachmentPrefetch,
} from "@/lib/data/attachment-prefetch";

const mockFetchRows = jest.fn();
const mockQuery = jest.fn();
jest.mock("@/db", () => ({
  database: {
    get: () => ({
      query: (...args: unknown[]) => {
        mockQuery(...args);
        return { fetch: () => mockFetchRows() };
      },
    }),
  },
}));

const mockList = jest.fn();
const mockDownload = jest.fn();
const mockEvict = jest.fn();
jest.mock("@/lib/data/attachment-cache", () => ({
  ATTACHMENT_CACHE_MAX_BYTES: 1000,
  listAttachmentCache: () => mockList(),
  downloadToCache: (...args: unknown[]) => mockDownload(...args),
  evictAttachmentCache: () => mockEvict(),
}));

const mockSignedUrl = jest.fn();
jest.mock("@/lib/data/signed-url-cache", () => ({
  getCachedSignedUrl: (...args: unknown[]) => mockSignedUrl(...args),
}));

jest.mock("@drafto/shared", () => ({
  ...jest.requireActual("@drafto/shared"),
  ATTACHMENT_PREFETCH_MAX_FILES: 2,
  ATTACHMENT_PREFETCH_MAX_BYTES: 500,
  ATTACHMENT_PREFETCH_MAX_FILE_BYTES: 300,
}));

const row = (filePath: string, fileSize: number) => ({ filePath, fileSize });

beforeEach(() => {
  jest.clearAllMocks();
  resetAttachmentPrefetch();
  mockList.mockReturnValue([]);
  mockSignedUrl.mockImplementation(async (filePath: string) => `https://signed/${filePath}`);
  mockDownload.mockImplementation(async (filePath: string) => `file:///c/${filePath}`);
  mockEvict.mockResolvedValue(undefined);
});

describe("prefetchAttachmentImages", () => {
  it("downloads uncached images, newest first, within the per-pass limits, then evicts", async () => {
    mockList.mockReturnValue([{ relativePath: "u/n/cached.jpg", size: 10, lastUsedAt: 1 }]);
    mockFetchRows.mockResolvedValue([
      row("u/n/cached.jpg", 10),
      row("u/n/huge.jpg", 301),
      row("u/n/a.jpg", 100),
      row("u/n/b.jpg", 100),
      row("u/n/c.jpg", 100),
    ]);

    await expect(prefetchAttachmentImages()).resolves.toEqual({ downloaded: 2 });

    expect(mockDownload.mock.calls.map(([filePath]) => filePath)).toEqual([
      "u/n/a.jpg",
      "u/n/b.jpg",
    ]);
    expect(mockDownload).toHaveBeenCalledWith("u/n/a.jpg", "https://signed/u/n/a.jpg");
    expect(mockEvict).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("stops at the first failure (the network went away)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetchRows.mockResolvedValue([row("u/n/a.jpg", 10), row("u/n/b.jpg", 10)]);
    mockSignedUrl.mockRejectedValue(new Error("offline"));
    await expect(prefetchAttachmentImages()).resolves.toEqual({ downloaded: 0 });
    expect(mockSignedUrl).toHaveBeenCalledTimes(1);
    expect(mockEvict).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stops once the session ends", async () => {
    mockFetchRows.mockResolvedValue([row("u/n/a.jpg", 10), row("u/n/b.jpg", 10)]);
    let calls = 0;
    await prefetchAttachmentImages({ isCancelled: () => calls++ > 0 });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("does not repeat a pass that found nothing for a minute", async () => {
    mockFetchRows.mockResolvedValue([]);
    const now = jest.spyOn(Date, "now").mockReturnValue(100_000);
    await prefetchAttachmentImages();
    await prefetchAttachmentImages();
    expect(mockFetchRows).toHaveBeenCalledTimes(1);
    now.mockReturnValue(100_000 + PREFETCH_MIN_INTERVAL_MS);
    await prefetchAttachmentImages();
    expect(mockFetchRows).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("runs one pass at a time", async () => {
    mockFetchRows.mockResolvedValue([row("u/n/a.jpg", 10)]);
    const first = prefetchAttachmentImages();
    const second = prefetchAttachmentImages();
    expect(second).toBe(first);
    await first;
  });

  it("never throws", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetchRows.mockRejectedValue(new Error("db"));
    await expect(prefetchAttachmentImages()).resolves.toEqual({ downloaded: 0 });
    warn.mockRestore();
  });
});
