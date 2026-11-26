import { Directory } from "expo-file-system";

import { excludeFromBackup } from "@/lib/backup-exclusion";

jest.mock(
  "expo-file-system",
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require("../helpers/fake-expo-file-system").fakeFs.module,
);

// The native module is iOS only (apps/mobile/modules/backup-exclusion), so the
// test stands in for it.
const mockRequireOptionalNativeModule = jest.fn();
jest.mock("expo", () => ({
  requireOptionalNativeModule: (name: string) => mockRequireOptionalNativeModule(name),
}));

const CACHE = "file:///docs/attachment-cache";
const nativeExclude = jest.fn();

beforeEach(() => {
  nativeExclude.mockReset();
  mockRequireOptionalNativeModule.mockReset();
  mockRequireOptionalNativeModule.mockReturnValue({ excludeFromBackup: nativeExclude });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("excludeFromBackup", () => {
  it("passes the folder's file:// URI to the app's BackupExclusion module", () => {
    expect(excludeFromBackup(new Directory(CACHE))).toBe(true);
    expect(mockRequireOptionalNativeModule).toHaveBeenCalledWith("BackupExclusion");
    expect(nativeExclude).toHaveBeenCalledWith(CACHE);
  });

  it("is a no-op when there is no module (Android, or a build without it)", () => {
    mockRequireOptionalNativeModule.mockReturnValue(null);
    expect(excludeFromBackup(new Directory(CACHE))).toBe(false);
    expect(nativeExclude).not.toHaveBeenCalled();
  });

  it("returns false, and logs, when the native call throws, without throwing", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    nativeExclude.mockImplementation(() => {
      throw new Error("NSCocoaErrorDomain 4");
    });
    expect(excludeFromBackup(new Directory(CACHE))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "Failed to exclude a folder from backups:",
      expect.any(Error),
    );
  });
});
