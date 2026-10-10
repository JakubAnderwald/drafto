import { Linking } from "react-native";

const mockExchangeCodeForSession = jest.fn();
const mockSetSession = jest.fn();
const mockSignInWithOAuth = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      exchangeCodeForSession: (...args: unknown[]) => mockExchangeCodeForSession(...args),
      setSession: (...args: unknown[]) => mockSetSession(...args),
      signInWithOAuth: (...args: unknown[]) => mockSignInWithOAuth(...args),
    },
  },
}));

jest.mock("@/lib/config", () => ({
  apiUrl: "https://api.drafto.test",
}));

import {
  OAUTH_REDIRECT_URL,
  handleOAuthCallback,
  signInWithOAuthBrowser,
} from "../../src/lib/oauth";

describe("signInWithOAuthBrowser", () => {
  let openURL: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: "https://supabase.test/auth/v1/authorize?provider=google" },
      error: null,
    });
  });

  afterEach(() => {
    openURL.mockRestore();
  });

  it("returns through the web hand-off page, not straight to the app scheme", () => {
    // A redirect straight to eu.drafto.desktop:// leaves the browser tab frozen.
    expect(OAUTH_REDIRECT_URL).toBe("https://api.drafto.test/auth/desktop/callback");
  });

  it("asks Supabase for the provider URL with the hand-off redirect and opens it", async () => {
    const result = await signInWithOAuthBrowser("google");

    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: "https://api.drafto.test/auth/desktop/callback",
        skipBrowserRedirect: true,
      },
    });
    expect(openURL).toHaveBeenCalledWith("https://supabase.test/auth/v1/authorize?provider=google");
    expect(result).toEqual({ error: null });
  });

  it("passes the provider through for Apple", async () => {
    await signInWithOAuthBrowser("apple");

    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "apple" }),
    );
  });

  it("surfaces the Supabase error and opens nothing", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: null },
      error: { message: "Provider is not enabled" },
    });

    const result = await signInWithOAuthBrowser("google");

    expect(result).toEqual({ error: "Provider is not enabled" });
    expect(openURL).not.toHaveBeenCalled();
  });

  it("reports a generic error when Supabase returns no URL", async () => {
    mockSignInWithOAuth.mockResolvedValue({ data: { url: null }, error: null });

    const result = await signInWithOAuthBrowser("google");

    expect(result).toEqual({ error: "Failed to start sign-in." });
    expect(openURL).not.toHaveBeenCalled();
  });

  it("reports a retryable error when the browser cannot be opened", async () => {
    openURL.mockRejectedValue(new Error("no handler"));

    const result = await signInWithOAuthBrowser("google");

    expect(result).toEqual({ error: "Failed to open sign-in. Please try again." });
  });
});

describe("handleOAuthCallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
    mockSetSession.mockResolvedValue({ data: {}, error: null });
  });

  // `handleOAuthCallback` remembers exchanged codes for the life of the module,
  // so every test uses its own code unless it is testing that memory.

  it("ignores URLs that are not the desktop callback scheme", () => {
    handleOAuthCallback("https://drafto.eu/auth/callback?code=abc");
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("exchanges the PKCE code when present in the query string", () => {
    handleOAuthCallback("eu.drafto.desktop://auth/callback?code=pkce-code-123");
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("pkce-code-123");
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("exchanges a code only once, so the hand-off page's button cannot re-send it", () => {
    // The page opens the app automatically and again from "Open Drafto": same link.
    handleOAuthCallback("eu.drafto.desktop://auth/callback?code=sent-twice");
    handleOAuthCallback("eu.drafto.desktop://auth/callback?code=sent-twice");

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("sent-twice");
  });

  it("still exchanges a different code later", () => {
    handleOAuthCallback("eu.drafto.desktop://auth/callback?code=first-sign-in");
    handleOAuthCallback("eu.drafto.desktop://auth/callback?code=second-sign-in");

    expect(mockExchangeCodeForSession.mock.calls).toEqual([["first-sign-in"], ["second-sign-in"]]);
  });

  describe("after a failed exchange", () => {
    /** Lets the exchange promise's continuations run. */
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    let errorSpy: jest.SpyInstance;
    beforeEach(() => {
      errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      errorSpy.mockRestore();
    });

    it("lets the same link retry when the request never reached the server", async () => {
      // supabase-js keeps the verifier on a network failure, so a retry can still succeed.
      mockExchangeCodeForSession.mockResolvedValueOnce({
        data: {},
        error: { name: "AuthRetryableFetchError", message: "Failed to fetch" },
      });

      handleOAuthCallback("eu.drafto.desktop://auth/callback?code=went-offline");
      await flush();
      handleOAuthCallback("eu.drafto.desktop://auth/callback?code=went-offline");

      expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(2);
    });

    it("does not retry a code the server rejected", async () => {
      mockExchangeCodeForSession.mockResolvedValueOnce({
        data: {},
        error: { name: "AuthApiError", message: "invalid flow state" },
      });

      handleOAuthCallback("eu.drafto.desktop://auth/callback?code=rejected");
      await flush();
      handleOAuthCallback("eu.drafto.desktop://auth/callback?code=rejected");

      expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "[oauth] Failed to exchange code for session:",
        "invalid flow state",
      );
    });

    it("lets the same link retry after an unexpected rejection", async () => {
      mockExchangeCodeForSession.mockRejectedValueOnce(new Error("boom"));

      handleOAuthCallback("eu.drafto.desktop://auth/callback?code=threw");
      await flush();
      handleOAuthCallback("eu.drafto.desktop://auth/callback?code=threw");

      expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    "eu.drafto.desktop://auth/callback#access_token=AAA&refresh_token=RRR",
    "eu.drafto.desktop://auth/callback?access_token=AAA&refresh_token=RRR",
  ])("never sets a session from tokens in the URL (%s)", (url) => {
    // Any website can open this scheme; honouring the tokens would sign the app
    // into whatever account the page chose.
    handleOAuthCallback(url);

    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("uses only the code when tokens ride along with it", () => {
    handleOAuthCallback(
      "eu.drafto.desktop://auth/callback?code=with-tokens#access_token=AAA&refresh_token=RRR",
    );

    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("with-tokens");
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("does nothing when no recognized auth params are present", () => {
    handleOAuthCallback("eu.drafto.desktop://auth/callback");
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("leaves a password-recovery callback for the recovery handler", () => {
    // Both handlers listen on the same scheme. If this one also exchanged the
    // code, the single-use code would be burned and the user would land in the
    // app signed in rather than on the reset screen.
    handleOAuthCallback("eu.drafto.desktop://auth/recovery?code=recovery-code");

    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("ignores tokens in a type=recovery link on the OAuth path", () => {
    handleOAuthCallback(
      "eu.drafto.desktop://auth/callback#access_token=AAA&refresh_token=RRR&type=recovery",
    );

    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("decides by path, so a type=recovery param cannot steal an OAuth code", () => {
    // Supabase sends no `type` under PKCE; only the recovery paths belong to the
    // recovery handler.
    handleOAuthCallback("eu.drafto.desktop://auth/callback?code=oauth-with-type&type=recovery");

    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("oauth-with-type");
  });
});
