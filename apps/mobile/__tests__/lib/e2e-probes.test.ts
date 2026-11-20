import { areE2EProbesEnabled, isE2EProbesFlag } from "@/lib/e2e-probes";

const mockExtra: { e2eProbes?: unknown } = {};
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: mockExtra };
    },
  },
}));

describe("E2E probes flag", () => {
  beforeEach(() => {
    delete mockExtra.e2eProbes;
  });

  it("is on only when the build set it (EXPO_PUBLIC_E2E_PROBES=1)", () => {
    mockExtra.e2eProbes = true;
    expect(areE2EProbesEnabled()).toBe(true);
  });

  it("is off by default, and for anything but true", () => {
    expect(areE2EProbesEnabled()).toBe(false);
    for (const value of [false, "1", 1, null, undefined]) {
      expect(isE2EProbesFlag(value)).toBe(false);
    }
  });
});
