import {
  APPLE_REVOCATION_REDIRECT_URI,
  APPLE_SERVICES_ID,
  isAppleAuthorizationCode,
  type AppleRevocationGrant,
} from "@drafto/shared";
import type { AppleIdAuth } from "@/lib/apple/apple-js";

/** A fresh random `state` for one confirmation: 32 random bytes, base64url without padding. */
export function createAppleRevocationState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Asks Apple, in a popup, for a fresh authorization code for the Services ID, so the
 * server can revoke Drafto's Apple tokens after it deletes the account.
 *
 * Call it straight from the click handler. `init()` and `signIn()` run before the
 * first `await`, so the browser treats the popup as user-initiated and lets it open.
 *
 * Resolves `null` when there is nothing to send: the script is not loaded, the user
 * closed the popup, Apple answered for another `state`, the code is malformed, or
 * anything threw. The deletion goes ahead without revocation then. The code is never
 * logged or reported.
 */
export async function requestAppleRevocationGrant(
  api: AppleIdAuth | null,
): Promise<AppleRevocationGrant | null> {
  if (!api) return null;
  try {
    const state = createAppleRevocationState();
    api.init({
      clientId: APPLE_SERVICES_ID,
      redirectURI: APPLE_REVOCATION_REDIRECT_URI,
      state,
      usePopup: true,
    });
    const response: unknown = await api.signIn();
    const authorization =
      typeof response === "object" && response !== null
        ? (response as { authorization?: { code?: unknown; state?: unknown } }).authorization
        : undefined;
    if (!authorization || authorization.state !== state) return null;
    if (!isAppleAuthorizationCode(authorization.code)) return null;
    return { authorizationCode: authorization.code, clientId: APPLE_SERVICES_ID };
  } catch {
    // Closing the popup rejects with `{ error: "popup_closed_by_user" }`, which is the
    // user's choice, not a fault. Anything else also falls back to deleting without
    // revocation; the server reports nothing because no grant is sent.
    return null;
  }
}
