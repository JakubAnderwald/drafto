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

jest.mock("@/lib/config", () => ({
  apiUrl: "https://api.drafto.test",
}));

import {
  RECOVERY_REDIRECT_URL,
  completeRecoveryFromUrl,
  createRecoveryLinkHandler,
  isRecoveryUrl,
  parseRecoveryLink,
} from "@/lib/auth-recovery";

// What the drafto.eu hand-off page opens — the URL the app actually receives.
const PKCE_LINK = "eu.drafto.desktop://auth/recovery?code=pkce-123";

describe("RECOVERY_REDIRECT_URL", () => {
  it("lands on the web recovery hand-off page, distinct from the OAuth one", () => {
    expect(RECOVERY_REDIRECT_URL).toBe("https://api.drafto.test/auth/desktop/recovery");
    expect(RECOVERY_REDIRECT_URL).not.toContain("auth/desktop/callback");
  });
});

describe("isRecoveryUrl", () => {
  it("is false for a foreign scheme", () => {
    expect(isRecoveryUrl("https://drafto.eu/reset-password?code=abc")).toBe(false);
  });

  it("is false for the OAuth callback, so its code is not consumed twice", () => {
    expect(isRecoveryUrl("eu.drafto.desktop://auth/callback?code=oauth-code")).toBe(false);
  });

  it("is true for the recovery path", () => {
    expect(isRecoveryUrl(PKCE_LINK)).toBe(true);
  });

  it("is true for any path carrying type=recovery", () => {
    expect(isRecoveryUrl("eu.drafto.desktop://auth/callback#type=recovery&access_token=AAA")).toBe(
      true,
    );
  });

  it("accepts the alternate reset-password path an operator might allowlist", () => {
    expect(isRecoveryUrl("eu.drafto.desktop://reset-password?code=abc")).toBe(true);
  });

  it("ignores scheme casing, per RFC 3986", () => {
    expect(isRecoveryUrl("EU.DRAFTO.DESKTOP://auth/recovery?code=abc")).toBe(true);
  });
});

describe("parseRecoveryLink", () => {
  it("returns null for a URL that is not a recovery callback", () => {
    expect(parseRecoveryLink("eu.drafto.desktop://auth/callback?code=oauth-code")).toBeNull();
    expect(parseRecoveryLink("https://drafto.eu/reset-password")).toBeNull();
  });

  it("extracts the PKCE code from the query string", () => {
    expect(parseRecoveryLink(PKCE_LINK)).toEqual({
      code: "pkce-123",
      errorMessage: null,
    });
  });

  it("does not read session tokens from the URL", () => {
    // Any website can open this scheme, so tokens in it are never credentials.
    expect(
      parseRecoveryLink(
        "eu.drafto.desktop://auth/recovery#access_token=AAA&refresh_token=RRR&type=recovery",
      ),
    ).toEqual({
      code: null,
      errorMessage: null,
    });
  });

  it("decodes the error description Supabase returns for an expired link", () => {
    const link = parseRecoveryLink(
      "eu.drafto.desktop://auth/recovery#error=access_denied&error_code=otp_expired" +
        "&error_description=Email+link+is+invalid+or+has+expired",
    );

    expect(link?.errorMessage).toBe("Email link is invalid or has expired");
  });

  it("survives a malformed percent-escape instead of throwing", () => {
    expect(parseRecoveryLink("eu.drafto.desktop://auth/recovery?code=%zz")).toEqual({
      code: "%zz",
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

    await completeRecoveryFromUrl("eu.drafto.desktop://auth/callback?code=oauth-code", {
      onRecoveryDetected,
    });

    expect(onRecoveryDetected).not.toHaveBeenCalled();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("flags recovery before the code exchange resolves", () => {
    const order: string[] = [];
    mockExchangeCodeForSession.mockImplementation(() => {
      order.push("exchange");
      return Promise.resolve({ data: {}, error: null });
    });

    // Deliberately not awaited: RootNavigator must already be holding the reset
    // screen by the time the exchange starts, or it flashes the main app.
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

  it("treats a token-only link as missing credentials and never sets a session", async () => {
    // Any website can open this scheme; honouring the tokens would sign the app
    // into whatever account the page chose.
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl(
      "eu.drafto.desktop://auth/recovery#access_token=AAA&refresh_token=RRR",
      { onRecoveryError },
    );

    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(onRecoveryError).toHaveBeenCalledWith(
      "This password reset link is missing its credentials. Request a new one.",
    );
  });

  it("uses only the code when tokens ride along with it", async () => {
    await completeRecoveryFromUrl(
      "eu.drafto.desktop://auth/recovery?code=pkce-123#access_token=AAA&refresh_token=RRR",
    );

    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("pkce-123");
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("reports an expired link without calling Supabase", async () => {
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl(
      "eu.drafto.desktop://auth/recovery#error_description=Email+link+is+invalid+or+has+expired",
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

  it("reports a credential-less recovery link rather than hanging", async () => {
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl("eu.drafto.desktop://auth/recovery", { onRecoveryError });

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
});

describe("createRecoveryLinkHandler", () => {
  const linkFor = (code: string) => `eu.drafto.desktop://auth/recovery?code=${code}`;

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
    // The hand-off page opens the app automatically and again from "Open Drafto".
    // Re-exchanging the spent code would replace the reset form with
    // "PKCE code verifier not found".
    const onRecoveryDetected = jest.fn();
    const onRecoveryError = jest.fn();
    mockExchangeCodeForSession
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: {}, error: { message: "PKCE code verifier not found" } });
    const handler = createRecoveryLinkHandler({ onRecoveryDetected, onRecoveryError });

    handler.handle(linkFor("a"));
    await flush();
    handler.handle(linkFor("a"));
    await flush();

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(onRecoveryDetected).toHaveBeenCalledTimes(1);
    expect(onRecoveryError).not.toHaveBeenCalled();
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
