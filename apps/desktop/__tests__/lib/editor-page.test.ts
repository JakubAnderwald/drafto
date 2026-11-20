import RNFS from "react-native-fs";
import { editorPageFileName } from "@drafto/shared";

import {
  EDITOR_PAGE_WRITE_TIMEOUT_MS,
  ensureEditorPage,
  usesEditorPageFile,
  writeEditorPage,
} from "@/lib/editor-page";

const mockHtml = "<!doctype html><html><head></head><body>editor</body></html>";
jest.mock("@10play/tentap-editor", () => ({
  get editorHtml() {
    return mockHtml;
  },
}));

// An in-memory react-native-fs: files map a path to their text.
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
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
    stat: jest.fn(async (path: string) => {
      const text = mockFiles.get(path);
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return { size: text.length };
    }),
    mkdir: jest.fn(async (path: string, options?: unknown) => {
      mockMkdir(path, options);
      mockDirs.add(path);
    }),
    writeFile: jest.fn(async (path: string, text: string) => {
      mockFiles.set(path, text);
    }),
    unlink: jest.fn(async (path: string) => {
      for (const file of [...mockFiles.keys()])
        if (file === path || under(file, path)) mockFiles.delete(file);
      for (const dir of [...mockDirs]) if (dir === path || under(dir, path)) mockDirs.delete(dir);
    }),
    moveFile: jest.fn(async (from: string, to: string) => {
      const text = mockFiles.get(from);
      if (text === undefined) throw new Error(`ENOENT ${from}`);
      mockFiles.delete(from);
      mockFiles.set(to, text);
    }),
    readDir: jest.fn(async (dir: string) =>
      [...mockFiles.keys()]
        .filter((path) => under(path, dir) && !path.slice(dir.length + 1).includes("/"))
        .map((path) => ({ name: path.slice(dir.length + 1), path })),
    ),
  };
});

const CACHE = "/docs/attachment-cache";
const NAME = editorPageFileName(mockHtml);
const PAGE = `${CACHE}/.editor/${NAME}`;
const LOCATION = {
  uri: `file://${PAGE}`,
  readAccessUrl: `file://${CACHE}/`,
};

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mockMkdir.mockClear();
  jest.mocked(RNFS.writeFile).mockClear();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("usesEditorPageFile", () => {
  it("is always on: the app runs on WebKit", () => {
    expect(usesEditorPageFile()).toBe(true);
  });
});

describe("writeEditorPage", () => {
  it("writes TenTap's page into the cache's editor folder, with read access to the cache", async () => {
    await expect(writeEditorPage()).resolves.toEqual(LOCATION);
    expect(mockFiles.get(PAGE)).toBe(mockHtml);
    // Written beside its name, then moved: nothing half-written is left over.
    expect([...mockFiles.keys()]).toEqual([PAGE]);
    // The cache stays out of backups, as attachment-cache.ts creates it.
    expect(mockMkdir).toHaveBeenCalledWith(CACHE, { NSURLIsExcludedFromBackupKey: true });
  });

  it("leaves a page that is already there alone", async () => {
    await writeEditorPage();
    jest.mocked(RNFS.writeFile).mockClear();
    await expect(writeEditorPage()).resolves.toEqual(LOCATION);
    expect(RNFS.writeFile).not.toHaveBeenCalled();
  });

  it("rewrites an empty page", async () => {
    mockFiles.set(PAGE, "");
    await writeEditorPage();
    expect(mockFiles.get(PAGE)).toBe(mockHtml);
  });

  it("writes it again after the cache was deleted (sign-out)", async () => {
    await writeEditorPage();
    await RNFS.unlink(CACHE);
    await writeEditorPage();
    expect(mockFiles.get(PAGE)).toBe(mockHtml);
  });

  it("removes earlier versions of the page and an interrupted write, and nothing else", async () => {
    mockFiles.set(`${CACHE}/.editor/editor-old-1.html`, "old");
    mockFiles.set(`${CACHE}/.editor/${NAME}.tmp`, "ha");
    mockFiles.set(`${CACHE}/u/n/a.jpg`, "img");
    await writeEditorPage();
    expect([...mockFiles.keys()].sort()).toEqual([PAGE, `${CACHE}/u/n/a.jpg`].sort());
  });

  it("keeps the page when removing an old one fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFiles.set(`${CACHE}/.editor/editor-old-1.html`, "old");
    const unlink = jest.mocked(RNFS.unlink);
    unlink.mockImplementationOnce(async () => {
      throw new Error("EBUSY");
    });
    await expect(writeEditorPage()).resolves.toEqual(LOCATION);
    expect(mockFiles.get(PAGE)).toBe(mockHtml);
    expect(warn).toHaveBeenCalledWith("Failed to remove an old editor page:", expect.any(Error));
  });
});

describe("ensureEditorPage", () => {
  it("resolves to the page's location, writing it once for calls made together", async () => {
    const [first, second] = await Promise.all([ensureEditorPage(), ensureEditorPage()]);
    expect(first).toEqual(LOCATION);
    expect(second).toEqual(LOCATION);
    expect(RNFS.writeFile).toHaveBeenCalledTimes(1);
  });

  it("checks the page again on the next call, so a deleted page is written again", async () => {
    await ensureEditorPage();
    mockFiles.clear();
    await expect(ensureEditorPage()).resolves.toEqual(LOCATION);
    expect(mockFiles.get(PAGE)).toBe(mockHtml);
  });

  it("resolves to null, and logs, when the page can't be written", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.mocked(RNFS.writeFile).mockRejectedValueOnce(new Error("ENOSPC"));
    await expect(ensureEditorPage()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "Failed to write the editor page; loading it inline:",
      expect.any(Error),
    );
  });

  it("resolves to null when the write takes too long, so the editor never waits forever", async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    let finish: () => void = () => undefined;
    jest.mocked(RNFS.writeFile).mockImplementationOnce(
      (path: string, text: string) =>
        new Promise<void>((resolve) => {
          finish = () => {
            mockFiles.set(path, text);
            resolve();
          };
        }),
    );

    const page = ensureEditorPage();
    await jest.advanceTimersByTimeAsync(EDITOR_PAGE_WRITE_TIMEOUT_MS);
    await expect(page).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith("Writing the editor page timed out; loading it inline");

    // The write still finishes, for the next editor.
    finish();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockFiles.get(PAGE)).toBe(mockHtml);
  });
});
