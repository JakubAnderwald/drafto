import { describe, expect, it } from "vitest";

import {
  SIGN_OUT_ANYWAY_LABEL,
  SIGN_OUT_CONFIRM_LABEL,
  SIGN_OUT_SYNCED_MESSAGE,
  SIGN_OUT_UNKNOWN_MESSAGE,
  describeSignOut,
  describeUnsyncedLoss,
} from "../src/index";

describe("sign-out confirmation copy", () => {
  it("describes the loss in the singular and the plural", () => {
    expect(describeUnsyncedLoss(1)).toBe("1 change hasn't synced and will be lost.");
    expect(describeUnsyncedLoss(4)).toBe("4 changes haven't synced and will be lost.");
  });

  it("keeps the wording the macOS In-Test harness matches", () => {
    // apps/desktop/e2e/in-test/lib/app.sh, sign_out_confirm_copy.
    const harness = /^[0-9]+ changes? (hasn.t|haven.t) synced/;
    expect(describeUnsyncedLoss(1)).toMatch(harness);
    expect(describeUnsyncedLoss(12)).toMatch(harness);
    expect(describeUnsyncedLoss(3)).toContain("synced and will be lost");
  });

  it("reassures and confirms with Sign out when nothing is pending", () => {
    expect(describeSignOut(0)).toEqual({
      message: SIGN_OUT_SYNCED_MESSAGE,
      confirmLabel: SIGN_OUT_CONFIRM_LABEL,
    });
  });

  it("counts the loss and confirms with Sign out anyway when changes are pending", () => {
    expect(describeSignOut(2)).toEqual({
      message: "2 changes haven't synced and will be lost.",
      confirmLabel: SIGN_OUT_ANYWAY_LABEL,
    });
  });

  it("warns generically when the count could not be read", () => {
    expect(describeSignOut(null)).toEqual({
      message: SIGN_OUT_UNKNOWN_MESSAGE,
      confirmLabel: SIGN_OUT_CONFIRM_LABEL,
    });
  });
});
