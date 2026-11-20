import { Platform } from "react-native";
import { editorPageFileName } from "@drafto/shared";

import { fakeFs, resetFakeFs } from "../helpers/fake-expo-file-system";
import { ensureEditorPage, usesEditorPageFile, writeEditorPage } from "@/lib/editor-page";

jest.mock(
  "expo-file-system",
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require("../helpers/fake-expo-file-system").fakeFs.module,
);

const mockHtml = "<!doctype html><html><head></head><body>editor</body></html>";
jest.mock("@10play/tentap-editor", () => ({
  get editorHtml() {
    return mockHtml;
  },
}));

const CACHE = "file:///docs/attachment-cache";
const NAME = editorPageFileName(mockHtml);
const PAGE = `${CACHE}/.editor/${NAME}`;
const FakeFile = fakeFs.module.File as { prototype: { write: (content: string) => void } };

beforeEach(() => {
  resetFakeFs();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("usesEditorPageFile", () => {
  const original = Platform.OS;
  afterEach(() => {
    Platform.OS = original;
  });

  it("is on for iOS (WebKit) and off for Android, which keeps the inline page", () => {
    Platform.OS = "ios";
    expect(usesEditorPageFile()).toBe(true);
    Platform.OS = "android";
    expect(usesEditorPageFile()).toBe(false);
  });
});

describe("writeEditorPage", () => {
  it("writes TenTap's page into the cache's editor folder, with read access to the cache", () => {
    expect(writeEditorPage()).toEqual({
      uri: PAGE,
      readAccessUrl: `${CACHE}/`,
    });
    expect(fakeFs.files.get(PAGE)?.text).toBe(mockHtml);
    // Written beside its name, then moved: nothing half-written is left over.
    expect([...fakeFs.files.keys()]).toEqual([PAGE]);
  });

  it("leaves a page that is already there alone", () => {
    writeEditorPage();
    const write = jest.spyOn(FakeFile.prototype, "write");
    expect(writeEditorPage().uri).toBe(PAGE);
    expect(write).not.toHaveBeenCalled();
  });

  it("rewrites an empty page", () => {
    fakeFs.files.set(PAGE, { size: 0, mtime: 1 });
    writeEditorPage();
    expect(fakeFs.files.get(PAGE)?.text).toBe(mockHtml);
  });

  it("writes it again after the cache was deleted (sign-out)", () => {
    writeEditorPage();
    fakeFs.files.clear();
    fakeFs.dirs.clear();
    fakeFs.dirs.add("file:///docs");
    writeEditorPage();
    expect(fakeFs.files.get(PAGE)?.text).toBe(mockHtml);
  });

  it("removes earlier versions of the page and an interrupted write, and nothing else", () => {
    fakeFs.files.set(`${CACHE}/.editor/editor-old-1.html`, { size: 5, mtime: 1 });
    fakeFs.files.set(`${CACHE}/.editor/${NAME}.tmp`, { size: 2, mtime: 1 });
    fakeFs.files.set(`${CACHE}/u/n/a.jpg`, { size: 3, mtime: 1 });
    writeEditorPage();
    expect([...fakeFs.files.keys()].sort()).toEqual([PAGE, `${CACHE}/u/n/a.jpg`].sort());
  });

  it("throws when the write fails", () => {
    jest.spyOn(FakeFile.prototype, "write").mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    expect(() => writeEditorPage()).toThrow("ENOSPC");
    expect(fakeFs.files.has(PAGE)).toBe(false);
  });
});

describe("ensureEditorPage", () => {
  it("resolves to the page's location, writing it once for calls made together", async () => {
    const write = jest.spyOn(FakeFile.prototype, "write");
    const [first, second] = await Promise.all([ensureEditorPage(), ensureEditorPage()]);
    expect(first).toEqual({ uri: PAGE, readAccessUrl: `${CACHE}/` });
    expect(second).toEqual(first);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("checks the page again on the next call, so a deleted page is written again", async () => {
    await ensureEditorPage();
    fakeFs.files.clear();
    await expect(ensureEditorPage()).resolves.toEqual({ uri: PAGE, readAccessUrl: `${CACHE}/` });
    expect(fakeFs.files.has(PAGE)).toBe(true);
  });

  it("resolves to null, and logs, when the page can't be written", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(FakeFile.prototype, "write").mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    await expect(ensureEditorPage()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "Failed to write the editor page; loading it inline:",
      expect.any(Error),
    );
  });
});
