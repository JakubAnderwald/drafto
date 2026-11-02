import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import { getRandomValues } from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import {
  APPLE_NATIVE_CLIENT_ID,
  APPLE_REVOCATION_RETURN_URLS,
  APPLE_SERVICES_ID,
  buildAppleRevocationAuthorizeUrl,
  buildAppleRevocationState,
  hasAppleIdentity,
  isAppleRevocationDeepLink,
  readAppleRevocationCallback,
  type AppleLinkableUser,
  type AppleRevocationGrant,
} from "@drafto/shared";

export { hasAppleIdentity };

type AppleLinkable = AppleLinkableUser | null | undefined;

/** Where this device asks the user to confirm with Apple. iOS and Android only. */
export type MobileAppleConfirmationKind = "sheet" | "browser";

/** Random bytes in the revocation nonce: 32 hex characters, inside the 16–128 the state allows. */
const NONCE_BYTES = 16;

/**
 * How deleting this account asks the user to confirm with Apple, or `null` when it does not.
 *
 * iOS uses the native sheet, which returns a code for the app's bundle ID. Android has no
 * sheet, so it opens Apple's page in the browser for a Services ID code, which drafto.eu
 * relays back to the app as `drafto://auth/apple-revocation`.
 */
export function appleConfirmationKind(user: AppleLinkable): MobileAppleConfirmationKind | null {
  if (!hasAppleIdentity(user)) return null;
  if (Platform.OS === "ios") return "sheet";
  if (Platform.OS === "android") return "browser";
  return null;
}

/** Whether deleting this account first asks the user to confirm with Apple. */
export function needsAppleConfirmation(user: AppleLinkable): boolean {
  return appleConfirmationKind(user) !== null;
}

/**
 * True for the relay's deep link (`drafto://auth/apple-revocation…`) or the router's path
 * for it. It is not a screen: the browser session that asked for it reads it.
 */
export function isAppleRevocationPath(path: string): boolean {
  return isAppleRevocationDeepLink(path);
}

/**
 * Asks Apple for a fresh authorization code that the server redeems and revokes once the
 * account is deleted (App Store Review Guideline 5.1.1(v)). Supabase keeps no Apple token,
 * so this is the only way to get one.
 *
 * Returns `null`, so the deletion goes ahead without revocation, when the user is not
 * linked to Apple, cancels, or Apple fails. Revocation is best-effort and must never stop
 * a deletion. The code is never logged.
 */
export async function requestAppleRevocationGrant(
  user: AppleLinkable,
): Promise<AppleRevocationGrant | null> {
  const kind = appleConfirmationKind(user);
  if (kind === "sheet") return requestNativeGrant();
  if (kind === "browser") return requestBrowserGrant();
  return null;
}

async function requestNativeGrant(): Promise<AppleRevocationGrant | null> {
  try {
    // No name or email: only the authorization code is needed.
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    if (!credential.authorizationCode) {
      console.warn("[apple-revocation] Apple returned no authorization code");
      return null;
    }
    // The sheet issues codes to the app's bundle ID, which the server knows by the same constant.
    return { authorizationCode: credential.authorizationCode, clientId: APPLE_NATIVE_CLIENT_ID };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== "ERR_REQUEST_CANCELED") {
      console.warn("[apple-revocation] Apple confirmation failed", { code });
    }
    return null;
  }
}

/**
 * The browser confirmation waiting for Apple's answer. The relay's link reaches the app twice:
 * once through the browser session, and once through the router (`+native-intent.tsx`).
 * On Android the session can resolve as "dismiss" because the app came to the foreground
 * before the link arrived (as `auth-callback.ts` sees for sign-in), so the router's copy can
 * still settle it.
 */
let pendingBrowserConfirmation: { state: string; deliver: (code: string) => void } | null = null;

/** After a "dismiss", how long to wait for the router's copy of the relay's link. */
export const ROUTER_DELIVERY_GRACE_MS = 1_500;

/**
 * Called by the router for every incoming link. Returns true for a revocation link, which
 * is never a screen, and hands its code to the pending confirmation when the state matches.
 * A link for another state, or with no confirmation pending (a late link after the app
 * restarted), is dropped; the user starts the deletion again.
 */
export function claimAppleRevocationDelivery(path: string): boolean {
  if (!isAppleRevocationDeepLink(path)) return false;
  const pending = pendingBrowserConfirmation;
  if (pending) {
    const callback = readAppleRevocationCallback(path, pending.state);
    if (callback.kind === "code") pending.deliver(callback.authorizationCode);
  }
  return true;
}

async function requestBrowserGrant(): Promise<AppleRevocationGrant | null> {
  // An object, so the narrowing of a plain `let` cannot hide the closure's writes.
  const router: { code: string | null; wake: (() => void) | null } = { code: null, wake: null };
  let state: string | null = null;
  try {
    state = buildAppleRevocationState("android", randomNonce());
    pendingBrowserConfirmation = {
      state,
      deliver: (code) => {
        router.code ??= code;
        router.wake?.();
      },
    };
    const result = await WebBrowser.openAuthSessionAsync(
      buildAppleRevocationAuthorizeUrl(state),
      APPLE_REVOCATION_RETURN_URLS.android,
    );

    if (result.type === "success") {
      const callback = readAppleRevocationCallback(result.url, state);
      if (callback.kind === "code") return servicesIdGrant(callback.authorizationCode);
      if (router.code !== null) return servicesIdGrant(router.code);
      if (callback.kind === "error") {
        console.warn("[apple-revocation] Apple confirmation failed", { error: callback.error });
      } else {
        console.warn("[apple-revocation] Apple confirmation answered another request");
      }
      return null;
    }

    // "dismiss" may only mean the app came back before the relay's link did: give the
    // router's copy a moment. "cancel" / a dismiss with no link: the user closed Apple's page.
    if (result.type === "dismiss" && router.code === null) {
      await new Promise<void>((resolve) => {
        router.wake = resolve;
        setTimeout(resolve, ROUTER_DELIVERY_GRACE_MS);
      });
    }
    return router.code === null ? null : servicesIdGrant(router.code);
  } catch (err) {
    console.warn("[apple-revocation] Apple confirmation failed", {
      name: err instanceof Error ? err.name : typeof err,
    });
    return null;
  } finally {
    if (pendingBrowserConfirmation?.state === state) pendingBrowserConfirmation = null;
  }
}

/** The relay's codes are issued to the Services ID, which the server redeems them for. */
function servicesIdGrant(authorizationCode: string): AppleRevocationGrant {
  return { authorizationCode, clientId: APPLE_SERVICES_ID };
}

/** A URL-safe nonce from the OS CSPRNG (expo-crypto, as `crypto-random.ts` uses). */
function randomNonce(): string {
  const bytes = getRandomValues(new Uint8Array(NONCE_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
