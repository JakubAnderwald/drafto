import { areE2EProbesEnabled, isE2EProbesFlag } from "@/lib/e2e-probes";

describe("E2E probes flag", () => {
  it("is on only for exactly E2E_PROBES=1", () => {
    expect(isE2EProbesFlag("1")).toBe(true);
    expect(isE2EProbesFlag(undefined)).toBe(false);
    expect(isE2EProbesFlag("")).toBe(false);
    expect(isE2EProbesFlag("0")).toBe(false);
    expect(isE2EProbesFlag("true")).toBe(false);
  });

  it("is off in a build bundled without it", () => {
    expect(areE2EProbesEnabled()).toBe(false);
  });
});
