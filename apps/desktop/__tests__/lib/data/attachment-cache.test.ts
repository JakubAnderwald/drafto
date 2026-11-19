import RNFS from "react-native-fs";
import { attachmentCacheRelativePath } from "@drafto/shared";

import {
  ATTACHMENT_CACHE_MAX_BYTES,
  AttachmentCacheWipedError,
  cacheFileFor,
  copyIntoCache,
  deleteAttachmentCache,
  deleteFromCache,
  downloadToCache,
  evictAttachmentCache,
  flushAttachmentCacheIndex,
  getAttachmentCacheGeneration,
  getAttachmentCacheState,
  getCachedAttachmentUri,
  holdCacheFile,
  listAttachmentCache,
  prepareCacheFile,
  removeOrphanedCacheFiles,
  retainInCache,
} from "@/lib/data/attachment-cache";

// An in-memory react-native-fs: files map a path to size and modification time.
const mockFiles = new Map<string, { size: number; mtime: number; text?: string }>();
// Called on every exists(); a test uses it to sign out at an exact moment.
const mockHooks: { onExists: ((path: string) => void) | null; readDirCalls: number } = {
  onExists: null,
  readDirCalls: 0,
};
const mockDirs = new Set<string>();
const mockDownload = jest.fn<Promise<{ statusCode: number; size: number }>, [string]>();
const mockMoveFailures = { next: false };
const mockMkdir = jest.fn();

jest.mock("react-native-fs", () => {
  const under = (path: string, dir: string) => path.startsWith(`${dir}/`);
  return {
    DocumentDirectoryPath: "/docs",
    exists: jest.fn(async (path: string) => {
      mockHooks.onExists?.(path);
      return (
        mockFiles.has(path) ||
        mockDirs.has(path) ||
        [...mockFiles.keys()].some((file) => under(file, path))
      );
    }),
    copyFile: jest.fn(async (from: string, to: string) => {
      const file = mockFiles.get(from);
      if (!file) throw new Error(`ENOENT ${from}`);
      // Like RNFS on macOS, the copy keeps the source's modification time.
      mockFiles.set(to, { ...file });
    }),
    writeFile: jest.fn(async (path: string, text: string) => {
      mockFiles.set(path, { size: text.length, mtime: 1, text });
    }),
    readFile: jest.fn(async (path: string) => {
      const file = mockFiles.get(path);
      if (!file) throw new Error(`ENOENT ${path}`);
      return file.text ?? "";
    }),
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
      mockHooks.readDirCalls += 1;
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

// Eviction asks for unsynced rows (a filtered query); the cleanup asks for
// every attachment row (an unfiltered one) and the live note ids.
const mockUnsyncedRows = jest.fn();
const mockAllRows = jest.fn();
const mockNoteIds = jest.fn();
jest.mock("@/db", () => ({
  database: {
    get: (table: string) => ({
      query: (...conditions: unknown[]) => ({
        fetch: () => (conditions.length > 0 ? mockUnsyncedRows() : mockAllRows()),
        fetchIds: () => (table === "notes" ? mockNoteIds() : Promise.resolve([])),
      }),
    }),
  },
  Attachment: {},
  Note: {},
}));

let mockIds = 0;
jest.mock("@/lib/generate-id", () => ({ generateId: () => `id-${++mockIds}` }));

const CACHE = "/docs/attachment-cache";
const put = (relativePath: string, size: number, mtime = 1_000) =>
  mockFiles.set(`${CACHE}/${relativePath}`, { size, mtime });
const filesUnder = (dir: string) => [...mockFiles.keys()].filter((path) => path.startsWith(dir));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Forget everything in memory, keeping every file (as a restart does). */
async function restart(): Promise<void> {
  const kept = new Map(mockFiles);
  await deleteAttachmentCache();
  for (const [path, file] of kept) mockFiles.set(path, file);
}

beforeEach(async () => {
  mockHooks.onExists = null;
  await deleteAttachmentCache();
  mockFiles.clear();
  mockDirs.clear();
  mockDownload.mockReset();
  mockMkdir.mockReset();
  mockMoveFailures.next = false;
  mockHooks.readDirCalls = 0;
  mockUnsyncedRows.mockReset();
  mockUnsyncedRows.mockResolvedValue([]);
  mockAllRows.mockReset();
  mockAllRows.mockResolvedValue([]);
  mockNoteIds.mockReset();
  mockNoteIds.mockResolvedValue([]);
});

describe("paths", () => {
  it("places an attachment at its storage path under Documents/attachment-cache", () => {
    expect(cacheFileFor("user-1/note-1/photo.jpg")).toBe(`${CACHE}/user-1/note-1/photo.jpg`);
    expect(cacheFileFor("u/n/odd#name.jpg")).toBe(
      `${CACHE}/${attachmentCacheRelativePath("u/n/odd#name.jpg")}`,
    );
    expect(cacheFileFor("u/n/odd#name.jpg")).not.toBe(cacheFileFor("u/n/odd_name.jpg"));
  });

  it("creates the cache left out of backups, then the attachment's folder", async () => {
    await expect(prepareCacheFile("u/n/a.jpg")).resolves.toBe(`${CACHE}/u/n/a.jpg`);
    expect(mockMkdir).toHaveBeenNthCalledWith(1, CACHE, { NSURLIsExcludedFromBackupKey: true });
    expect(mockMkdir).toHaveBeenNthCalledWith(2, `${CACHE}/u/n`, undefined);
  });

  it("sets the backup exclusion again when setting it failed after the cache was created", async () => {
    // RNFS.mkdir creates the directory, then sets the attribute: a failure
    // there rejects with the directory already in place.
    mockMkdir.mockImplementationOnce((path: string) => {
      mockDirs.add(path);
      throw new Error("EPERM");
    });
    await expect(prepareCacheFile("u/n/a.jpg")).rejects.toThrow("EPERM");
    expect(mockDirs.has(CACHE)).toBe(true);
    expect(mockDirs.has(`${CACHE}/u/n`)).toBe(false);

    mockMkdir.mockClear();
    await prepareCacheFile("u/n/a.jpg");
    expect(mockMkdir).toHaveBeenNthCalledWith(1, CACHE, { NSURLIsExcludedFromBackupKey: true });

    // Once it is set, a later write doesn't set it again.
    mockMkdir.mockClear();
    await prepareCacheFile("u/m/b.jpg");
    expect(mockMkdir).toHaveBeenCalledTimes(1);
    expect(mockMkdir).toHaveBeenCalledWith(`${CACHE}/u/m`, undefined);
  });

  it("sets the backup exclusion on a cache an earlier launch created", async () => {
    mockDirs.add(CACHE);
    await prepareCacheFile("u/n/a.jpg");
    expect(mockMkdir).toHaveBeenNthCalledWith(1, CACHE, { NSURLIsExcludedFromBackupKey: true });
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

  it("does not index a file deleted while the first walk of the cache runs", async () => {
    put("u/n/a.jpg", 5);
    // The file's size is read, then the delete lands before the walk reaches it.
    mockHooks.onExists = (path) => {
      if (path === CACHE) mockFiles.delete(`${CACHE}/u/n/a.jpg`);
    };
    await expect(getCachedAttachmentUri("u/n/a.jpg")).resolves.toBeNull();
    mockHooks.onExists = null;
    expect(await listAttachmentCache()).toEqual([]);
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

  it("leaves no file of a download that completes after a wipe, even in the next session's cache", async () => {
    let finish: (value: { statusCode: number; size: number }) => void = () => undefined;
    mockDownload.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const old = downloadToCache("u/n/a.jpg", "https://signed/a");
    while (mockDownload.mock.calls.length === 0) await tick();
    await deleteAttachmentCache();
    // The next account's session recreates the cache before the old download ends.
    mockDownload.mockResolvedValueOnce({ statusCode: 200, size: 4 });
    await expect(downloadToCache("u/m/b.jpg", "https://signed/b")).resolves.toBe(
      `file://${CACHE}/u/m/b.jpg`,
    );

    finish({ statusCode: 200, size: 3 });
    await expect(old).resolves.toBeNull();
    expect(filesUnder(CACHE)).toEqual([`${CACHE}/u/m/b.jpg`]);
  });

  it("downloads nothing for work that began before a sign-out", async () => {
    const startedIn = getAttachmentCacheGeneration();
    await deleteAttachmentCache();
    await expect(downloadToCache("u/n/a.jpg", "https://signed/a", startedIn)).resolves.toBeNull();
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockFiles.size).toBe(0);
  });

  it("never recreates the cache for a download a sign-out overtook after it finished", async () => {
    mockDownload.mockResolvedValue({ statusCode: 200, size: 3 });
    let wipe: Promise<void> | null = null;
    let mkdirsBeforeWipe = 0;
    mockHooks.onExists = (path) => {
      // Sign out while the finished download's size is being checked.
      if (!wipe && path.endsWith(".part") && mockFiles.has(path)) {
        mkdirsBeforeWipe = mockMkdir.mock.calls.length;
        wipe = deleteAttachmentCache();
      }
    };

    await expect(downloadToCache("u/n/a.jpg", "https://signed/a")).resolves.toBeNull();
    await wipe;

    expect(wipe).not.toBeNull();
    expect(mockMkdir).toHaveBeenCalledTimes(mkdirsBeforeWipe);
    expect([...mockFiles.keys()].filter((path) => path.startsWith(CACHE))).toEqual([]);
    expect(mockDirs.has(CACHE)).toBe(false);
  });
});

describe("copyIntoCache", () => {
  it("copies a picked image to its storage path and records it as just used", async () => {
    mockFiles.set("/picker/a.jpg", { size: 7, mtime: 1 });
    const now = jest.spyOn(Date, "now").mockReturnValue(9_000);
    await expect(copyIntoCache("/picker/a.jpg", "u/n/a.jpg")).resolves.toBe(
      `file://${CACHE}/u/n/a.jpg`,
    );
    now.mockRestore();
    expect(await listAttachmentCache()).toEqual([
      { relativePath: "u/n/a.jpg", size: 7, lastUsedAt: 9_000 },
    ]);
  });

  it("stops, writing nothing, when a sign-out wipes the cache part-way", async () => {
    mockFiles.set("/picker/a.jpg", { size: 7, mtime: 1 });
    let wipe: Promise<void> | null = null;
    mockHooks.onExists = (path) => {
      if (!wipe && path === CACHE) wipe = deleteAttachmentCache();
    };
    await expect(copyIntoCache("/picker/a.jpg", "u/n/a.jpg")).rejects.toBeInstanceOf(
      AttachmentCacheWipedError,
    );
    await wipe;
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockFiles.has(`${CACHE}/u/n/a.jpg`)).toBe(false);
  });

  it("rejects, rather than hand out a deleted file, when a sign-out wipes the cache during the copy", async () => {
    mockFiles.set("/picker/a.jpg", { size: 7, mtime: 1 });
    jest.mocked(RNFS.copyFile).mockImplementationOnce(async (from: string, to: string) => {
      mockFiles.set(to, { ...mockFiles.get(from)! });
      await deleteAttachmentCache();
    });
    await expect(copyIntoCache("/picker/a.jpg", "u/n/a.jpg")).rejects.toBeInstanceOf(
      AttachmentCacheWipedError,
    );
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

  it("leaves the file alone, and the cache gone, when a sign-out wipes the cache part-way", async () => {
    mockFiles.set("/docs/attachments/id_a.jpg", { size: 5, mtime: 1 });
    let wipe: Promise<void> | null = null;
    mockHooks.onExists = (path) => {
      if (!wipe && path === "/docs/attachments/id_a.jpg") wipe = deleteAttachmentCache();
    };
    await retainInCache("file:///docs/attachments/id_a.jpg", "u/n/a.jpg");
    await wipe;
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockFiles.has(`${CACHE}/u/n/a.jpg`)).toBe(false);
    expect(mockDirs.has(CACHE)).toBe(false);
  });

  it("deletes the old file when the move fails", async () => {
    mockFiles.set("/docs/attachments/id_a.jpg", { size: 5, mtime: 1 });
    mockMoveFailures.next = true;
    await retainInCache("file:///docs/attachments/id_a.jpg", "u/n/a.jpg");
    expect(mockFiles.size).toBe(0);
  });

  it("keeps the moved file and counts it on the next use of the index when recording it fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    put("u/n/old.jpg", 5);
    await getCachedAttachmentUri("u/n/old.jpg"); // loads the index and marks old.jpg used
    jest.spyOn(Date, "now").mockReturnValue(9_000);
    await getCachedAttachmentUri("u/n/old.jpg");
    jest.mocked(Date.now).mockRestore();
    mockFiles.set("/docs/attachments/id_a.jpg", { size: 10, mtime: 1 });
    jest.mocked(RNFS.stat).mockRejectedValueOnce(new Error("EIO"));
    await retainInCache("file:///docs/attachments/id_a.jpg", "u/n/a.jpg");
    expect(mockFiles.has(`${CACHE}/u/n/a.jpg`)).toBe(true);
    const state = await getAttachmentCacheState();
    expect(state.totalBytes).toBe(15);
    expect(state.isCached("u/n/a.jpg")).toBe(true);
    // The walk keeps the last use the index had, not the file's old time.
    const old = (await listAttachmentCache()).find((entry) => entry.relativePath === "u/n/old.jpg");
    expect(old?.lastUsedAt).toBe(9_000);
    warn.mockRestore();
  });

  it("never throws, so a cache failure can't fail an upload already recorded", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    put("u/n/a.jpg", 5);
    jest.mocked(RNFS.stat).mockRejectedValueOnce(new Error("EIO"));
    await expect(retainInCache(`file://${CACHE}/u/n/a.jpg`, "u/n/a.jpg")).resolves.toBeUndefined();
    expect(mockFiles.has(`${CACHE}/u/n/a.jpg`)).toBe(true);
    warn.mockRestore();
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

  it("ranks by last use as it is after reading the rows, so a file opened meanwhile is kept", async () => {
    put("u/n/a.jpg", 50, 1_000);
    put("u/n/b.jpg", 50, 2_000);
    let releaseRows: (rows: unknown[]) => void = () => undefined;
    mockUnsyncedRows.mockReturnValueOnce(new Promise((resolve) => (releaseRows = resolve)));
    const eviction = evictAttachmentCache(60);
    while (mockUnsyncedRows.mock.calls.length === 0) await tick();

    // a.jpg, the oldest when eviction started, is opened while the rows load.
    await getCachedAttachmentUri("u/n/a.jpg");
    releaseRows([]);
    await eviction;

    expect(mockFiles.has(`${CACHE}/u/n/a.jpg`)).toBe(true);
    expect(mockFiles.has(`${CACHE}/u/n/b.jpg`)).toBe(false);
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

  it("never evicts a just-saved file whose row isn't written yet", async () => {
    put("u/n/old.jpg", 50, 1);
    mockFiles.set("/picker/new.jpg", { size: 60, mtime: 1 });
    const release = holdCacheFile("u/n/new.jpg");
    await copyIntoCache("/picker/new.jpg", "u/n/new.jpg");

    await evictAttachmentCache(100);
    release();

    expect(mockFiles.has(`${CACHE}/u/n/new.jpg`)).toBe(true);
    expect(mockFiles.has(`${CACHE}/u/n/old.jpg`)).toBe(false);
  });

  it("evicts by when a file was last used, not by its (copied, old) file time, across a restart", async () => {
    put("u/n/prefetched.jpg", 50, 5_000);
    mockFiles.set("/picker/2023.jpg", { size: 50, mtime: 1 });
    const now = jest.spyOn(Date, "now").mockReturnValue(9_000);
    await copyIntoCache("/picker/2023.jpg", "u/n/2023.jpg");
    now.mockRestore();
    await flushAttachmentCacheIndex();
    await restart();

    await evictAttachmentCache(60);

    expect(mockFiles.has(`${CACHE}/u/n/2023.jpg`)).toBe(true);
    expect(mockFiles.has(`${CACHE}/u/n/prefetched.jpg`)).toBe(false);
  });

  it("walks the cache once, then keeps a running total", async () => {
    put("u/n/a.jpg", 10);
    put("u/n/b.jpg", 20);
    expect((await getAttachmentCacheState()).totalBytes).toBe(30);
    const walks = mockHooks.readDirCalls;

    mockDownload.mockResolvedValue({ statusCode: 200, size: 5 });
    await downloadToCache("u/n/c.jpg", "https://signed/c");
    await deleteFromCache("u/n/a.jpg");
    await evictAttachmentCache(1_000);
    await evictAttachmentCache(1_000);

    const state = await getAttachmentCacheState();
    expect(state.totalBytes).toBe(25);
    expect(state.isCached("u/n/c.jpg")).toBe(true);
    expect(state.isCached("u/n/a.jpg")).toBe(false);
    expect(mockHooks.readDirCalls).toBe(walks);
  });

  it("keeps a file it could not delete in the index, so it is retried", async () => {
    put("u/n/old.jpg", 50, 1);
    put("u/n/new.jpg", 50, 2);
    jest.mocked(RNFS.unlink).mockRejectedValueOnce(new Error("EBUSY"));
    await evictAttachmentCache(60);
    expect(mockFiles.has(`${CACHE}/u/n/old.jpg`)).toBe(true);
    expect((await getAttachmentCacheState()).totalBytes).toBe(100);

    await evictAttachmentCache(60);
    expect(mockFiles.has(`${CACHE}/u/n/old.jpg`)).toBe(false);
    expect((await getAttachmentCacheState()).totalBytes).toBe(50);
  });

  it("runs once more for a call that joined it, counting a file written meanwhile", async () => {
    put("u/n/a.jpg", 50, 1);
    put("u/n/b.jpg", 50, 2);
    let releaseRows: (rows: unknown[]) => void = () => undefined;
    mockUnsyncedRows.mockReturnValueOnce(new Promise((resolve) => (releaseRows = resolve)));
    const first = evictAttachmentCache(60);
    await tick();
    mockDownload.mockResolvedValue({ statusCode: 200, size: 50 });
    await downloadToCache("u/n/c.jpg", "https://signed/c");
    const joined = evictAttachmentCache(60);
    expect(joined).toBe(first);

    releaseRows([]);
    await joined;

    expect(filesUnder(CACHE)).toEqual([`${CACHE}/u/n/c.jpg`]);
    expect((await getAttachmentCacheState()).totalBytes).toBe(50);
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

describe("removeOrphanedCacheFiles", () => {
  const row = (filePath: string, noteId: string, extra: Record<string, unknown> = {}) => ({
    filePath,
    noteId,
    mimeType: "image/jpeg",
    uploadStatus: "uploaded",
    ...extra,
  });

  it("deletes files whose attachment or note is gone, keeping trashed notes' images", async () => {
    put("u/live/a.jpg", 1);
    put("u/trashed/b.jpg", 1);
    put("u/deleted/c.jpg", 1);
    put("u/live/no-row.jpg", 1);
    put("u/live/report.pdf", 1);
    mockAllRows.mockResolvedValue([
      row("u/live/a.jpg", "live"),
      row("u/trashed/b.jpg", "trashed"),
      row("u/deleted/c.jpg", "deleted"),
      row("u/live/report.pdf", "live", { mimeType: "application/pdf" }),
    ]);
    mockNoteIds.mockResolvedValue(["live", "trashed"]);

    await removeOrphanedCacheFiles();

    expect([...mockFiles.keys()].sort()).toEqual([
      `${CACHE}/u/live/a.jpg`,
      `${CACHE}/u/trashed/b.jpg`,
    ]);
    expect((await getAttachmentCacheState()).totalBytes).toBe(2);
  });

  it("keeps a file whose upload hasn't finished, and one still being saved", async () => {
    put("u/deleted/pending.jpg", 1);
    put("u/n/saving.jpg", 1);
    mockAllRows.mockResolvedValue([
      row("u/deleted/pending.jpg", "deleted", { uploadStatus: "failed" }),
    ]);
    const release = holdCacheFile("u/n/saving.jpg");
    await removeOrphanedCacheFiles();
    release();
    expect(mockFiles.has(`${CACHE}/u/deleted/pending.jpg`)).toBe(true);
    expect(mockFiles.has(`${CACHE}/u/n/saving.jpg`)).toBe(true);
  });

  it("clears leftovers of downloads an app exit cut short, and never throws", async () => {
    mockFiles.set(`${CACHE}/.partial/id-1.part`, { size: 3, mtime: 1 });
    await removeOrphanedCacheFiles();
    expect(mockFiles.has(`${CACHE}/.partial/id-1.part`)).toBe(false);

    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    put("u/n/a.jpg", 1);
    mockAllRows.mockRejectedValue(new Error("db"));
    await expect(removeOrphanedCacheFiles()).resolves.toBeUndefined();
    expect(mockFiles.has(`${CACHE}/u/n/a.jpg`)).toBe(true);
    warn.mockRestore();
  });
});

describe("removeOrphanedCacheFiles and running downloads", () => {
  it("keeps a running download's partial file, deleting only leftovers", async () => {
    mockFiles.set(`${CACHE}/.partial/old.part`, { size: 3, mtime: 1 });
    let finish: (value: { statusCode: number; size: number }) => void = () => undefined;
    mockDownload.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const running = downloadToCache("u/n/a.jpg", "https://signed/a");
    while (mockDownload.mock.calls.length === 0) await tick();
    const partial = `${CACHE}/.partial/id-${mockIds}.part`;
    mockFiles.set(partial, { size: 1, mtime: 1 }); // the download is writing it

    await removeOrphanedCacheFiles();

    expect(mockFiles.has(`${CACHE}/.partial/old.part`)).toBe(false);
    expect(mockFiles.has(partial)).toBe(true);
    finish({ statusCode: 200, size: 6 });
    await expect(running).resolves.toBe(`file://${CACHE}/u/n/a.jpg`);
  });
});

describe("deleteFromCache", () => {
  it("keeps a file it could not delete in the index, so the cleanup retries it", async () => {
    put("u/n/a.jpg", 5);
    await getAttachmentCacheState();
    jest.mocked(RNFS.unlink).mockRejectedValueOnce(new Error("EBUSY"));
    await deleteFromCache("u/n/a.jpg");
    expect((await getAttachmentCacheState()).isCached("u/n/a.jpg")).toBe(true);
    await deleteFromCache("u/n/a.jpg");
    expect((await getAttachmentCacheState()).isCached("u/n/a.jpg")).toBe(false);
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
  it("never rejects when the delete fails, so it can't block sign-out", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    put("u/n/a.jpg", 1);
    jest.mocked(RNFS.unlink).mockRejectedValueOnce(new Error("EBUSY"));
    await expect(deleteAttachmentCache()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Failed to delete the attachment cache:", expect.any(Error));
    warn.mockRestore();
  });
});
