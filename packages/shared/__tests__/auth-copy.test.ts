import { describe, expect, it } from "vitest";

import {
  ACCOUNT_DELETED_MESSAGE,
  EMAIL_CONFIRMED,
  PASSWORD_VISIBILITY_LABELS,
  SIGNUP_CONFIRMATION_SENT,
  SIGNUP_EMAIL_REDIRECT_URL,
} from "../src/index";

describe("auth copy shared by every platform", () => {
  it("sends the apps' confirmation link to the web login page's confirmed notice", () => {
    // The web login page shows EMAIL_CONFIRMED only for exactly `confirmed=1`.
    const url = new URL(SIGNUP_EMAIL_REDIRECT_URL);

    expect(url.origin).toBe("https://drafto.eu");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("confirmed")).toBe("1");
  });

  it("does not claim an account was created, since an existing address gets the same answer", () => {
    expect(SIGNUP_CONFIRMATION_SENT).toMatch(/^If this address is new to Drafto/);
    expect(SIGNUP_CONFIRMATION_SENT).toContain("If you already have an account, just log in.");
  });

  it("keeps the notices short, final sentences", () => {
    for (const copy of [ACCOUNT_DELETED_MESSAGE, EMAIL_CONFIRMED]) {
      expect(copy.endsWith(".")).toBe(true);
      expect(copy.length).toBeLessThan(80);
    }
  });

  it("names the password toggle so no label equals a field's own label", () => {
    expect(PASSWORD_VISIBILITY_LABELS).toEqual({ show: "Show password", hide: "Hide password" });
    for (const fieldLabel of ["Password", "New Password", "Confirm Password"]) {
      expect(PASSWORD_VISIBILITY_LABELS.show).not.toBe(fieldLabel);
      expect(PASSWORD_VISIBILITY_LABELS.hide).not.toBe(fieldLabel);
    }
  });
});
