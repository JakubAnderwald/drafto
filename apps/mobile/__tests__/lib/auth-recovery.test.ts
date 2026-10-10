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
  createRecoveryLinkHandler,
  isRecoveryUrl,
  parseRecoveryLink,
} from "@/lib/auth-recovery";

const PKCE_LINK = `${RECOVERY_REDIRECT_URL}?code=pkce-123`;

/** The implicit-flow shape: real session tokens in the fragment. Anyone can forge it. */
const TOKEN_LINK = `${RECOVERY_REDIRECT_URL}#access_token=AAA&refresh_token=RRR&expires_in=3600&token_type=bearer&type=recovery`;

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
    expect(isRecoveryUrl(PKCE_LINK)).toBe(true);
  });

  it("ignores type=recovery on any other path, since Supabase sends no type under PKCE", () => {
    // Only a forged link could carry it, e.g. to force a signed-in user onto the reset screen.
    expect(isRecoveryUrl("drafto://auth/callback#type=recovery&access_token=AAA")).toBe(false);
    expect(isRecoveryUrl("drafto://notes/123?type=recovery")).toBe(false);
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

  it("extracts a PKCE code from the query string", () => {
    expect(parseRecoveryLink(PKCE_LINK)).toEqual({ code: "pkce-123", errorMessage: null });
  });

  it("never reads session tokens, so a forged token link carries no credentials", () => {
    expect(parseRecoveryLink(TOKEN_LINK)).toEqual({ code: null, errorMessage: null });
  });

  it("decodes the error description Supabase returns for an expired link", () => {
    const link = parseRecoveryLink(
      "drafto://reset-password#error=access_denied&error_code=otp_expired" +
        "&error_description=Email+link+is+invalid+or+has+expired",
    );

    expect(link?.errorMessage).toBe("Email link is invalid or has expired");
    expect(link?.code).toBeNull();
  });

  it("falls back to the bare error code when the description is empty", () => {
    expect(
      parseRecoveryLink("drafto://reset-password?error=access_denied&error_description=")
        ?.errorMessage,
    ).toBe("access_denied");
  });

  it("treats an empty code as no code", () => {
    expect(parseRecoveryLink("drafto://reset-password?code=")).toEqual({
      code: null,
      errorMessage: null,
    });
  });

  it("falls back to the bare error code when no description is supplied", () => {
    expect(parseRecoveryLink("drafto://reset-password#error=access_denied")?.errorMessage).toBe(
      "access_denied",
    );
  });

  it("survives a malformed percent-escape instead of throwing", () => {
    expect(parseRecoveryLink("drafto://reset-password?code=%zz")).toEqual({
      code: "%zz",
      errorMessage: null,
    });
  });

  it("reports no credentials when the link carries none", () => {
    expect(parseRecoveryLink("drafto://reset-password")).toEqual({
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
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("flags recovery before the session round-trip resolves", () => {
    const order: string[] = [];
    mockExchangeCodeForSession.mockImplementation(() => {
      order.push("exchange");
      return Promise.resolve({ data: {}, error: null });
    });

    // Deliberately not awaited: the flag must already be set by the time the
    // first await point is reached, or the route guard flashes the main app.
    void completeRecoveryFromUrl(PKCE_LINK, {
      onRecoveryDetected: () => order.push("detected"),
    });

    expect(order).toEqual(["detected", "exchange"]);
  });

  it("exchanges the PKCE code", async () => {
    await completeRecoveryFromUrl(PKCE_LINK);

    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("pkce-123");
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it.each([TOKEN_LINK, `${RECOVERY_REDIRECT_URL}?access_token=AAA&refresh_token=RRR`])(
    "never signs in with session tokens taken from the URL: %s",
    async (url) => {
      // Any website or app can open this link; honouring it would sign the app
      // into whoever owns the tokens.
      const onRecoveryError = jest.fn();

      await completeRecoveryFromUrl(url, { onRecoveryError });

      expect(mockSetSession).not.toHaveBeenCalled();
      expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
      expect(onRecoveryError).toHaveBeenCalledWith(
        "This password reset link is missing its credentials. Request a new one.",
      );
    },
  );

  it("uses only the code when tokens ride along with it", async () => {
    await completeRecoveryFromUrl(`${PKCE_LINK}#access_token=AAA&refresh_token=RRR`);

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
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("surfaces a failed code exchange", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: { message: "code expired" } });
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl(PKCE_LINK, { onRecoveryError });

    expect(onRecoveryError).toHaveBeenCalledWith("code expired");
  });

  it.each([
    [
      "pkce_code_verifier_not_found",
      "Open this link on the device where you asked for the reset, or request a new one.",
    ],
    ["flow_state_expired", "This password reset link has expired. Request a new one."],
    [
      "flow_state_not_found",
      "This password reset link has already been used or has expired. Request a new one.",
    ],
  ])("explains the %s exchange failure in plain words", async (code, message) => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: {},
      error: { code, message: "PKCE code verifier not found in storage. For SSR frameworks…" },
    });
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl(PKCE_LINK, { onRecoveryError });

    expect(onRecoveryError).toHaveBeenCalledWith(message);
  });

  it("does not report a throwing callback's own error back to it", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: { message: "code expired" } });
    const onRecoveryError = jest.fn(() => {
      throw new Error("screen already unmounted");
    });

    await expect(completeRecoveryFromUrl(PKCE_LINK, { onRecoveryError })).rejects.toThrow(
      "screen already unmounted",
    );

    expect(onRecoveryError).toHaveBeenCalledTimes(1);
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
    mockExchangeCodeForSession.mockRejectedValue(new Error("Network request failed"));
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl(PKCE_LINK, { onRecoveryError });

    expect(onRecoveryError).toHaveBeenCalledWith("Network request failed");
  });

  it("does not require any callbacks", async () => {
    await expect(completeRecoveryFromUrl(PKCE_LINK)).resolves.toBeUndefined();
  });
});

describe("createRecoveryLinkHandler", () => {
  const linkFor = (code: string) => `${RECOVERY_REDIRECT_URL}?code=${code}`;

  /** Lets queued promise continuations run. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function deferredExchange() {
    let resolve!: (value: { data: object; error: { message: string } | null }) => void;
    const promise = new Promise<{ data: object; error: { message: string } | null }>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
  });

  it("ignores links that are not recovery callbacks", async () => {
    const onRecoveryDetected = jest.fn();
    const handler = createRecoveryLinkHandler({ onRecoveryDetected });

    handler.handle("https://drafto.eu/somewhere?code=abc");
    await flush();

    expect(onRecoveryDetected).not.toHaveBeenCalled();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("flags recovery synchronously, before the link's turn in the queue", () => {
    const onRecoveryDetected = jest.fn();
    const handler = createRecoveryLinkHandler({ onRecoveryDetected });

    handler.handle(linkFor("a"));

    expect(onRecoveryDetected).toHaveBeenCalledTimes(1);
  });

  it("runs session changes one at a time, so a late exchange cannot replace a newer session", async () => {
    const first = deferredExchange();
    mockExchangeCodeForSession.mockReturnValueOnce(first.promise);
    const handler = createRecoveryLinkHandler();

    handler.handle(linkFor("a"));
    await flush();
    handler.handle(linkFor("b"));
    await flush();

    expect(mockExchangeCodeForSession.mock.calls).toEqual([["a"]]);

    first.resolve({ data: {}, error: null });
    await flush();

    expect(mockExchangeCodeForSession.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("skips a superseded link that has not started yet", async () => {
    // "a" is already exchanging when "b" and "c" arrive; "b" is overtaken while it waits.
    const first = deferredExchange();
    mockExchangeCodeForSession.mockReturnValueOnce(first.promise);
    const handler = createRecoveryLinkHandler();

    handler.handle(linkFor("a"));
    await flush();
    handler.handle(linkFor("b"));
    handler.handle(linkFor("c"));
    first.resolve({ data: {}, error: null });
    await flush();

    expect(mockExchangeCodeForSession.mock.calls).toEqual([["a"], ["c"]]);
  });

  it("drops the error of a link a newer one has superseded", async () => {
    const first = deferredExchange();
    mockExchangeCodeForSession.mockReturnValueOnce(first.promise);
    const onRecoveryError = jest.fn();
    const handler = createRecoveryLinkHandler({ onRecoveryError });

    handler.handle(linkFor("a"));
    await flush();
    handler.handle(linkFor("b"));
    first.resolve({ data: {}, error: { message: "stale link expired" } });
    await flush();

    expect(onRecoveryError).not.toHaveBeenCalled();
  });

  it("still reports an error from the most recent link", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: { message: "code expired" } });
    const onRecoveryError = jest.fn();
    const handler = createRecoveryLinkHandler({ onRecoveryError });

    handler.handle(linkFor("a"));
    await flush();

    expect(onRecoveryError).toHaveBeenCalledWith("code expired");
  });

  it("ignores a duplicate of a link still in flight, so a consumed code cannot mask success", async () => {
    const first = deferredExchange();
    mockExchangeCodeForSession.mockReturnValueOnce(first.promise);
    const onRecoveryDetected = jest.fn();
    const onRecoveryError = jest.fn();
    const handler = createRecoveryLinkHandler({ onRecoveryDetected, onRecoveryError });

    handler.handle(linkFor("a"));
    handler.handle(linkFor("a"));
    first.resolve({ data: {}, error: null });
    await flush();

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(onRecoveryDetected).toHaveBeenCalledTimes(1);
    expect(onRecoveryError).not.toHaveBeenCalled();
  });

  it("drops a repeat even after the first attempt has settled", async () => {
    // A spent code would fail a second exchange and swap a working reset form for an error.
    const onRecoveryDetected = jest.fn();
    const onRecoveryError = jest.fn();
    const handler = createRecoveryLinkHandler({ onRecoveryDetected, onRecoveryError });

    handler.handle(linkFor("a"));
    await flush();
    handler.handle(linkFor("a"));
    await flush();

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(onRecoveryDetected).toHaveBeenCalledTimes(1);
    expect(onRecoveryError).not.toHaveBeenCalled();
  });

  it("treats the same code spelled differently as a repeat", async () => {
    const handler = createRecoveryLinkHandler();

    handler.handle("drafto://reset-password?code=spent");
    await flush();
    handler.handle("DRAFTO:///reset-password/?code=spent");
    await flush();

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it("still handles a different link after a finished one", async () => {
    const handler = createRecoveryLinkHandler();

    handler.handle(linkFor("a"));
    await flush();
    handler.handle(linkFor("b"));
    await flush();

    expect(mockExchangeCodeForSession.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("keeps handling links after a callback throws", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockExchangeCodeForSession.mockResolvedValueOnce({ data: {}, error: { message: "expired" } });
    const onRecoveryError = jest.fn(() => {
      throw new Error("screen already unmounted");
    });
    const handler = createRecoveryLinkHandler({ onRecoveryError });

    handler.handle(linkFor("a"));
    await flush();
    handler.handle(linkFor("b"));
    await flush();

    expect(mockExchangeCodeForSession.mock.calls).toEqual([["a"], ["b"]]);
    // Reported once: the throw is logged, not fed back to the callback as a second error.
    expect(onRecoveryError.mock.calls).toEqual([["expired"]]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[auth-recovery] Failed to handle a recovery link:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("fires nothing once cancelled", async () => {
    const first = deferredExchange();
    mockExchangeCodeForSession.mockReturnValueOnce(first.promise);
    const onRecoveryDetected = jest.fn();
    const onRecoveryError = jest.fn();
    const handler = createRecoveryLinkHandler({ onRecoveryDetected, onRecoveryError });

    handler.handle(linkFor("a"));
    await flush();
    handler.cancel();
    first.resolve({ data: {}, error: { message: "code expired" } });
    handler.handle(linkFor("b"));
    await flush();

    expect(onRecoveryDetected).toHaveBeenCalledTimes(1);
    expect(onRecoveryError).not.toHaveBeenCalled();
    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
  });
});
