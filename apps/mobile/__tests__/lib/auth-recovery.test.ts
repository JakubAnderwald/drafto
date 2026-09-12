const mockSetSession = jest.fn();
const mockExchangeCodeForSession = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      setSession: (...args: unknown[]) => mockSetSession(...args),
      exchangeCodeForSession: (...args: unknown[]) => mockExchangeCodeForSession(...args),
    },
  },
}));

import {
  RECOVERY_REDIRECT_URL,
  completeRecoveryFromUrl,
  isRecoveryUrl,
  parseRecoveryLink,
} from "@/lib/auth-recovery";

const IMPLICIT_LINK = `${RECOVERY_REDIRECT_URL}#access_token=AAA&refresh_token=RRR&expires_in=3600&token_type=bearer&type=recovery`;

describe("RECOVERY_REDIRECT_URL", () => {
  it("points at the Expo Router path of the reset screen so a cold start lands there", () => {
    // `app/(auth)/reset-password.tsx` — route groups are not part of the URL.
    expect(RECOVERY_REDIRECT_URL).toBe("drafto://reset-password");
  });
});

describe("isRecoveryUrl", () => {
  it("is false for a foreign scheme", () => {
    expect(isRecoveryUrl("https://drafto.eu/reset-password#access_token=AAA")).toBe(false);
  });

  it("is false for the OAuth callback the app already handles", () => {
    expect(isRecoveryUrl("drafto://auth/callback?code=oauth-code")).toBe(false);
  });

  it("is true for the recovery path", () => {
    expect(isRecoveryUrl(IMPLICIT_LINK)).toBe(true);
  });

  it("is true for any path carrying type=recovery", () => {
    expect(isRecoveryUrl("drafto://auth/callback#type=recovery&access_token=AAA")).toBe(true);
  });

  it("accepts the alternate auth/recovery path an operator might allowlist", () => {
    expect(isRecoveryUrl("drafto://auth/recovery?code=abc")).toBe(true);
  });

  it("ignores scheme casing, per RFC 3986", () => {
    expect(isRecoveryUrl("DRAFTO://reset-password#access_token=AAA")).toBe(true);
  });
});

describe("parseRecoveryLink", () => {
  it("returns null for a URL that is not a recovery callback", () => {
    expect(parseRecoveryLink("drafto://auth/callback?code=oauth-code")).toBeNull();
    expect(parseRecoveryLink("https://drafto.eu/reset-password")).toBeNull();
  });

  it("extracts implicit-flow tokens from the fragment", () => {
    expect(parseRecoveryLink(IMPLICIT_LINK)).toEqual({
      accessToken: "AAA",
      refreshToken: "RRR",
      code: null,
      errorMessage: null,
    });
  });

  it("extracts a PKCE code from the query string", () => {
    expect(parseRecoveryLink("drafto://reset-password?code=pkce-123")).toEqual({
      accessToken: null,
      refreshToken: null,
      code: "pkce-123",
      errorMessage: null,
    });
  });

  it("decodes the error description Supabase returns for an expired link", () => {
    const link = parseRecoveryLink(
      "drafto://reset-password#error=access_denied&error_code=otp_expired" +
        "&error_description=Email+link+is+invalid+or+has+expired",
    );

    expect(link?.errorMessage).toBe("Email link is invalid or has expired");
    expect(link?.accessToken).toBeNull();
  });

  it("falls back to the bare error code when no description is supplied", () => {
    expect(parseRecoveryLink("drafto://reset-password#error=access_denied")?.errorMessage).toBe(
      "access_denied",
    );
  });

  it("survives a malformed percent-escape instead of throwing", () => {
    expect(parseRecoveryLink("drafto://reset-password#access_token=%zz&refresh_token=RRR")).toEqual(
      {
        accessToken: "%zz",
        refreshToken: "RRR",
        code: null,
        errorMessage: null,
      },
    );
  });

  it("lets fragment credentials win over stale query ones", () => {
    const link = parseRecoveryLink("drafto://reset-password?access_token=QUERY#access_token=HASH");
    expect(link?.accessToken).toBe("HASH");
  });

  it("reports no credentials when the link carries none", () => {
    expect(parseRecoveryLink("drafto://reset-password")).toEqual({
      accessToken: null,
      refreshToken: null,
      code: null,
      errorMessage: null,
    });
  });
});

describe("completeRecoveryFromUrl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetSession.mockResolvedValue({ data: {}, error: null });
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
  });

  it("ignores URLs that are not recovery callbacks", async () => {
    const onRecoveryDetected = jest.fn();

    await completeRecoveryFromUrl("drafto://auth/callback?code=oauth-code", {
      onRecoveryDetected,
    });

    expect(onRecoveryDetected).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("flags recovery before the session round-trip resolves", () => {
    const order: string[] = [];
    mockSetSession.mockImplementation(() => {
      order.push("setSession");
      return Promise.resolve({ data: {}, error: null });
    });

    // Deliberately not awaited: the flag must already be set by the time the
    // first await point is reached, or the route guard flashes the main app.
    void completeRecoveryFromUrl(IMPLICIT_LINK, {
      onRecoveryDetected: () => order.push("detected"),
    });

    expect(order).toEqual(["detected", "setSession"]);
  });

  it("establishes the session from implicit-flow tokens", async () => {
    await completeRecoveryFromUrl(IMPLICIT_LINK);

    expect(mockSetSession).toHaveBeenCalledWith({
      access_token: "AAA",
      refresh_token: "RRR",
    });
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("exchanges a PKCE code when no implicit tokens are present", async () => {
    await completeRecoveryFromUrl("drafto://reset-password?code=pkce-123");

    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("pkce-123");
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("reports an expired link without calling Supabase", async () => {
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl(
      "drafto://reset-password#error_description=Email+link+is+invalid+or+has+expired",
      { onRecoveryError },
    );

    expect(onRecoveryError).toHaveBeenCalledWith("Email link is invalid or has expired");
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("surfaces a Supabase rejection of the tokens", async () => {
    mockSetSession.mockResolvedValue({ data: {}, error: { message: "Invalid refresh token" } });
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl(IMPLICIT_LINK, { onRecoveryError });

    expect(onRecoveryError).toHaveBeenCalledWith("Invalid refresh token");
  });

  it("surfaces a failed code exchange", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: { message: "code expired" } });
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl("drafto://reset-password?code=pkce-123", { onRecoveryError });

    expect(onRecoveryError).toHaveBeenCalledWith("code expired");
  });

  it("reports a credential-less recovery link rather than hanging", async () => {
    const onRecoveryDetected = jest.fn();
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl("drafto://reset-password", {
      onRecoveryDetected,
      onRecoveryError,
    });

    expect(onRecoveryDetected).toHaveBeenCalled();
    expect(onRecoveryError).toHaveBeenCalledWith(
      "This password reset link is missing its credentials. Request a new one.",
    );
  });

  it("converts a thrown transport failure into a recovery error", async () => {
    mockSetSession.mockRejectedValue(new Error("Network request failed"));
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl(IMPLICIT_LINK, { onRecoveryError });

    expect(onRecoveryError).toHaveBeenCalledWith("Network request failed");
  });

  it("does not require any callbacks", async () => {
    await expect(completeRecoveryFromUrl(IMPLICIT_LINK)).resolves.toBeUndefined();
  });
});
