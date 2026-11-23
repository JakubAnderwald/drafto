import { describe, it, expect } from "vitest";
import {
  APPLE_REVOCATION_ORIGIN,
  DRAFTO_WEB_ORIGIN,
  PRIVACY_POLICY_PATH,
  PRIVACY_POLICY_URL,
  SIGNUP_EMAIL_REDIRECT_URL,
  SUPPORT_PATH,
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

  it("builds each URL from the same path the web links relatively", () => {
    expect(PRIVACY_POLICY_PATH).toBe("/privacy");
    expect(SUPPORT_PATH).toBe("/support");
    expect(new URL(PRIVACY_POLICY_URL).pathname).toBe(PRIVACY_POLICY_PATH);
    expect(new URL(SUPPORT_URL).pathname).toBe(SUPPORT_PATH);
  });

  it("shares its origin with the sign-up redirect and the Apple revocation relay", () => {
    expect(SIGNUP_EMAIL_REDIRECT_URL).toBe("https://drafto.eu/login?confirmed=1");
    expect(new URL(SIGNUP_EMAIL_REDIRECT_URL).origin).toBe(DRAFTO_WEB_ORIGIN);
    expect(APPLE_REVOCATION_ORIGIN).toBe(DRAFTO_WEB_ORIGIN);
  });
});
