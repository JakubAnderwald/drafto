import { Linking } from "react-native";
import {
  APPLE_SERVICES_ID,
  buildAppleRevocationAuthorizeUrl,
  buildAppleRevocationState,
  hasAppleIdentity,
  isAppleRevocationDeepLink,
  readAppleRevocationCallback,
  type AppleLinkableUser,
  type AppleRevocationGrant,
} from "@drafto/shared";

import { generateId } from "@/lib/generate-id";

/**
 * Sign in with Apple revocation on macOS. The app opens Apple's authorize page in
 * the browser; Apple POSTs the code to the drafto.eu relay, whose page opens
 * `eu.drafto.desktop://auth/apple-revocation?code=…&state=…`. That link resolves
 * the confirmation the app is waiting for, and the code travels with
 * `DELETE /api/account`, which revokes it once the account is gone.
 *
 * Never log the code. The nonce in the state only ties a link to the pending
 * confirmation and is not a credential.
 */

/** True when the account has Sign in with Apple linked, so deletion asks Apple first. */
export function needsAppleConfirmation(user: AppleLinkableUser | null | undefined): boolean {
  return hasAppleIdentity(user);
}

export interface AppleConfirmation {
  /** Apple's grant, or `null` when the user skipped, cancelled, or Apple failed. Never rejects. */
  grant: Promise<AppleRevocationGrant | null>;
  /** Stops waiting for Apple: `grant` resolves `null`. */
  skip: () => void;
}

interface PendingConfirmation {
  state: string;
  settle: (grant: AppleRevocationGrant | null) => void;
}

/** The one confirmation the app is waiting for. A link that answers anything else is ignored. */
let pending: PendingConfirmation | null = null;

/**
 * Opens Apple's authorize page for a fresh revocation code. One confirmation is
 * pending at a time: starting another resolves the earlier one with `null`.
 */
export function startAppleConfirmation(): AppleConfirmation {
  pending?.settle(null);

  // A UUID: 36 characters of hex digits and hyphens, a valid nonce.
  const state = buildAppleRevocationState("macos", generateId());
  let resolveGrant: (grant: AppleRevocationGrant | null) => void = () => undefined;
  const grant = new Promise<AppleRevocationGrant | null>((resolve) => {
    resolveGrant = resolve;
  });

  const confirmation: PendingConfirmation = {
    state,
    settle: (value) => {
      if (pending === confirmation) pending = null;
      resolveGrant(value);
    },
  };
  pending = confirmation;

  Linking.openURL(buildAppleRevocationAuthorizeUrl(state)).catch(() => {
    // The browser did not open, so no answer will come. The deletion goes ahead without Apple.
    confirmation.settle(null);
  });

  return { grant, skip: () => confirmation.settle(null) };
}

/**
 * Claims `eu.drafto.desktop://auth/apple-revocation` links, so the OAuth handler
 * never sees an Apple code. Returns `false` for every other link.
 *
 * The relay page sends the link twice (automatically, then from its button), so only
 * the first answer settles the confirmation. A link with no confirmation pending (a
 * cold start, a stale tab) or with another confirmation's state is ignored.
 */
export function handleAppleRevocationLink(url: string): boolean {
  if (!isAppleRevocationDeepLink(url)) return false;
  if (!pending) return true;

  const current = pending;
  const callback = readAppleRevocationCallback(url, current.state);
  if (callback.kind === "code") {
    current.settle({ authorizationCode: callback.authorizationCode, clientId: APPLE_SERVICES_ID });
  } else if (callback.kind === "error") {
    current.settle(null);
  }
  return true;
}
