import { fakeFs, resetFakeFs } from "../helpers/fake-expo-file-system";
import {
  ATTACHMENT_CACHE_MAX_BYTES,
  cacheFileFor,
  deleteAttachmentCache,
  downloadToCache,
  evictAttachmentCache,
  getCachedAttachmentUri,
  listAttachmentCache,
  retainInCache,
} from "@/lib/data/attachment-cache";

// A jest.mock factory can't close over imports, so it requires the shared fake.
jest.mock(
  "expo-file-system",
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require("../helpers/fake-expo-file-system").fakeFs.module,
);

const mockUnsyncedRows = jest.fn();
jest.mock("@/db", () => ({
  database: {
    get: () => ({ query: () => ({ fetch: () => mockUnsyncedRows() }) }),
  },
}));

let mockIdCounter = 0;
jest.mock("@/lib/generate-id", () => ({
  generateId: () => `id-${++mockIdCounter}`,
}));

const CACHE = "file:///docs/attachment-cache";
const put = (relativePath: string, size: number, mtime = 1_000) =>
  fakeFs.files.set(`${CACHE}/${relativePath}`, { size, mtime });

beforeEach(() => {
  resetFakeFs();
  mockUnsyncedRows.mockReset();
  mockUnsyncedRows.mockResolvedValue([]);
  deleteAttachmentCache();
});

describe("cacheFileFor", () => {
  it("places an attachment at its storage path under Documents/attachment-cache", () => {
    expect(cacheFileFor("user-1/note-1/photo.jpg").uri).toBe(`${CACHE}/user-1/note-1/photo.jpg`);
  });

  it("makes legacy key segments filesystem-safe", () => {
    expect(cacheFileFor("u/n/odd#name.jpg").uri).toBe(`${CACHE}/u/n/odd_name.jpg`);
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

  it("does nothing for a file that no longer exists", () => {
    retainInCache("file:///docs/attachments/gone.jpg", "u/n/a.jpg");
    expect(fakeFs.files.size).toBe(0);
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
});
