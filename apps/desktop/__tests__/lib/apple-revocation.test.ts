import { Linking } from "react-native";
import {
  APPLE_SERVICES_ID,
  buildAppleRevocationDeepLink,
  parseAppleRevocationState,
} from "@drafto/shared";

import {
  handleAppleRevocationLink,
  needsAppleConfirmation,
  startAppleConfirmation,
} from "@/lib/apple-revocation";

/** The `state` the last opened authorize URL carried. */
function lastState(openURL: jest.SpyInstance): string {
  const url = openURL.mock.calls[openURL.mock.calls.length - 1]?.[0] as string;
  const match = /[?&]state=([^&]+)/.exec(url);
  if (!match?.[1]) throw new Error("authorize URL carried no state");
  return decodeURIComponent(match[1]);
}

function codeLink(state: string, code = "c1.apple-code_x"): string {
  return buildAppleRevocationDeepLink("macos", { state, code });
}

/** Lets a promise that already settled run its callbacks. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("needsAppleConfirmation", () => {
  it("is true only for an Apple-linked user", () => {
    expect(needsAppleConfirmation({ identities: [{ provider: "apple" }] })).toBe(true);
    expect(needsAppleConfirmation({ app_metadata: { providers: ["email", "apple"] } })).toBe(true);
    expect(needsAppleConfirmation({ identities: [{ provider: "google" }] })).toBe(false);
    expect(needsAppleConfirmation(null)).toBe(false);
  });
});

describe("Apple confirmation on macOS", () => {
  let openURL: jest.SpyInstance;
  let active: { skip: () => void } | null = null;

  beforeEach(() => {
    openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  });

  afterEach(() => {
    // Leave no confirmation pending for the next test.
    active?.skip();
    active = null;
    openURL.mockRestore();
  });

  function start() {
    const confirmation = startAppleConfirmation();
    active = confirmation;
    return confirmation;
  }

  it("opens Apple's authorize page for the Services ID with a macOS state", () => {
    start();

    expect(openURL).toHaveBeenCalledTimes(1);
    const url = openURL.mock.calls[0]?.[0] as string;
    expect(url.startsWith("https://appleid.apple.com/auth/authorize?")).toBe(true);
    expect(url).toContain(`client_id=${APPLE_SERVICES_ID}`);
    expect(url).toContain("response_mode=form_post");
    expect(url).not.toContain("scope=");
    expect(parseAppleRevocationState(lastState(openURL))?.platform).toBe("macos");
  });

  it("resolves the grant from the relay's link, once", async () => {
    const { grant } = start();
    const state = lastState(openURL);

    expect(handleAppleRevocationLink(codeLink(state))).toBe(true);
    // The relay page sends the link a second time from its button.
    expect(handleAppleRevocationLink(codeLink(state, "second.code"))).toBe(true);

    await expect(grant).resolves.toEqual({
      authorizationCode: "c1.apple-code_x",
      clientId: APPLE_SERVICES_ID,
    });
  });

  it("resolves null when Apple answers with an error", async () => {
    const { grant } = start();
    const state = lastState(openURL);

    const link = buildAppleRevocationDeepLink("macos", {
      state,
      error: "user_cancelled_authorize",
    });
    expect(handleAppleRevocationLink(link)).toBe(true);

    await expect(grant).resolves.toBeNull();
  });

  it("resolves null when the user skips", async () => {
    const { grant, skip } = start();

    skip();

    await expect(grant).resolves.toBeNull();
    // A late link after the skip is still claimed, and changes nothing.
    expect(handleAppleRevocationLink(codeLink(lastState(openURL)))).toBe(true);
  });

  it("resolves null when the browser cannot be opened", async () => {
    openURL.mockRejectedValue(new Error("no handler"));

    const { grant } = start();

    await expect(grant).resolves.toBeNull();
  });

  it("resolves an earlier confirmation with null when a new one starts", async () => {
    const first = start();
    const firstState = lastState(openURL);
    const second = start();
    const secondState = lastState(openURL);

    await expect(first.grant).resolves.toBeNull();
    expect(secondState).not.toBe(firstState);

    // The superseded confirmation's link does not answer the new one.
    expect(handleAppleRevocationLink(codeLink(firstState, "stale.code"))).toBe(true);
    let settled = false;
    void second.grant.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    handleAppleRevocationLink(codeLink(secondState, "fresh.code"));
    await expect(second.grant).resolves.toEqual({
      authorizationCode: "fresh.code",
      clientId: APPLE_SERVICES_ID,
    });
  });

  it("ignores a link with another state while one is pending", async () => {
    const { grant } = start();

    expect(handleAppleRevocationLink(codeLink("macos.someone-elses-nonce-123456"))).toBe(true);

    let settled = false;
    void grant.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
  });

  it("claims a cold-start revocation link with nothing pending and ignores it", () => {
    expect(handleAppleRevocationLink(codeLink("macos.cold-start-nonce-1234567"))).toBe(true);
    expect(openURL).not.toHaveBeenCalled();
  });

  it.each([
    "eu.drafto.desktop://auth/callback?code=oauth-code",
    "eu.drafto.desktop://auth/recovery?code=recovery-code",
    "https://drafto.eu/auth/apple/revocation",
  ])("does not claim %s", (url) => {
    expect(handleAppleRevocationLink(url)).toBe(false);
  });
});
