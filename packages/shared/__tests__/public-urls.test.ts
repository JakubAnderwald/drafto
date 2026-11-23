import { describe, it, expect } from "vitest";
import {
  DRAFTO_WEB_ORIGIN,
  PRIVACY_POLICY_URL,
  SIGNUP_EMAIL_REDIRECT_URL,
  SUPPORT_URL,
} from "../src";

describe("public drafto.eu URLs (PrimeTestLab 11035 S-01)", () => {
  it("points at the prod apex origin, never www or a preview", () => {
    expect(DRAFTO_WEB_ORIGIN).toBe("https://drafto.eu");
  });

  it("links the privacy policy and support pages on that origin", () => {
    expect(PRIVACY_POLICY_URL).toBe("https://drafto.eu/privacy");
    expect(SUPPORT_URL).toBe("https://drafto.eu/support");
    expect(new URL(PRIVACY_POLICY_URL).origin).toBe(DRAFTO_WEB_ORIGIN);
    expect(new URL(SUPPORT_URL).origin).toBe(DRAFTO_WEB_ORIGIN);
  });

  it("shares its origin with the sign-up confirmation redirect", () => {
    expect(new URL(SIGNUP_EMAIL_REDIRECT_URL).origin).toBe(DRAFTO_WEB_ORIGIN);
  });
});
