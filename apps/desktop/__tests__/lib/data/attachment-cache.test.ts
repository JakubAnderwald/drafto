import {
  ATTACHMENT_CACHE_MAX_BYTES,
  cacheFileFor,
  deleteAttachmentCache,
  downloadToCache,
  evictAttachmentCache,
  getCachedAttachmentUri,
  listAttachmentCache,
  prepareCacheFile,
  retainInCache,
} from "@/lib/data/attachment-cache";

// An in-memory react-native-fs: files map a path to size and modification time.
const mockFiles = new Map<string, { size: number; mtime: number }>();
const mockDirs = new Set<string>();
const mockDownload = jest.fn<Promise<{ statusCode: number; size: number }>, [string]>();
const mockMoveFailures = { next: false };
const mockMkdir = jest.fn();

jest.mock("react-native-fs", () => {
  const under = (path: string, dir: string) => path.startsWith(`${dir}/`);
  return {
    DocumentDirectoryPath: "/docs",
    exists: jest.fn(
      async (path: string) =>
        mockFiles.has(path) ||
        mockDirs.has(path) ||
        [...mockFiles.keys()].some((file) => under(file, path)),
    ),
    mkdir: jest.fn(async (path: string, options?: unknown) => {
      mockMkdir(path, options);
      mockDirs.add(path);
    }),
    stat: jest.fn(async (path: string) => {
      const file = mockFiles.get(path);
      if (!file) throw new Error(`ENOENT ${path}`);
      return { size: file.size };
    }),
    unlink: jest.fn(async (path: string) => {
      for (const file of [...mockFiles.keys()])
        if (file === path || under(file, path)) mockFiles.delete(file);
      for (const dir of [...mockDirs]) if (dir === path || under(dir, path)) mockDirs.delete(dir);
    }),
    moveFile: jest.fn(async (from: string, to: string) => {
      if (mockMoveFailures.next) {
        mockMoveFailures.next = false;
        throw new Error("move failed");
      }
      const file = mockFiles.get(from);
      if (!file) throw new Error(`ENOENT ${from}`);
      mockFiles.delete(from);
      mockFiles.set(to, file);
    }),
    downloadFile: jest.fn(({ fromUrl, toFile }: { fromUrl: string; toFile: string }) => ({
      promise: mockDownload(fromUrl).then(({ statusCode, size }) => {
        mockFiles.set(toFile, { size, mtime: 1 });
        return { statusCode, bytesWritten: size };
      }),
    })),
    readDir: jest.fn(async (dir: string) => {
      const children = new Map<string, { isDir: boolean; path: string }>();
      for (const path of [...mockFiles.keys(), ...mockDirs]) {
        if (!under(path, dir)) continue;
        const [first, ...rest] = path.slice(dir.length + 1).split("/");
        const childPath = `${dir}/${first}`;
        if (!children.has(childPath))
          children.set(childPath, {
            isDir: rest.length > 0 || mockDirs.has(childPath),
            path: childPath,
          });
      }
      return [...children.values()].map(({ isDir, path }) => ({
        name: path.slice(path.lastIndexOf("/") + 1),
        path,
        size: mockFiles.get(path)?.size ?? 0,
        mtime: new Date(mockFiles.get(path)?.mtime ?? 0),
        isDirectory: () => isDir,
        isFile: () => !isDir,
      }));
    }),
  };
});

const mockUnsyncedRows = jest.fn();
jest.mock("@/db", () => ({
  database: { get: () => ({ query: () => ({ fetch: () => mockUnsyncedRows() }) }) },
  Attachment: {},
}));

let mockIds = 0;
jest.mock("@/lib/generate-id", () => ({ generateId: () => `id-${++mockIds}` }));

const CACHE = "/docs/attachment-cache";
const put = (relativePath: string, size: number, mtime = 1_000) =>
  mockFiles.set(`${CACHE}/${relativePath}`, { size, mtime });

beforeEach(async () => {
  mockFiles.clear();
  mockDirs.clear();
  mockDownload.mockReset();
  mockMkdir.mockReset();
  mockMoveFailures.next = false;
  mockUnsyncedRows.mockReset();
  mockUnsyncedRows.mockResolvedValue([]);
  await deleteAttachmentCache();
});

describe("paths", () => {
  it("places an attachment at its storage path under Documents/attachment-cache", () => {
    expect(cacheFileFor("user-1/note-1/photo.jpg")).toBe(`${CACHE}/user-1/note-1/photo.jpg`);
    expect(cacheFileFor("u/n/odd#name.jpg")).toBe(`${CACHE}/u/n/odd_name.jpg`);
  });

  it("creates the cache left out of backups, then the attachment's folder", async () => {
    await expect(prepareCacheFile("u/n/a.jpg")).resolves.toBe(`${CACHE}/u/n/a.jpg`);
    expect(mockMkdir).toHaveBeenNthCalledWith(1, CACHE, { NSURLIsExcludedFromBackupKey: true });
    expect(mockMkdir).toHaveBeenNthCalledWith(2, `${CACHE}/u/n`, undefined);
  });
});

describe("getCachedAttachmentUri", () => {
  it("is null with no cached copy, or an empty one, else its file:// URI", async () => {
    await expect(getCachedAttachmentUri("u/n/a.jpg")).resolves.toBeNull();
    put("u/n/a.jpg", 0);
    await expect(getCachedAttachmentUri("u/n/a.jpg")).resolves.toBeNull();
    put("u/n/a.jpg", 5);
    await expect(getCachedAttachmentUri("u/n/a.jpg")).resolves.toBe(`file://${CACHE}/u/n/a.jpg`);
  });
});

describe("downloadToCache", () => {
  it("downloads beside the cache, then moves the complete file into place", async () => {
    mockDownload.mockResolvedValue({ statusCode: 200, size: 9 });
    await expect(downloadToCache("u/n/a.jpg", "https://signed/a")).resolves.toBe(
      `file://${CACHE}/u/n/a.jpg`,
    );
    expect(mockFiles.get(`${CACHE}/u/n/a.jpg`)?.size).toBe(9);
    expect([...mockFiles.keys()].some((path) => path.includes("/.partial/"))).toBe(false);
  });

  it("shares one download between concurrent calls, and skips a cached file", async () => {
    mockDownload.mockResolvedValue({ statusCode: 200, size: 9 });
    await Promise.all([
      downloadToCache("u/n/a.jpg", "https://signed/a"),
      downloadToCache("u/n/a.jpg", "https://signed/a"),
    ]);
    await downloadToCache("u/n/a.jpg", "https://signed/a");
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it("rejects on an HTTP error or an empty body, keeping nothing", async () => {
    mockDownload.mockResolvedValueOnce({ statusCode: 403, size: 50 });
    await expect(downloadToCache("u/n/a.jpg", "https://signed/a")).rejects.toThrow("status 403");
    mockDownload.mockResolvedValueOnce({ statusCode: 200, size: 0 });
    await expect(downloadToCache("u/n/b.jpg", "https://signed/b")).rejects.toThrow("empty");
    expect(mockFiles.size).toBe(0);
  });

  it("throws away a download the sign-out wipe overtook", async () => {
    let finish: (value: { statusCode: number; size: number }) => void = () => undefined;
    mockDownload.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const pending = downloadToCache("u/n/a.jpg", "https://signed/a");
    await Promise.resolve();
    await deleteAttachmentCache();
    finish({ statusCode: 200, size: 3 });
    await expect(pending).resolves.toBeNull();
    expect(mockFiles.has(`${CACHE}/u/n/a.jpg`)).toBe(false);
  });
});

describe("retainInCache", () => {
  it("keeps a file that is already the cached copy", async () => {
    put("u/n/a.jpg", 5);
    await retainInCache(`file://${CACHE}/u/n/a.jpg`, "u/n/a.jpg");
    expect(mockFiles.has(`${CACHE}/u/n/a.jpg`)).toBe(true);
  });

  it("moves a file picked before the cache existed into it", async () => {
    mockFiles.set("/docs/attachments/id_a.jpg", { size: 5, mtime: 1 });
    await retainInCache("file:///docs/attachments/id_a.jpg", "u/n/a.jpg");
    expect(mockFiles.has("/docs/attachments/id_a.jpg")).toBe(false);
    expect(mockFiles.get(`${CACHE}/u/n/a.jpg`)?.size).toBe(5);
  });

  it("deletes the old file when the move fails", async () => {
    mockFiles.set("/docs/attachments/id_a.jpg", { size: 5, mtime: 1 });
    mockMoveFailures.next = true;
    await retainInCache("file:///docs/attachments/id_a.jpg", "u/n/a.jpg");
    expect(mockFiles.size).toBe(0);
  });
});

describe("evictAttachmentCache", () => {
  it("evicts the least recently used files first, counting a view as a use", async () => {
    put("u/n/old.jpg", 40, 1_000);
    put("u/n/viewed.jpg", 40, 1_500);
    put("u/n/new.jpg", 40, 3_000);
    const now = jest.spyOn(Date, "now").mockReturnValue(9_000);
    await getCachedAttachmentUri("u/n/viewed.jpg");
    now.mockRestore();

    await evictAttachmentCache(90);

    expect(mockFiles.has(`${CACHE}/u/n/old.jpg`)).toBe(false);
    expect(mockFiles.has(`${CACHE}/u/n/viewed.jpg`)).toBe(true);
    expect(mockFiles.has(`${CACHE}/u/n/new.jpg`)).toBe(true);
  });

  it("never evicts a file whose attachment is pending, failed or refused for the quota", async () => {
    put("u/n/pending.jpg", 50, 1);
    put("u/n/quota.jpg", 50, 2);
    put("u/n/uploaded.jpg", 50, 3);
    mockUnsyncedRows.mockResolvedValue([
      { filePath: "u/n/pending.jpg" },
      { filePath: "u/n/quota.jpg" },
    ]);
    await evictAttachmentCache(100);
    expect([...mockFiles.keys()].sort()).toEqual([
      `${CACHE}/u/n/pending.jpg`,
      `${CACHE}/u/n/quota.jpg`,
    ]);
  });

  it("does nothing while the cache fits, and never throws", async () => {
    put("u/n/a.jpg", 10);
    await evictAttachmentCache(100);
    expect(mockUnsyncedRows).not.toHaveBeenCalled();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockUnsyncedRows.mockRejectedValue(new Error("db"));
    await expect(evictAttachmentCache(1)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("caps the cache at 1 GB by default", () => {
    expect(ATTACHMENT_CACHE_MAX_BYTES).toBe(1024 * 1024 * 1024);
  });
});

describe("listAttachmentCache / deleteAttachmentCache", () => {
  it("lists cached files, leaving out downloads in progress", async () => {
    put("u/n/a.jpg", 1);
    put("u/m/b.png", 2);
    mockFiles.set(`${CACHE}/.partial/id-1.part`, { size: 3, mtime: 1 });
    const listed = (await listAttachmentCache()).map((entry) => entry.relativePath).sort();
    expect(listed).toEqual(["u/m/b.png", "u/n/a.jpg"]);
  });

  it("removes the whole cache", async () => {
    put("u/n/a.jpg", 1);
    await deleteAttachmentCache();
    expect(mockFiles.size).toBe(0);
    await expect(listAttachmentCache()).resolves.toEqual([]);
  });
});
