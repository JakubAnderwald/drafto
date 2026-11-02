import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import * as WebBrowser from "expo-web-browser";
import type { User } from "@supabase/supabase-js";
import { buildAppleRevocationDeepLink, parseAppleRevocationState } from "@drafto/shared";

import {
  appleConfirmationKind,
  claimAppleRevocationDelivery,
  hasAppleIdentity,
  isAppleRevocationPath,
  needsAppleConfirmation,
  requestAppleRevocationGrant,
} from "@/lib/apple-revocation";

jest.mock("expo-crypto", () => ({
  getRandomValues: <T extends Uint8Array>(array: T): T => {
    array.fill(0xab);
    return array;
  },
}));

const mockSignInAsync = jest.mocked(AppleAuthentication.signInAsync);
const mockOpenAuthSession = jest.mocked(WebBrowser.openAuthSessionAsync);

/** The session ended without a redirect. The enum is not in the test mock, so use its value. */
function closedWith(type: "cancel" | "dismiss"): WebBrowser.WebBrowserAuthSessionResult {
  return { type } as WebBrowser.WebBrowserAuthSessionResult;
}

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

  it("is true for an Apple-linked user on Android, which confirms in the browser", () => {
    jest.replaceProperty(Platform, "OS", "android");
    expect(needsAppleConfirmation(appleUser)).toBe(true);
    expect(needsAppleConfirmation(emailUser)).toBe(false);
  });
});

describe("appleConfirmationKind", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("is the native sheet on iOS and the browser on Android", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    expect(appleConfirmationKind(appleUser)).toBe("sheet");
    jest.replaceProperty(Platform, "OS", "android");
    expect(appleConfirmationKind(appleUser)).toBe("browser");
  });

  it("is null for a user who is not linked to Apple, or no user", () => {
    jest.replaceProperty(Platform, "OS", "android");
    expect(appleConfirmationKind(emailUser)).toBeNull();
    expect(appleConfirmationKind(null)).toBeNull();
  });

  it("is null on any other platform", () => {
    jest.replaceProperty(Platform, "OS", "web");
    expect(appleConfirmationKind(appleUser)).toBeNull();
  });
});

describe("isAppleRevocationPath", () => {
  it.each([
    "drafto://auth/apple-revocation?code=c&state=s",
    "drafto://auth/apple-revocation",
    "/auth/apple-revocation?error=user_cancelled_authorize&state=s",
  ])("claims %s", (path) => {
    expect(isAppleRevocationPath(path)).toBe(true);
  });

  it.each(["drafto://auth/callback?code=c", "drafto://notes/123", "/auth/apple-revocation-x"])(
    "leaves %s alone",
    (path) => {
      expect(isAppleRevocationPath(path)).toBe(false);
    },
  );
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

  it("never opens the browser on iOS", async () => {
    await requestAppleRevocationGrant(appleUser);
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
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

describe("requestAppleRevocationGrant on Android", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(Platform, "OS", "android");
    mockOpenAuthSession.mockResolvedValue(closedWith("cancel"));
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The state the app sent to Apple, read back from the authorize URL it opened. */
  function sentState(): string {
    const authorizeUrl = mockOpenAuthSession.mock.calls[0]?.[0] ?? "";
    const match = /[?&]state=([^&]+)/.exec(authorizeUrl);
    return decodeURIComponent(match?.[1] ?? "");
  }

  /** Answers the browser session with the relay's deep link for the state the app sent. */
  function answerWith(fields: { code: string } | { error: string }, state?: string) {
    mockOpenAuthSession.mockImplementation(async (authorizeUrl: string) => {
      const sent = decodeURIComponent(/[?&]state=([^&]+)/.exec(authorizeUrl)?.[1] ?? "");
      return {
        type: "success",
        url: buildAppleRevocationDeepLink("android", { ...fields, state: state ?? sent }),
      };
    });
  }

  it("opens Apple's page for the Services ID and returns its code as a Services ID grant", async () => {
    answerWith({ code: "c.fresh-code" });

    expect(await requestAppleRevocationGrant(appleUser)).toEqual({
      authorizationCode: "c.fresh-code",
      clientId: "eu.drafto.web.auth",
    });

    const [authorizeUrl, returnUrl] = mockOpenAuthSession.mock.calls[0] ?? [];
    expect(returnUrl).toBe("drafto://auth/apple-revocation");
    expect(authorizeUrl).toMatch(/^https:\/\/appleid\.apple\.com\/auth\/authorize\?/);
    expect(authorizeUrl).toContain("client_id=eu.drafto.web.auth");
    expect(authorizeUrl).toContain("response_mode=form_post");
    expect(authorizeUrl).not.toContain("scope=");
    expect(parseAppleRevocationState(sentState())).toEqual({
      platform: "android",
      nonce: "ab".repeat(16),
    });
    expect(mockSignInAsync).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(["cancel", "dismiss"] as const)(
    "returns null quietly when the browser ends with %s",
    async (type) => {
      mockOpenAuthSession.mockResolvedValue(closedWith(type));

      expect(await requestAppleRevocationGrant(appleUser)).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );

  /** The browser session ends with "dismiss"; the router delivers the relay's link instead. */
  function dismissThenRouterDelivers(code: string, { before }: { before: boolean }) {
    mockOpenAuthSession.mockImplementation(async (authorizeUrl: string) => {
      const sent = decodeURIComponent(/[?&]state=([^&]+)/.exec(authorizeUrl)?.[1] ?? "");
      const deliver = () =>
        claimAppleRevocationDelivery(
          buildAppleRevocationDeepLink("android", { code, state: sent }),
        );
      if (before) deliver();
      else setTimeout(deliver, 10);
      return closedWith("dismiss");
    });
  }

  it("takes the code from the router's copy when the session dismissed before the link arrived", async () => {
    dismissThenRouterDelivers("c.router-code", { before: false });

    expect(await requestAppleRevocationGrant(appleUser)).toEqual({
      authorizationCode: "c.router-code",
      clientId: "eu.drafto.web.auth",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("takes the code from the router's copy when it arrived before the dismiss", async () => {
    dismissThenRouterDelivers("c.early-code", { before: true });

    expect(await requestAppleRevocationGrant(appleUser)).toEqual({
      authorizationCode: "c.early-code",
      clientId: "eu.drafto.web.auth",
    });
  });

  it("ignores a router copy for another state", async () => {
    mockOpenAuthSession.mockImplementation(async () => {
      claimAppleRevocationDelivery(
        buildAppleRevocationDeepLink("android", {
          code: "c.stale-code",
          state: "android.someoneelsesnonce0000",
        }),
      );
      return closedWith("dismiss");
    });

    expect(await requestAppleRevocationGrant(appleUser)).toBeNull();
  });

  it("returns null and logs Apple's error code when Apple refuses", async () => {
    answerWith({ error: "user_cancelled_authorize" });

    expect(await requestAppleRevocationGrant(appleUser)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("[apple-revocation] Apple confirmation failed", {
      error: "user_cancelled_authorize",
    });
  });

  it("returns null, and never logs the code, when the answer is for another state", async () => {
    answerWith({ code: "c.stale-code" }, "android.someoneelsesnonce0000");

    expect(await requestAppleRevocationGrant(appleUser)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[apple-revocation] Apple confirmation answered another request",
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("c.stale-code");
  });

  it("returns null when opening the browser throws", async () => {
    mockOpenAuthSession.mockRejectedValue(new Error("no browser"));

    expect(await requestAppleRevocationGrant(appleUser)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("[apple-revocation] Apple confirmation failed", {
      name: "Error",
    });
  });

  it("never opens the browser for a user who is not linked to Apple", async () => {
    expect(await requestAppleRevocationGrant(emailUser)).toBeNull();
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
  });
});

describe("claimAppleRevocationDelivery", () => {
  it("claims revocation links, with or without a pending confirmation", () => {
    expect(
      claimAppleRevocationDelivery("drafto://auth/apple-revocation?code=c.late&state=android.x"),
    ).toBe(true);
    expect(
      claimAppleRevocationDelivery("/auth/apple-revocation?error=user_cancelled_authorize"),
    ).toBe(true);
  });

  it("leaves every other link to the router", () => {
    expect(claimAppleRevocationDelivery("drafto://auth/callback?code=abc")).toBe(false);
    expect(claimAppleRevocationDelivery("/notes/123")).toBe(false);
  });
});
