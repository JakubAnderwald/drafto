import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import type { User } from "@supabase/supabase-js";

import {
  hasAppleIdentity,
  needsAppleConfirmation,
  requestAppleRevocationGrant,
} from "@/lib/apple-revocation";

const mockSignInAsync = jest.mocked(AppleAuthentication.signInAsync);

type Linkable = Pick<User, "identities" | "app_metadata">;

const appleUser = {
  app_metadata: { provider: "email", providers: ["email", "apple"] },
  identities: [
    { id: "u", user_id: "u", identity_id: "i1", provider: "email" },
    { id: "apple-sub", user_id: "u", identity_id: "i2", provider: "apple" },
  ],
} as Linkable;
const emailUser = {
  app_metadata: { provider: "email", providers: ["email"] },
  identities: [{ id: "u", user_id: "u", identity_id: "i1", provider: "email" }],
} as Linkable;

function credential(
  authorizationCode: string | null,
): AppleAuthentication.AppleAuthenticationCredential {
  return {
    user: "apple-sub",
    state: null,
    fullName: null,
    email: null,
    realUserStatus: 1,
    identityToken: "identity-token",
    authorizationCode,
  };
}

/** Shape of a native rejection: an `Error` carrying a string `code`. */
function nativeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("hasAppleIdentity", () => {
  it("finds an Apple identity", () => {
    expect(hasAppleIdentity(appleUser)).toBe(true);
  });

  it("falls back to the providers list when identities are absent", () => {
    expect(hasAppleIdentity({ app_metadata: { providers: ["apple"] } })).toBe(true);
  });

  it.each([
    ["an email-only user", emailUser],
    ["a Google user", { app_metadata: { providers: ["google"] }, identities: [] } as Linkable],
    ["a user with no metadata", { app_metadata: {} } as Linkable],
    ["no user", null],
    ["an undefined user", undefined],
  ])("is false for %s", (_label, user) => {
    expect(hasAppleIdentity(user)).toBe(false);
  });
});

describe("needsAppleConfirmation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("is true for an Apple-linked user on iOS", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    expect(needsAppleConfirmation(appleUser)).toBe(true);
    expect(needsAppleConfirmation(emailUser)).toBe(false);
  });

  it("is false on Android, which has no native Apple sheet", () => {
    jest.replaceProperty(Platform, "OS", "android");
    expect(needsAppleConfirmation(appleUser)).toBe(false);
  });
});

describe("requestAppleRevocationGrant", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(Platform, "OS", "ios");
    mockSignInAsync.mockResolvedValue(credential("fresh-code"));
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("asks Apple for a fresh code, with no name or email, for the native client", async () => {
    expect(await requestAppleRevocationGrant(appleUser)).toEqual({
      authorizationCode: "fresh-code",
      clientId: "eu.drafto.mobile",
    });
    expect(mockSignInAsync).toHaveBeenCalledWith({ requestedScopes: [] });
  });

  it("never opens Apple's sheet for a user who is not linked to Apple", async () => {
    expect(await requestAppleRevocationGrant(emailUser)).toBeNull();
    expect(mockSignInAsync).not.toHaveBeenCalled();
  });

  it("never opens Apple's sheet on Android", async () => {
    jest.replaceProperty(Platform, "OS", "android");

    expect(await requestAppleRevocationGrant(appleUser)).toBeNull();
    expect(mockSignInAsync).not.toHaveBeenCalled();
  });

  it("returns null quietly when the user cancels", async () => {
    mockSignInAsync.mockRejectedValue(nativeError("ERR_REQUEST_CANCELED"));

    expect(await requestAppleRevocationGrant(appleUser)).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns null and logs the code when Apple fails", async () => {
    mockSignInAsync.mockRejectedValue(nativeError("ERR_REQUEST_FAILED"));

    expect(await requestAppleRevocationGrant(appleUser)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("[apple-revocation] Apple confirmation failed", {
      code: "ERR_REQUEST_FAILED",
    });
  });

  it("returns null when Apple returns no authorization code", async () => {
    mockSignInAsync.mockResolvedValue(credential(null));

    expect(await requestAppleRevocationGrant(appleUser)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("[apple-revocation] Apple returned no authorization code");
  });
});
