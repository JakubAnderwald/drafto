const mockSignInWithIdToken = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      signInWithIdToken: (...args: unknown[]) => mockSignInWithIdToken(...args),
    },
  },
}));

import { GoogleSignin } from "@react-native-google-signin/google-signin";
import type { SignInResponse, User } from "@react-native-google-signin/google-signin";

import { signInWithGoogle, describeGoogleSignInError } from "@/lib/oauth";

const mockSignIn = jest.mocked(GoogleSignin.signIn);
const mockHasPlayServices = jest.mocked(GoogleSignin.hasPlayServices);

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
