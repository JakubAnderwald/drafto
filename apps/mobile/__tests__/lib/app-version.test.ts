import { formatAppVersion, getAppVersionLabel } from "@/lib/app-version";

const mockConstants: {
  expoConfig: { version?: string } | null;
  platform: { ios?: { buildNumber: string | null } } | undefined;
} = { expoConfig: null, platform: undefined };

jest.mock("expo-constants", () => ({
  __esModule: true,
  get default() {
    return mockConstants;
  },
}));

describe("app version (PrimeTestLab 11035 S-01)", () => {
  beforeEach(() => {
    mockConstants.expoConfig = null;
    mockConstants.platform = undefined;
  });

  describe("formatAppVersion", () => {
    it("adds the build number in parentheses", () => {
      expect(formatAppVersion("1.7.0", "82")).toBe("1.7.0 (82)");
    });

    it("shows the version alone without a build number", () => {
      expect(formatAppVersion("1.7.0", null)).toBe("1.7.0");
      expect(formatAppVersion("1.7.0", undefined)).toBe("1.7.0");
      expect(formatAppVersion("1.7.0", "")).toBe("1.7.0");
    });

    it("says Unknown without a version", () => {
      expect(formatAppVersion(undefined, "82")).toBe("Unknown");
      expect(formatAppVersion("", null)).toBe("Unknown");
    });
  });

  describe("getAppVersionLabel", () => {
    it("reads the config version and the iOS build number", () => {
      mockConstants.expoConfig = { version: "1.7.0" };
      mockConstants.platform = { ios: { buildNumber: "82" } };

      expect(getAppVersionLabel()).toBe("1.7.0 (82)");
    });

    it("shows the version alone on Android, which has no build number", () => {
      mockConstants.expoConfig = { version: "1.7.0" };
      mockConstants.platform = {};

      expect(getAppVersionLabel()).toBe("1.7.0");
    });

    it("says Unknown when the config can't be read", () => {
      expect(getAppVersionLabel()).toBe("Unknown");
    });
  });
});
