import { fakeFs, resetFakeFs } from "../helpers/fake-expo-file-system";
import {
  ensureAttachmentCacheRoot,
  forgetAttachmentCacheRoot,
  getAttachmentCacheDir,
} from "@/lib/data/attachment-cache-root";

jest.mock(
  "expo-file-system",
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require("../helpers/fake-expo-file-system").fakeFs.module,
);

const mockExcludeFromBackup = jest.fn();
jest.mock("@/lib/backup-exclusion", () => ({
  excludeFromBackup: (dir: { uri: string }) => mockExcludeFromBackup(dir),
}));

const CACHE = "file:///docs/attachment-cache";

beforeEach(() => {
  resetFakeFs();
  forgetAttachmentCacheRoot();
  mockExcludeFromBackup.mockReset();
  mockExcludeFromBackup.mockReturnValue(true);
});

describe("getAttachmentCacheDir", () => {
  it("is <Documents>/attachment-cache, and doesn't create it", () => {
    expect(getAttachmentCacheDir().uri).toBe(CACHE);
    expect(fakeFs.dirs.has(CACHE)).toBe(false);
    expect(mockExcludeFromBackup).not.toHaveBeenCalled();
  });
});

describe("ensureAttachmentCacheRoot", () => {
  it("creates the folder, then flags it to stay out of backups", () => {
    mockExcludeFromBackup.mockImplementation(() => {
      // The flag is set on a folder that exists.
      expect(fakeFs.dirs.has(CACHE)).toBe(true);
      return true;
    });
    expect(ensureAttachmentCacheRoot().uri).toBe(CACHE);
    expect(mockExcludeFromBackup).toHaveBeenCalledWith(expect.objectContaining({ uri: CACHE }));
  });

  it("sets the flag once per launch", () => {
    ensureAttachmentCacheRoot();
    ensureAttachmentCacheRoot();
    ensureAttachmentCacheRoot();
    expect(mockExcludeFromBackup).toHaveBeenCalledTimes(1);
  });

  it("sets it again after forgetAttachmentCacheRoot (the sign-out wipe deleted the folder)", () => {
    ensureAttachmentCacheRoot();
    forgetAttachmentCacheRoot();
    fakeFs.dirs.delete(CACHE);
    ensureAttachmentCacheRoot();
    expect(fakeFs.dirs.has(CACHE)).toBe(true);
    expect(mockExcludeFromBackup).toHaveBeenCalledTimes(2);
  });

  it("tries again on the next call after a failure, and a failure never throws", () => {
    mockExcludeFromBackup.mockReturnValueOnce(false);
    expect(() => ensureAttachmentCacheRoot()).not.toThrow();
    expect(fakeFs.dirs.has(CACHE)).toBe(true);
    ensureAttachmentCacheRoot();
    ensureAttachmentCacheRoot();
    expect(mockExcludeFromBackup).toHaveBeenCalledTimes(2);
  });
});
