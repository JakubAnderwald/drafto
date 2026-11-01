import { describe, expect, it, vi } from "vitest";
import { APPLE_REVOCATION_REDIRECT_URI, APPLE_SERVICES_ID } from "@drafto/shared";
import type {
  AppleIdAuth,
  AppleIdAuthInitOptions,
  AppleIdSignInResponse,
} from "@/lib/apple/apple-js";
import {
  createAppleRevocationState,
  requestAppleRevocationGrant,
} from "@/lib/apple/request-apple-revocation-grant";

const CODE = "c1a2b3.0.abcd.EfGh-IjKl_MnOp";

/** A fake `AppleID.auth` whose `signIn` answers with what `respond` returns for the init options. */
function fakeApi(respond: (options: AppleIdAuthInitOptions) => Promise<AppleIdSignInResponse>) {
  let options: AppleIdAuthInitOptions | null = null;
  const init = vi.fn((next: AppleIdAuthInitOptions) => {
    options = next;
  });
  const signIn = vi.fn(() => {
    if (!options) throw new Error("signIn before init");
    return respond(options);
  });
  const api: AppleIdAuth = { init, signIn };
  return { api, init, signIn };
}

describe("createAppleRevocationState", () => {
  it("returns a fresh base64url value every time", () => {
    const first = createAppleRevocationState();
    const second = createAppleRevocationState();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });
});

describe("requestAppleRevocationGrant", () => {
  it("returns the Services ID grant when Apple answers for our state", async () => {
    const { api, init } = fakeApi((options) =>
      Promise.resolve({ authorization: { code: CODE, state: options.state } }),
    );

    await expect(requestAppleRevocationGrant(api)).resolves.toEqual({
      authorizationCode: CODE,
      clientId: APPLE_SERVICES_ID,
    });
    expect(init).toHaveBeenCalledWith({
      clientId: APPLE_SERVICES_ID,
      redirectURI: APPLE_REVOCATION_REDIRECT_URI,
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      usePopup: true,
    });
    // No scope: Apple must not ask for a name or email.
    expect(init.mock.calls[0]?.[0]).not.toHaveProperty("scope");
  });

  it("calls init and signIn synchronously, so the popup counts as user-initiated", () => {
    const { api, init, signIn } = fakeApi(() => new Promise(() => {}));

    void requestAppleRevocationGrant(api);

    expect(init).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("returns null when the script is not loaded", async () => {
    await expect(requestAppleRevocationGrant(null)).resolves.toBeNull();
  });

  it("returns null when Apple answers for another state", async () => {
    const { api } = fakeApi(() =>
      Promise.resolve({ authorization: { code: CODE, state: "someone-elses-state" } }),
    );
    await expect(requestAppleRevocationGrant(api)).resolves.toBeNull();
  });

  it("returns null when Apple's answer has no state", async () => {
    const { api } = fakeApi(() => Promise.resolve({ authorization: { code: CODE } }));
    await expect(requestAppleRevocationGrant(api)).resolves.toBeNull();
  });

  it("returns null when the popup is closed", async () => {
    const { api } = fakeApi(() => Promise.reject({ error: "popup_closed_by_user" }));
    await expect(requestAppleRevocationGrant(api)).resolves.toBeNull();
  });

  it.each([
    ["an empty code", ""],
    ["a code with markup", "<script>"],
    ["a non-string code", 42],
  ])("returns null for %s", async (_name, code) => {
    const { api } = fakeApi((options) =>
      Promise.resolve({
        authorization: { code, state: options.state },
      } as unknown as AppleIdSignInResponse),
    );
    await expect(requestAppleRevocationGrant(api)).resolves.toBeNull();
  });

  it("returns null for a malformed response", async () => {
    const { api } = fakeApi(() => Promise.resolve(null as unknown as AppleIdSignInResponse));
    await expect(requestAppleRevocationGrant(api)).resolves.toBeNull();
  });

  it("returns null when init throws", async () => {
    const api: AppleIdAuth = {
      init: vi.fn(() => {
        throw new Error("bad config");
      }),
      signIn: vi.fn(),
    };
    await expect(requestAppleRevocationGrant(api)).resolves.toBeNull();
    expect(api.signIn).not.toHaveBeenCalled();
  });

  it("never logs the code", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { api } = fakeApi((options) =>
      Promise.resolve({ authorization: { code: CODE, state: options.state } }),
    );

    await requestAppleRevocationGrant(api);

    for (const spy of [log, warn, error]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CODE);
      spy.mockRestore();
    }
  });
});
