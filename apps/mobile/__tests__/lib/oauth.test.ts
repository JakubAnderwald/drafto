const mockSignInWithIdToken = jest.fn();
const mockSignInWithOAuth = jest.fn();
const mockExchangeCodeForSession = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      signInWithIdToken: (...args: unknown[]) => mockSignInWithIdToken(...args),
      signInWithOAuth: (...args: unknown[]) => mockSignInWithOAuth(...args),
      exchangeCodeForSession: (...args: unknown[]) => mockExchangeCodeForSession(...args),
    },
  },
}));

import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import type { SignInResponse, User } from "@react-native-google-signin/google-signin";

import { signInWithApple, signInWithGoogle, describeGoogleSignInError } from "@/lib/oauth";

const mockSignIn = jest.mocked(GoogleSignin.signIn);
const mockHasPlayServices = jest.mocked(GoogleSignin.hasPlayServices);
const mockOpenAuthSession = jest.mocked(WebBrowser.openAuthSessionAsync);

/** A full `User` payload — only `idToken` matters to the code under test. */
function googleUser(idToken: string | null): User {
  return {
    idToken,
    serverAuthCode: null,
    scopes: [],
    user: {
      id: "google-user-1",
      name: "Test User",
      email: "test@example.com",
      photo: null,
      familyName: "User",
      givenName: "Test",
    },
  };
}

function successResponse(idToken: string | null): SignInResponse {
  return { type: "success", data: googleUser(idToken) };
}

/** Shape of a native rejection: an `Error` carrying a string `code`. */
function nativeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("signInWithGoogle", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSignIn.mockResolvedValue(successResponse("mock-id-token"));
    mockHasPlayServices.mockResolvedValue(true);
    mockSignInWithIdToken.mockResolvedValue({ data: { user: null, session: null }, error: null });
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("passes the returned id token to Supabase on the happy path", async () => {
    const result = await signInWithGoogle();

    expect(mockSignInWithIdToken).toHaveBeenCalledWith({
      provider: "google",
      token: "mock-id-token",
    });
    expect(result).toEqual({ error: null });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns no error and skips Supabase when the user cancels the sheet", async () => {
    mockSignIn.mockResolvedValue({ type: "cancelled", data: null });

    const result = await signInWithGoogle();

    expect(result).toEqual({ error: null });
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("surfaces the DEVELOPER_ERROR code when the build is not registered with Google", async () => {
    mockSignIn.mockRejectedValue(
      nativeError(
        "10",
        "DEVELOPER_ERROR: Follow troubleshooting instructions at https://react-native-google-signin.github.io/docs/troubleshooting",
      ),
    );

    const result = await signInWithGoogle();

    expect(result.error).toContain("code 10");
    expect(result.error).toContain("not registered");
    expect(result.error).toContain("SHA-1");
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();
  });

  it("logs the native code and message under a greppable prefix", async () => {
    mockSignIn.mockRejectedValue(nativeError("10", "DEVELOPER_ERROR: ..."));

    await signInWithGoogle();

    expect(warnSpy).toHaveBeenCalledWith("[oauth][google] sign-in failed", {
      code: "10",
      message: "DEVELOPER_ERROR: ...",
    });
  });

  it("reports a Play services failure when hasPlayServices rejects", async () => {
    mockHasPlayServices.mockRejectedValue(
      nativeError("PLAY_SERVICES_NOT_AVAILABLE", "Play services not available"),
    );

    const result = await signInWithGoogle();

    expect(result.error).toContain("PLAY_SERVICES_NOT_AVAILABLE");
    expect(result.error).toContain("Google Play services");
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it("surfaces a Supabase AuthError message rather than the generic banner", async () => {
    mockSignInWithIdToken.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Unable to exchange external code" },
    });

    const result = await signInWithGoogle();

    expect(result).toEqual({ error: "Unable to exchange external code" });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps the original wording and appends the code for an unknown failure", async () => {
    mockSignIn.mockRejectedValue(nativeError("12500", "Something went wrong"));

    const result = await signInWithGoogle();

    expect(result).toEqual({ error: "Google Sign-In failed (code 12500). Please try again." });
  });

  it("stays silent when the native layer reports a cancellation or an in-flight request", async () => {
    mockSignIn.mockRejectedValue(nativeError("12501", "Sign in action cancelled"));
    expect(await signInWithGoogle()).toEqual({ error: null });

    mockSignIn.mockRejectedValue(nativeError("ASYNC_OP_IN_PROGRESS", "previous promise pending"));
    expect(await signInWithGoogle()).toEqual({ error: null });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps a distinct message when sign-in succeeds without an id token", async () => {
    mockSignIn.mockResolvedValue(successResponse(null));

    const result = await signInWithGoogle();

    expect(result).toEqual({ error: "Google Sign-In did not return an ID token." });
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();
  });
});

describe("describeGoogleSignInError", () => {
  it("matches DEVELOPER_ERROR on the message when the code is absent", () => {
    expect(describeGoogleSignInError(new Error("DEVELOPER_ERROR: check your config"))).toContain(
      "code 10",
    );
  });

  it("recognises the unconfigured-client rejection by its message", () => {
    const message = describeGoogleSignInError(
      nativeError("RNGoogleSignin", "apiClient is null - call configure() first"),
    );

    expect(message).toContain("code RNGoogleSignin");
    expect(message).toContain("was not configured");
  });

  it("falls back to the generic banner for a rejection with no code", () => {
    expect(describeGoogleSignInError(new Error("network request failed"))).toBe(
      "Google Sign-In failed. Please try again.",
    );
  });
});

describe("signInWithApple on Android (browser flow)", () => {
  const PROVIDER_URL = "https://example.supabase.co/auth/v1/authorize?provider=apple";

  /** What `openAuthSessionAsync` resolves with once the browser lands on `url`. */
  function redirectedTo(url: string): WebBrowser.WebBrowserAuthSessionResult {
    return { type: "success", url };
  }

  /** The session ended without a redirect. The enum is not in the test mock, so use its value. */
  function closedWith(type: "cancel" | "dismiss"): WebBrowser.WebBrowserAuthSessionResult {
    return { type } as WebBrowser.WebBrowserAuthSessionResult;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(Platform, "OS", "android");
    mockSignInWithOAuth.mockResolvedValue({ data: { url: PROVIDER_URL }, error: null });
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("asks Supabase for the Apple URL with the app callback, and opens it in an auth session", async () => {
    mockOpenAuthSession.mockResolvedValue(closedWith("cancel"));

    await signInWithApple();

    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: "apple",
      options: { redirectTo: "drafto://auth/callback", skipBrowserRedirect: true },
    });
    expect(mockOpenAuthSession).toHaveBeenCalledWith(PROVIDER_URL, "drafto://auth/callback");
  });

  it("exchanges the PKCE code from the callback, parsed without relying on URL", async () => {
    mockOpenAuthSession.mockResolvedValue(redirectedTo("drafto://auth/callback?code=apple-code"));

    const result = await signInWithApple();

    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("apple-code");
    expect(result).toEqual({ error: null });
  });

  it("surfaces a failed code exchange", async () => {
    mockOpenAuthSession.mockResolvedValue(redirectedTo("drafto://auth/callback?code=apple-code"));
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: { message: "flow expired" } });

    expect(await signInWithApple()).toEqual({ error: "flow expired" });
  });

  it("surfaces the provider's error instead of treating it as a cancel", async () => {
    mockOpenAuthSession.mockResolvedValue(
      redirectedTo(
        "drafto://auth/callback?error=server_error&error_description=Unable+to+exchange+external+code",
      ),
    );

    const result = await signInWithApple();

    expect(result).toEqual({ error: "Unable to exchange external code" });
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("reports a generic failure when the redirect carries neither a code nor a description", async () => {
    mockOpenAuthSession.mockResolvedValue(
      redirectedTo("drafto://auth/callback#error=server_error"),
    );

    expect(await signInWithApple()).toEqual({ error: "Apple Sign-In failed. Please try again." });
  });

  it.each([
    "drafto://auth/callback?error=user_cancelled_authorize",
    "drafto://auth/callback?error=access_denied&error_description=user+cancelled",
    "drafto://auth/callback?error=invalid_request&error_code=user_cancelled_authorize",
  ])("treats a cancel on Apple's own page as a cancel, not a failure: %s", async (url) => {
    mockOpenAuthSession.mockResolvedValue(redirectedTo(url));

    expect(await signInWithApple()).toEqual({ error: null });
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("does not mistake another error with an access_denied cousin for a cancel", async () => {
    mockOpenAuthSession.mockResolvedValue(
      redirectedTo(
        "drafto://auth/callback?error=access_denied&error_code=bad_oauth_state&error_description=OAuth+state+expired",
      ),
    );

    expect(await signInWithApple()).toEqual({ error: "OAuth state expired" });
  });

  it("never signs in with session tokens on the callback", async () => {
    mockOpenAuthSession.mockResolvedValue(
      redirectedTo("drafto://auth/callback#access_token=AAA&refresh_token=RRR"),
    );

    const result = await signInWithApple();

    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(result.error).toBe("Apple Sign-In failed. Please try again.");
  });

  it("stays silent when the user closes the browser", async () => {
    mockOpenAuthSession.mockResolvedValue(closedWith("dismiss"));

    expect(await signInWithApple()).toEqual({ error: null });
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("reports a Supabase failure to start the flow", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: null },
      error: { message: "provider off" },
    });

    expect(await signInWithApple()).toEqual({ error: "provider off" });
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
  });

  it("turns a thrown error into the generic failure", async () => {
    mockOpenAuthSession.mockRejectedValue(new Error("no browser"));

    expect(await signInWithApple()).toEqual({ error: "Apple Sign-In failed. Please try again." });
  });
});
