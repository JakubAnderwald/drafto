const mockExchangeCodeForSession = jest.fn();
const mockSetSession = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      exchangeCodeForSession: (...args: unknown[]) => mockExchangeCodeForSession(...args),
      setSession: (...args: unknown[]) => mockSetSession(...args),
    },
  },
}));

import {
  APPLE_SIGN_IN_FAILED_MESSAGE,
  claimAuthCallbackDelivery,
  completeAuthCallback,
  withBrowserSignIn,
} from "@/lib/auth-callback";
import {
  clearAuthCallbackError,
  getAuthCallbackError,
  reportAuthCallbackError,
} from "@/lib/auth-callback-errors";
import { redirectSystemPath } from "../../app/+native-intent";

/** Lets the `.then` that reports a router delivery's outcome run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// The exchange cache lives for the whole module, so every test uses its own code.
let codeCounter = 0;
const freshCode = () => `code-${++codeCounter}`;

beforeEach(() => {
  jest.clearAllMocks();
  mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
  clearAuthCallbackError();
});

describe("completeAuthCallback", () => {
  it.each([
    "drafto://reset-password?code=abc",
    "drafto://auth/callbacks?code=abc",
    "https://drafto.eu/auth/callback?code=abc",
  ])("ignores a link that is not the auth callback: %s", (url) => {
    expect(completeAuthCallback(url)).toBeNull();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("exchanges a code once, however many times it arrives", async () => {
    const code = freshCode();
    const first = completeAuthCallback(`drafto://auth/callback?code=${code}`);
    const second = completeAuthCallback(`drafto://AUTH/callback/?code=${code}`);

    expect(await first).toEqual({ error: null });
    expect(await second).toEqual({ error: null });
    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith(code);
  });

  it("remembers a failed exchange instead of retrying a spent code", async () => {
    const code = freshCode();
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: { message: "flow expired" } });

    expect(await completeAuthCallback(`drafto://auth/callback?code=${code}`)).toEqual({
      error: "flow expired",
    });
    expect(await completeAuthCallback(`drafto://auth/callback?code=${code}`)).toEqual({
      error: "flow expired",
    });
    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it("turns a thrown exchange into the generic failure", async () => {
    mockExchangeCodeForSession.mockRejectedValue(new Error("offline"));

    expect(await completeAuthCallback(`drafto://auth/callback?code=${freshCode()}`)).toEqual({
      error: APPLE_SIGN_IN_FAILED_MESSAGE,
    });
  });

  it("passes the provider's error description through", async () => {
    const outcome = completeAuthCallback(
      "drafto://auth/callback?error=server_error&error_code=unexpected_failure&error_description=Unable%20to%20exchange%20external%20code",
    );

    expect(await outcome).toEqual({ error: "Unable to exchange external code" });
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it.each([
    "drafto://auth/callback?error=user_cancelled_authorize",
    "drafto://auth/callback?error=access_denied",
    "drafto://auth/callback?error=invalid_request&error_code=user_cancelled_authorize",
  ])("treats a cancel on Apple's page as no error: %s", async (url) => {
    expect(await completeAuthCallback(url)).toEqual({ error: null });
  });

  it("never signs in with tokens on the link", async () => {
    const outcome = completeAuthCallback(
      "drafto://auth/callback#access_token=forged&refresh_token=forged",
    );

    expect(await outcome).toEqual({ error: APPLE_SIGN_IN_FAILED_MESSAGE });
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });
});

describe("claimAuthCallbackDelivery (the router's copy)", () => {
  it("signs in from a cold-start delivery and reports nothing on success", async () => {
    const code = freshCode();

    expect(claimAuthCallbackDelivery(`drafto://auth/callback?code=${code}`)).toBe(true);
    await settle();

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith(code);
    expect(getAuthCallbackError()).toBeNull();
  });

  it("exchanges a duplicate delivery once", async () => {
    const url = `drafto://auth/callback?code=${freshCode()}`;
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: { message: "flow expired" } });

    claimAuthCallbackDelivery(url);
    claimAuthCallbackDelivery(url);
    await settle();

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(getAuthCallbackError()).toBe(APPLE_SIGN_IN_FAILED_MESSAGE);
  });

  it("shows the generic message for an error link, never the link's own text", async () => {
    claimAuthCallbackDelivery(
      "drafto://auth/callback?error=server_error&error_description=Call%20this%20number",
    );
    await settle();

    expect(getAuthCallbackError()).toBe(APPLE_SIGN_IN_FAILED_MESSAGE);
  });

  it("stays silent for a cancel", async () => {
    claimAuthCallbackDelivery("drafto://auth/callback?error=user_cancelled_authorize");
    await settle();

    expect(getAuthCallbackError()).toBeNull();
  });

  it("leaves reporting to a browser sign-in that is still waiting", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: { message: "flow expired" } });
    const url = `drafto://auth/callback?code=${freshCode()}`;

    const inSession = await withBrowserSignIn(async () => {
      claimAuthCallbackDelivery(url);
      return completeAuthCallback(url);
    });
    await settle();

    expect(inSession).toEqual({ error: "flow expired" });
    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(getAuthCallbackError()).toBeNull();
  });

  it("reports again once the browser sign-in has given up", async () => {
    await withBrowserSignIn(async () => ({ type: "dismiss" }));

    claimAuthCallbackDelivery("drafto://auth/callback?error=server_error");
    await settle();

    expect(getAuthCallbackError()).toBe(APPLE_SIGN_IN_FAILED_MESSAGE);
  });

  it("clears a held error once a code signs in", async () => {
    reportAuthCallbackError(APPLE_SIGN_IN_FAILED_MESSAGE);

    claimAuthCallbackDelivery(`drafto://auth/callback?code=${freshCode()}`);
    await settle();

    expect(getAuthCallbackError()).toBeNull();
  });

  it("returns false for any other link", () => {
    expect(claimAuthCallbackDelivery("drafto://reset-password?code=abc")).toBe(false);
  });
});

describe("redirectSystemPath", () => {
  it("keeps the router off the auth callback", async () => {
    expect(
      redirectSystemPath({ path: `drafto://auth/callback?code=${freshCode()}`, initial: true }),
    ).toBeNull();
    expect(redirectSystemPath({ path: "drafto://auth/callback", initial: false })).toBeNull();
    await settle();

    expect(mockExchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it("leaves every other link to the router", () => {
    expect(redirectSystemPath({ path: "drafto://reset-password?code=abc", initial: true })).toBe(
      "drafto://reset-password?code=abc",
    );
    expect(redirectSystemPath({ path: "drafto://notes/123", initial: false })).toBe(
      "drafto://notes/123",
    );
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });
});
