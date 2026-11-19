import { fakeFs, resetFakeFs } from "../helpers/fake-expo-file-system";
import { attachmentCacheRelativePath } from "@drafto/shared";

import {
  ATTACHMENT_CACHE_MAX_BYTES,
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
  removeOrphanedCacheFiles,
  retainInCache,
} from "@/lib/data/attachment-cache";

// A jest.mock factory can't close over imports, so it requires the shared fake.
jest.mock(
  "expo-file-system",
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require("../helpers/fake-expo-file-system").fakeFs.module,
);

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
}));

let mockIdCounter = 0;
jest.mock("@/lib/generate-id", () => ({
  generateId: () => `id-${++mockIdCounter}`,
}));

const CACHE = "file:///docs/attachment-cache";
const put = (relativePath: string, size: number, mtime = 1_000) =>
  fakeFs.files.set(`${CACHE}/${relativePath}`, { size, mtime });
const filesUnder = (dir: string) => [...fakeFs.files.keys()].filter((key) => key.startsWith(dir));
// The fake's File class, to make one call fail.
const FakeFile = fakeFs.module.File as { prototype: { size: number; delete: () => void } };

beforeEach(() => {
  deleteAttachmentCache();
  resetFakeFs();
  mockUnsyncedRows.mockReset();
  mockUnsyncedRows.mockResolvedValue([]);
  mockAllRows.mockReset();
  mockAllRows.mockResolvedValue([]);
  mockNoteIds.mockReset();
  mockNoteIds.mockResolvedValue([]);
});

describe("cacheFileFor", () => {
  it("places an attachment at its storage path under Documents/attachment-cache", () => {
    expect(cacheFileFor("user-1/note-1/photo.jpg").uri).toBe(`${CACHE}/user-1/note-1/photo.jpg`);
  });

  it("gives legacy keys that make the same safe name different files", () => {
    expect(cacheFileFor("u/n/odd#name.jpg").uri).toBe(
      `${CACHE}/${attachmentCacheRelativePath("u/n/odd#name.jpg")}`,
    );
    expect(cacheFileFor("u/n/odd#name.jpg").uri).not.toBe(cacheFileFor("u/n/odd_name.jpg").uri);
  });
});

describe("getCachedAttachmentUri", () => {
  it("is null when there is no cached copy, or it is empty", () => {
    expect(getCachedAttachmentUri("u/n/missing.jpg")).toBeNull();
    put("u/n/empty.jpg", 0);
    expect(getCachedAttachmentUri("u/n/empty.jpg")).toBeNull();
  });

  it("is the cached file's URI", () => {
    put("u/n/a.jpg", 10);
    expect(getCachedAttachmentUri("u/n/a.jpg")).toBe(`${CACHE}/u/n/a.jpg`);
  });
});

describe("downloadToCache", () => {
  it("downloads beside the cache, then moves the complete file into place", async () => {
    fakeFs.download.mockResolvedValue({ size: 42, mtime: 5 });
    await expect(downloadToCache("u/n/a.jpg", "https://signed/a")).resolves.toBe(
      `${CACHE}/u/n/a.jpg`,
    );
    expect(fakeFs.download).toHaveBeenCalledWith("https://signed/a");
    expect(fakeFs.files.get(`${CACHE}/u/n/a.jpg`)?.size).toBe(42);
    expect([...fakeFs.files.keys()].some((key) => key.includes(".partial/"))).toBe(false);
  });

  it("shares one download between concurrent calls", async () => {
    let finish: (file: { size: number; mtime: number }) => void = () => undefined;
    fakeFs.download.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const first = downloadToCache("u/n/a.jpg", "https://signed/a");
    const second = downloadToCache("u/n/a.jpg", "https://signed/a");
    finish({ size: 1, mtime: 1 });
    await expect(Promise.all([first, second])).resolves.toEqual([
      `${CACHE}/u/n/a.jpg`,
      `${CACHE}/u/n/a.jpg`,
    ]);
    expect(fakeFs.download).toHaveBeenCalledTimes(1);
  });

  it("does not download a file that is already cached", async () => {
    put("u/n/a.jpg", 10);
    await expect(downloadToCache("u/n/a.jpg", "https://signed/a")).resolves.toBe(
      `${CACHE}/u/n/a.jpg`,
    );
    expect(fakeFs.download).not.toHaveBeenCalled();
  });

  it("rejects, and keeps nothing, when the download is empty", async () => {
    fakeFs.download.mockResolvedValue({ size: 0, mtime: 1 });
    await expect(downloadToCache("u/n/a.jpg", "https://signed/a")).rejects.toThrow(
      "Downloaded file is empty",
    );
    expect(fakeFs.files.size).toBe(0);
  });

  it("throws away a download the sign-out wipe overtook", async () => {
    let finish: (file: { size: number; mtime: number }) => void = () => undefined;
    fakeFs.download.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const pending = downloadToCache("u/n/a.jpg", "https://signed/a");
    deleteAttachmentCache();
    finish({ size: 5, mtime: 1 });
    await expect(pending).resolves.toBeNull();
    expect(fakeFs.files.has(`${CACHE}/u/n/a.jpg`)).toBe(false);
  });

  it("leaves no file of a download that completes after a wipe, even in the next session's cache", async () => {
    let finish: (file: { size: number; mtime: number }) => void = () => undefined;
    fakeFs.download.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const old = downloadToCache("u/n/a.jpg", "https://signed/a");
    deleteAttachmentCache();
    // The next account's session recreates the cache before the old download ends.
    fakeFs.download.mockResolvedValueOnce({ size: 4, mtime: 1 });
    await expect(downloadToCache("u/m/b.jpg", "https://signed/b")).resolves.toBe(
      `${CACHE}/u/m/b.jpg`,
    );

    finish({ size: 3, mtime: 1 });
    await expect(old).resolves.toBeNull();
    expect(filesUnder(CACHE)).toEqual([`${CACHE}/u/m/b.jpg`]);
  });

  it("resolves null, not a failure, for a download that failed after a wipe overtook it", async () => {
    let fail: (error: Error) => void = () => undefined;
    fakeFs.download.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    const pending = downloadToCache("u/n/a.jpg", "https://signed/a");
    deleteAttachmentCache();
    fail(new Error("network"));
    await expect(pending).resolves.toBeNull();
    expect(fakeFs.files.size).toBe(0);
  });

  it("still rejects a download that failed in the current session", async () => {
    fakeFs.download.mockRejectedValue(new Error("network"));
    await expect(downloadToCache("u/n/a.jpg", "https://signed/a")).rejects.toThrow("network");
    expect(fakeFs.files.size).toBe(0);
  });

  it("downloads nothing for work that began before a sign-out", async () => {
    const startedIn = getAttachmentCacheGeneration();
    deleteAttachmentCache();
    await expect(downloadToCache("u/n/a.jpg", "https://signed/a", startedIn)).resolves.toBeNull();
    expect(fakeFs.download).not.toHaveBeenCalled();
    expect(fakeFs.files.size).toBe(0);
  });
});

describe("retainInCache", () => {
  it("leaves a file that is already the cached copy where it is", () => {
    put("u/n/a.jpg", 10);
    retainInCache(`${CACHE}/u/n/a.jpg`, "u/n/a.jpg");
    expect(fakeFs.files.has(`${CACHE}/u/n/a.jpg`)).toBe(true);
  });

  it("moves a file picked before the cache existed into it", () => {
    fakeFs.files.set("file:///docs/attachments/id_a.jpg", { size: 10, mtime: 1 });
    retainInCache("file:///docs/attachments/id_a.jpg", "u/n/a.jpg");
    expect(fakeFs.files.has("file:///docs/attachments/id_a.jpg")).toBe(false);
    expect(fakeFs.files.get(`${CACHE}/u/n/a.jpg`)?.size).toBe(10);
  });

  it("deletes the old file when the move fails", () => {
    fakeFs.files.set("file:///docs/attachments/id_a.jpg", { size: 10, mtime: 1 });
    fakeFs.failNextMove.value = true;
    retainInCache("file:///docs/attachments/id_a.jpg", "u/n/a.jpg");
    expect(fakeFs.files.size).toBe(0);
  });

  it("keeps the moved file in the cache when recording it fails", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeFs.files.set("file:///docs/attachments/id_a.jpg", { size: 10, mtime: 1 });
    getAttachmentCacheState(); // the index is loaded, so the next size read is the record
    const size = jest.spyOn(FakeFile.prototype, "size", "get").mockImplementation(() => {
      throw new Error("EIO");
    });
    expect(() => retainInCache("file:///docs/attachments/id_a.jpg", "u/n/a.jpg")).not.toThrow();
    size.mockRestore();
    expect(fakeFs.files.has(`${CACHE}/u/n/a.jpg`)).toBe(true);
    expect(fakeFs.files.has("file:///docs/attachments/id_a.jpg")).toBe(false);
    warn.mockRestore();
  });

  it("does nothing for a file that no longer exists", () => {
    retainInCache("file:///docs/attachments/gone.jpg", "u/n/a.jpg");
    expect(fakeFs.files.size).toBe(0);
  });

  it("never throws, so a cache failure can't fail an upload already recorded", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    put("u/n/a.jpg", 10);
    getAttachmentCacheState(); // the index is loaded, so the next size read is the record
    const size = jest.spyOn(FakeFile.prototype, "size", "get").mockImplementation(() => {
      throw new Error("EIO");
    });
    expect(() => retainInCache(`${CACHE}/u/n/a.jpg`, "u/n/a.jpg")).not.toThrow();
    size.mockRestore();
    expect(fakeFs.files.has(`${CACHE}/u/n/a.jpg`)).toBe(true);
    warn.mockRestore();
  });
});

describe("evictAttachmentCache", () => {
  it("does nothing while the cache fits", async () => {
    put("u/n/a.jpg", 10);
    await evictAttachmentCache(100);
    expect(fakeFs.files.size).toBe(1);
    expect(mockUnsyncedRows).not.toHaveBeenCalled();
  });

  it("evicts the least recently used files first, counting a view as a use", async () => {
    put("u/n/old.jpg", 40, 1_000);
    put("u/n/viewed.jpg", 40, 1_500);
    put("u/n/new.jpg", 40, 3_000);
    jest.spyOn(Date, "now").mockReturnValue(9_000);
    getCachedAttachmentUri("u/n/viewed.jpg");
    jest.restoreAllMocks();

    await evictAttachmentCache(90);

    expect(fakeFs.files.has(`${CACHE}/u/n/old.jpg`)).toBe(false);
    expect(fakeFs.files.has(`${CACHE}/u/n/viewed.jpg`)).toBe(true);
    expect(fakeFs.files.has(`${CACHE}/u/n/new.jpg`)).toBe(true);
  });

  it("ranks by last use as it is after reading the rows, so a file opened meanwhile is kept", async () => {
    put("u/n/a.jpg", 50, 1_000);
    put("u/n/b.jpg", 50, 2_000);
    let releaseRows: (rows: unknown[]) => void = () => undefined;
    mockUnsyncedRows.mockReturnValueOnce(new Promise((resolve) => (releaseRows = resolve)));
    const eviction = evictAttachmentCache(60);
    await Promise.resolve();
    expect(mockUnsyncedRows).toHaveBeenCalledTimes(1);

    // a.jpg, the oldest when eviction started, is opened while the rows load.
    getCachedAttachmentUri("u/n/a.jpg");
    releaseRows([]);
    await eviction;

    expect(fakeFs.files.has(`${CACHE}/u/n/a.jpg`)).toBe(true);
    expect(fakeFs.files.has(`${CACHE}/u/n/b.jpg`)).toBe(false);
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

    expect(fakeFs.files.has(`${CACHE}/u/n/pending.jpg`)).toBe(true);
    expect(fakeFs.files.has(`${CACHE}/u/n/quota.jpg`)).toBe(true);
    expect(fakeFs.files.has(`${CACHE}/u/n/uploaded.jpg`)).toBe(false);
  });

  it("never evicts a just-saved file whose row isn't written yet", async () => {
    put("u/n/old.jpg", 50, 1);
    fakeFs.files.set("file:///picker/new.jpg", { size: 60, mtime: 1 });
    const release = holdCacheFile("u/n/new.jpg");
    copyIntoCache("file:///picker/new.jpg", "u/n/new.jpg");

    await evictAttachmentCache(100);
    expect(fakeFs.files.has(`${CACHE}/u/n/new.jpg`)).toBe(true);
    expect(fakeFs.files.has(`${CACHE}/u/n/old.jpg`)).toBe(false);

    release();
    put("u/n/other.jpg", 50, 1);
    getCachedAttachmentUri("u/n/other.jpg");
    await evictAttachmentCache(100);
    expect(fakeFs.files.has(`${CACHE}/u/n/new.jpg`)).toBe(false);
  });

  it("evicts by when a file was last used, not by its (copied, old) file time", async () => {
    put("u/n/prefetched.jpg", 50, 5_000);
    fakeFs.files.set("file:///picker/2023.jpg", { size: 50, mtime: 1 });
    jest.spyOn(Date, "now").mockReturnValue(9_000);
    copyIntoCache("file:///picker/2023.jpg", "u/n/2023.jpg");
    fakeFs.files.set(`${CACHE}/u/n/2023.jpg`, { size: 50, mtime: 1 });
    jest.restoreAllMocks();

    await evictAttachmentCache(60);

    expect(fakeFs.files.has(`${CACHE}/u/n/2023.jpg`)).toBe(true);
    expect(fakeFs.files.has(`${CACHE}/u/n/prefetched.jpg`)).toBe(false);
  });

  it("deletes nothing for an eviction a sign-out overtook", async () => {
    put("u/n/a.jpg", 500, 1);
    let rows: (value: unknown[]) => void = () => undefined;
    mockUnsyncedRows.mockReturnValue(new Promise((resolve) => (rows = resolve)));
    const eviction = evictAttachmentCache(10);
    await Promise.resolve();
    deleteAttachmentCache();
    // The next account's file happens to sit at the same path.
    put("u/n/a.jpg", 500, 1);
    rows([]);
    await eviction;
    expect(fakeFs.files.has(`${CACHE}/u/n/a.jpg`)).toBe(true);
  });

  it("keeps a file it could not delete in the index, so it is retried", async () => {
    put("u/n/old.jpg", 50, 1);
    put("u/n/new.jpg", 50, 2);
    const remove = jest.spyOn(FakeFile.prototype, "delete").mockImplementationOnce(() => {
      throw new Error("EBUSY");
    });
    await evictAttachmentCache(60);
    remove.mockRestore();
    expect(fakeFs.files.has(`${CACHE}/u/n/old.jpg`)).toBe(true);
    expect(getAttachmentCacheState().totalBytes).toBe(100);

    await evictAttachmentCache(60);
    expect(fakeFs.files.has(`${CACHE}/u/n/old.jpg`)).toBe(false);
    expect(getAttachmentCacheState().totalBytes).toBe(50);
  });

  it("runs once more for a call that joined it, counting a file written meanwhile", async () => {
    put("u/n/a.jpg", 50, 1);
    put("u/n/b.jpg", 50, 2);
    let releaseRows: (rows: unknown[]) => void = () => undefined;
    mockUnsyncedRows.mockReturnValueOnce(new Promise((resolve) => (releaseRows = resolve)));
    const first = evictAttachmentCache(60);
    fakeFs.download.mockResolvedValue({ size: 50, mtime: 1 });
    await downloadToCache("u/n/c.jpg", "https://signed/c");
    const joined = evictAttachmentCache(60);
    expect(joined).toBe(first);

    releaseRows([]);
    await joined;

    expect(filesUnder(CACHE)).toEqual([`${CACHE}/u/n/c.jpg`]);
    expect(getAttachmentCacheState().totalBytes).toBe(50);
  });

  it("never throws", async () => {
    put("u/n/a.jpg", 500);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockUnsyncedRows.mockRejectedValue(new Error("db"));
    await expect(evictAttachmentCache(10)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("caps the cache at 300 MB by default", () => {
    expect(ATTACHMENT_CACHE_MAX_BYTES).toBe(300 * 1024 * 1024);
  });
});

describe("the cache index", () => {
  it("keeps when each file was last used across a restart", async () => {
    put("u/n/prefetched.jpg", 50, 5_000);
    fakeFs.files.set("file:///picker/2023.jpg", { size: 50, mtime: 1 });
    jest.spyOn(Date, "now").mockReturnValue(9_000);
    copyIntoCache("file:///picker/2023.jpg", "u/n/2023.jpg");
    jest.restoreAllMocks();
    // The copy keeps the source's old file time, as File.copy does on iOS.
    fakeFs.files.set(`${CACHE}/u/n/2023.jpg`, { size: 50, mtime: 1 });
    flushAttachmentCacheIndex();

    // A restart: the in-memory index is gone, the files and the index file stay.
    const kept = new Map(fakeFs.files);
    deleteAttachmentCache();
    for (const [uri, file] of kept) fakeFs.files.set(uri, file);

    await evictAttachmentCache(60);
    expect(fakeFs.files.has(`${CACHE}/u/n/2023.jpg`)).toBe(true);
    expect(fakeFs.files.has(`${CACHE}/u/n/prefetched.jpg`)).toBe(false);
  });

  it("walks the cache once, then keeps a running total", async () => {
    put("u/n/a.jpg", 10);
    put("u/n/b.jpg", 20);
    expect(getAttachmentCacheState().totalBytes).toBe(30);
    const walks = fakeFs.listCalls.value;

    fakeFs.download.mockResolvedValue({ size: 5, mtime: 1 });
    await downloadToCache("u/n/c.jpg", "https://signed/c");
    deleteFromCache("u/n/a.jpg");
    await evictAttachmentCache(1_000);
    await evictAttachmentCache(1_000);

    const state = getAttachmentCacheState();
    expect(state.totalBytes).toBe(25);
    expect(state.isCached("u/n/c.jpg")).toBe(true);
    expect(state.isCached("u/n/a.jpg")).toBe(false);
    expect(fakeFs.listCalls.value).toBe(walks);
  });

  it("is never listed as a cached file", () => {
    put("u/n/a.jpg", 1);
    getCachedAttachmentUri("u/n/a.jpg");
    flushAttachmentCacheIndex();
    deleteAttachmentCacheIndexOnly();
    expect(listAttachmentCache().map((entry) => entry.relativePath)).toEqual(["u/n/a.jpg"]);
  });
});

/** Forget the in-memory index, keeping every file (as a restart does). */
function deleteAttachmentCacheIndexOnly(): void {
  const kept = new Map(fakeFs.files);
  deleteAttachmentCache();
  for (const [uri, file] of kept) fakeFs.files.set(uri, file);
}

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
    // A note in the trash still exists; a deleted one doesn't.
    mockNoteIds.mockResolvedValue(["live", "trashed"]);

    await removeOrphanedCacheFiles();

    expect(fakeFs.files.has(`${CACHE}/u/live/a.jpg`)).toBe(true);
    expect(fakeFs.files.has(`${CACHE}/u/trashed/b.jpg`)).toBe(true);
    expect(fakeFs.files.has(`${CACHE}/u/deleted/c.jpg`)).toBe(false);
    expect(fakeFs.files.has(`${CACHE}/u/live/no-row.jpg`)).toBe(false);
    expect(fakeFs.files.has(`${CACHE}/u/live/report.pdf`)).toBe(false);
    expect(getAttachmentCacheState().totalBytes).toBe(2);
  });

  it("keeps a file whose upload hasn't finished, and one still being saved", async () => {
    put("u/deleted/pending.jpg", 1);
    put("u/n/saving.jpg", 1);
    mockAllRows.mockResolvedValue([
      row("u/deleted/pending.jpg", "deleted", { uploadStatus: "pending" }),
    ]);
    const release = holdCacheFile("u/n/saving.jpg");

    await removeOrphanedCacheFiles();
    release();

    expect(fakeFs.files.has(`${CACHE}/u/deleted/pending.jpg`)).toBe(true);
    expect(fakeFs.files.has(`${CACHE}/u/n/saving.jpg`)).toBe(true);
  });

  it("clears leftovers of downloads an app exit cut short", async () => {
    fakeFs.files.set(`${CACHE}/.partial/id-1.part`, { size: 3, mtime: 1 });
    await removeOrphanedCacheFiles();
    expect(fakeFs.files.has(`${CACHE}/.partial/id-1.part`)).toBe(false);
  });

  it("keeps a running download's partial file, deleting only leftovers", async () => {
    fakeFs.files.set(`${CACHE}/.partial/old.part`, { size: 3, mtime: 1 });
    let finish: (file: { size: number; mtime: number }) => void = () => undefined;
    fakeFs.download.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const running = downloadToCache("u/n/a.jpg", "https://signed/a");
    const partial = `${CACHE}/.partial/id-${mockIdCounter}.part`;
    fakeFs.files.set(partial, { size: 1, mtime: 1 }); // the download is writing it

    await removeOrphanedCacheFiles();

    expect(fakeFs.files.has(`${CACHE}/.partial/old.part`)).toBe(false);
    expect(fakeFs.files.has(partial)).toBe(true);
    finish({ size: 6, mtime: 1 });
    await expect(running).resolves.toBe(`${CACHE}/u/n/a.jpg`);
  });

  it("never throws", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    put("u/n/a.jpg", 1);
    mockAllRows.mockRejectedValue(new Error("db"));
    await expect(removeOrphanedCacheFiles()).resolves.toBeUndefined();
    expect(fakeFs.files.has(`${CACHE}/u/n/a.jpg`)).toBe(true);
    warn.mockRestore();
  });
});

describe("deleteFromCache", () => {
  it("keeps a file it could not delete in the index, so the cleanup retries it", () => {
    put("u/n/a.jpg", 5);
    getAttachmentCacheState();
    const remove = jest.spyOn(FakeFile.prototype, "delete").mockImplementationOnce(() => {
      throw new Error("EBUSY");
    });
    deleteFromCache("u/n/a.jpg");
    remove.mockRestore();
    expect(getAttachmentCacheState().isCached("u/n/a.jpg")).toBe(true);
    deleteFromCache("u/n/a.jpg");
    expect(getAttachmentCacheState().isCached("u/n/a.jpg")).toBe(false);
  });
});

describe("listAttachmentCache", () => {
  it("lists every cached file, leaving out downloads in progress", () => {
    put("u/n/a.jpg", 1);
    put("u/m/b.png", 2);
    fakeFs.files.set(`${CACHE}/.partial/id-9.part`, { size: 3, mtime: 1 });
    expect(
      listAttachmentCache()
        .map((entry) => entry.relativePath)
        .sort(),
    ).toEqual(["u/m/b.png", "u/n/a.jpg"]);
  });

  it("is empty when there is no cache yet", () => {
    expect(listAttachmentCache()).toEqual([]);
  });
});

describe("deleteAttachmentCache", () => {
  it("removes every cached file", () => {
    put("u/n/a.jpg", 1);
    deleteAttachmentCache();
    expect(fakeFs.files.size).toBe(0);
  });

  it("never throws when the delete fails, so it can't block sign-out", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const FakeDirectory = fakeFs.module.Directory as { prototype: { delete: () => void } };
    put("u/n/a.jpg", 1);
    const remove = jest.spyOn(FakeDirectory.prototype, "delete").mockImplementation(() => {
      throw new Error("EBUSY");
    });
    expect(() => deleteAttachmentCache()).not.toThrow();
    remove.mockRestore();
    expect(warn).toHaveBeenCalledWith("Failed to delete the attachment cache:", expect.any(Error));
    warn.mockRestore();
  });
});
