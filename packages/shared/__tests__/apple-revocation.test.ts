import { describe, expect, it } from "vitest";
import {
  APPLE_AUTHORIZE_URL,
  APPLE_REVOCATION_REDIRECT_URI,
  APPLE_REVOCATION_RETURN_URLS,
  APPLE_SERVICES_ID,
  appleDeletionNotice,
  buildAppleRevocationAuthorizeUrl,
  buildAppleRevocationDeepLink,
  buildAppleRevocationState,
  hasAppleIdentity,
  isAppleAuthorizationCode,
  isAppleErrorCode,
  isAppleRevocationDeepLink,
  isAppleRevocationNonce,
  parseAppleRevocationState,
  readAppleRevocationCallback,
} from "../src";

const NONCE = "abcdefghijklmnop_0123-XYZ";
const CODE = "c0ffee1234.0.rrqv.AbCdEf-ghIJ_kl";

describe("constants", () => {
  it("returns every revocation code to the registered drafto.eu URL", () => {
    expect(APPLE_SERVICES_ID).toBe("eu.drafto.web.auth");
    expect(APPLE_REVOCATION_REDIRECT_URI).toBe("https://drafto.eu/auth/apple/revocation");
    expect(APPLE_REVOCATION_RETURN_URLS).toEqual({
      android: "drafto://auth/apple-revocation",
      macos: "eu.drafto.desktop://auth/apple-revocation",
    });
  });
});

describe("value checks", () => {
  it("accepts Apple-shaped codes and refuses anything else", () => {
    expect(isAppleAuthorizationCode(CODE)).toBe(true);
    expect(isAppleAuthorizationCode("")).toBe(false);
    expect(isAppleAuthorizationCode("a b")).toBe(false);
    expect(isAppleAuthorizationCode('x"><script>')).toBe(false);
    expect(isAppleAuthorizationCode("a".repeat(1025))).toBe(false);
    expect(isAppleAuthorizationCode(42)).toBe(false);
  });

  it("accepts snake_case error codes only", () => {
    expect(isAppleErrorCode("user_cancelled_authorize")).toBe(true);
    expect(isAppleErrorCode("User-Cancelled")).toBe(false);
    expect(isAppleErrorCode("a".repeat(65))).toBe(false);
    expect(isAppleErrorCode(null)).toBe(false);
  });

  it("accepts URL-safe nonces of 16 to 128 characters", () => {
    expect(isAppleRevocationNonce(NONCE)).toBe(true);
    expect(isAppleRevocationNonce("short")).toBe(false);
    expect(isAppleRevocationNonce("a".repeat(129))).toBe(false);
    expect(isAppleRevocationNonce("abcdefghijklmnop.q")).toBe(false);
  });
});

describe("state", () => {
  it("round-trips the platform tag and nonce", () => {
    const state = buildAppleRevocationState("macos", NONCE);
    expect(state).toBe(`macos.${NONCE}`);
    expect(parseAppleRevocationState(state)).toEqual({ platform: "macos", nonce: NONCE });
    expect(parseAppleRevocationState(buildAppleRevocationState("android", NONCE))).toEqual({
      platform: "android",
      nonce: NONCE,
    });
  });

  it("refuses a bad nonce when building", () => {
    expect(() => buildAppleRevocationState("android", "short")).toThrow(/nonce/);
  });

  it("returns null for unknown platforms and malformed states", () => {
    expect(parseAppleRevocationState(`ios.${NONCE}`)).toBeNull();
    expect(parseAppleRevocationState(`web.${NONCE}`)).toBeNull();
    expect(parseAppleRevocationState(`android.${NONCE}.extra`)).toBeNull();
    expect(parseAppleRevocationState("android.")).toBeNull();
    expect(parseAppleRevocationState(undefined)).toBeNull();
  });
});

describe("buildAppleRevocationAuthorizeUrl", () => {
  it("asks for a form_post code for the Services ID, with no scope", () => {
    const state = buildAppleRevocationState("android", NONCE);
    const url = new URL(buildAppleRevocationAuthorizeUrl(state));
    expect(`${url.origin}${url.pathname}`).toBe(APPLE_AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe(APPLE_SERVICES_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(APPLE_REVOCATION_REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("response_mode")).toBe("form_post");
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("deep links", () => {
  const state = buildAppleRevocationState("android", NONCE);

  it("builds a code link on the platform's fixed scheme", () => {
    expect(buildAppleRevocationDeepLink("android", { state, code: CODE })).toBe(
      `drafto://auth/apple-revocation?code=${encodeURIComponent(CODE)}&state=${state}`,
    );
    expect(
      buildAppleRevocationDeepLink("macos", { state, error: "user_cancelled_authorize" }),
    ).toBe(
      `eu.drafto.desktop://auth/apple-revocation?error=user_cancelled_authorize&state=${state}`,
    );
  });

  it("recognises revocation links and router paths only", () => {
    expect(isAppleRevocationDeepLink("drafto://auth/apple-revocation?code=x")).toBe(true);
    expect(isAppleRevocationDeepLink("eu.drafto.desktop://auth/apple-revocation/")).toBe(true);
    expect(isAppleRevocationDeepLink("/auth/apple-revocation?state=x")).toBe(true);
    expect(isAppleRevocationDeepLink("auth/apple-revocation")).toBe(true);
    expect(isAppleRevocationDeepLink("eu.drafto.desktop://auth/callback?code=x")).toBe(false);
    expect(isAppleRevocationDeepLink("drafto://auth/apple-revocation-x")).toBe(false);
    expect(isAppleRevocationDeepLink("drafto://notes/auth/apple-revocation")).toBe(false);
  });
});

describe("readAppleRevocationCallback", () => {
  const state = buildAppleRevocationState("macos", NONCE);

  it("returns the code for the expected state", () => {
    const url = buildAppleRevocationDeepLink("macos", { state, code: CODE });
    expect(readAppleRevocationCallback(url, state)).toEqual({
      kind: "code",
      authorizationCode: CODE,
    });
  });

  it("returns Apple's error for the expected state", () => {
    const url = buildAppleRevocationDeepLink("macos", { state, error: "user_cancelled_authorize" });
    expect(readAppleRevocationCallback(url, state)).toEqual({
      kind: "error",
      error: "user_cancelled_authorize",
    });
  });

  it("reports a missing or malformed code as an error", () => {
    expect(
      readAppleRevocationCallback(
        `eu.drafto.desktop://auth/apple-revocation?state=${state}`,
        state,
      ),
    ).toEqual({
      kind: "error",
      error: "invalid_response",
    });
    expect(
      readAppleRevocationCallback(
        `eu.drafto.desktop://auth/apple-revocation?code=%3Cscript%3E&error=Bad-Error&state=${state}`,
        state,
      ),
    ).toEqual({ kind: "error", error: "invalid_response" });
  });

  it("ignores another confirmation's state, a missing state, and other links", () => {
    const other = buildAppleRevocationState("macos", "zzzzzzzzzzzzzzzzzzzz");
    expect(
      readAppleRevocationCallback(
        buildAppleRevocationDeepLink("macos", { state: other, code: CODE }),
        state,
      ),
    ).toEqual({ kind: "not-ours" });
    expect(
      readAppleRevocationCallback(`eu.drafto.desktop://auth/apple-revocation?code=${CODE}`, state),
    ).toEqual({ kind: "not-ours" });
    expect(
      readAppleRevocationCallback(
        `eu.drafto.desktop://auth/callback?code=${CODE}&state=${state}`,
        state,
      ),
    ).toEqual({
      kind: "not-ours",
    });
    expect(
      readAppleRevocationCallback(buildAppleRevocationDeepLink("macos", { state, code: CODE }), ""),
    ).toEqual({ kind: "not-ours" });
  });

  it("keeps the first value of a repeated parameter and skips malformed escapes", () => {
    const url = `eu.drafto.desktop://auth/apple-revocation?state=${state}&code=${CODE}&state=evil&code=%E0%A4%A&x=1#frag`;
    expect(readAppleRevocationCallback(url, state)).toEqual({
      kind: "code",
      authorizationCode: CODE,
    });
  });
});

describe("hasAppleIdentity", () => {
  it("detects an Apple identity or provider", () => {
    expect(hasAppleIdentity({ identities: [{ provider: "email" }, { provider: "apple" }] })).toBe(
      true,
    );
    expect(
      hasAppleIdentity({ identities: [], app_metadata: { providers: ["email", "apple"] } }),
    ).toBe(true);
  });

  it("is false without one", () => {
    expect(hasAppleIdentity(null)).toBe(false);
    expect(hasAppleIdentity(undefined)).toBe(false);
    expect(hasAppleIdentity({ identities: [{ provider: "google" }] })).toBe(false);
    expect(hasAppleIdentity({ app_metadata: { providers: "apple" } })).toBe(false);
    expect(hasAppleIdentity({ identities: null, app_metadata: null })).toBe(false);
  });
});

describe("appleDeletionNotice", () => {
  it("says where Apple asks and that cancelling still deletes", () => {
    expect(appleDeletionNotice("sheet")).toBe(
      "You use Sign in with Apple, so Apple will ask you to confirm. This lets Drafto stop " +
        "using your Apple ID. If you cancel that step, your account is still deleted.",
    );
    expect(appleDeletionNotice("popup")).toContain("in a pop-up window");
    expect(appleDeletionNotice("browser")).toContain("in your browser");
    for (const kind of ["sheet", "popup", "browser"] as const) {
      expect(appleDeletionNotice(kind)).toContain("your account is still deleted");
    }
  });
});
