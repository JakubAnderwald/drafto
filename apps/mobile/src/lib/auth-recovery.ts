import { parseAppDeepLink } from "@/lib/app-deep-link";
import { supabase } from "@/lib/supabase";

/**
 * Password-recovery deep links for the mobile app.
 *
 * Supabase mails a link to `/auth/v1/verify?...&type=recovery&redirect_to=<app link>`,
 * which 302s to the app's custom scheme.
 *
 * The mobile client sets `flowType: "pkce"` in `src/lib/supabase.ts` (ADR-0045),
 * so a genuine callback carries only a `code`, and only this device holds the
 * `code_verifier` that redeems it. Implicit-flow `access_token`/`refresh_token`
 * params are deliberately ignored. Any website or app can open
 * `drafto://reset-password#access_token=…&refresh_token=…`, and honouring those
 * tokens with `setSession` would sign the app into an attacker's account. A
 * token-only link therefore gets the missing-credentials error.
 *
 * Because PKCE stores the `code_verifier` in this device's SecureStore, a reset
 * requested on this phone can only be completed on this phone. The request
 * screen says so.
 *
 * The redirect target is `drafto://reset-password`, i.e. the Expo Router path of
 * `app/(auth)/reset-password.tsx` (route groups are not part of the URL). A cold
 * start therefore lands on the reset screen natively instead of Expo Router's
 * "Unmatched route" fallback.
 */

/** Redirect target handed to `resetPasswordForEmail`. Must be allowlisted in Supabase Auth. */
export const RECOVERY_REDIRECT_URL = "drafto://reset-password";

/**
 * Paths that identify a recovery callback. `reset-password` is what we ask for;
 * `auth/recovery` is accepted too so an operator who allowlists the more
 * conventional path does not silently break the flow.
 */
const RECOVERY_PATHS = new Set(["reset-password", "auth/recovery"]);

export interface RecoveryLink {
  /** PKCE authorization code, when present. Session tokens in the URL are never read. */
  code: string | null;
  /** Message Supabase returned instead of credentials (expired or already-used link). */
  errorMessage: string | null;
}

export interface RecoveryCallbacks {
  /**
   * Fired synchronously the moment a URL is recognised as a recovery link —
   * before any network call — so the route guard can hold the user on the reset
   * screen instead of flashing the main app while the session is established.
   */
  onRecoveryDetected?: () => void;
  /** Fired when the link cannot be turned into a usable session. */
  onRecoveryError?: (message: string) => void;
}

const MISSING_CREDENTIALS_MESSAGE =
  "This password reset link is missing its credentials. Request a new one.";

const EXCHANGE_FAILED_MESSAGE = "Could not open this password reset link.";

/**
 * Plain-language messages for the code-exchange failures PKCE makes common.
 * supabase-js's own wording for these is aimed at web developers.
 */
const EXCHANGE_ERROR_MESSAGES: Record<string, string> = {
  // The verifier is not on this device: another phone, an iPad, or a reinstall.
  pkce_code_verifier_not_found:
    "Open this link on the device where you asked for the reset, or request a new one.",
  // Supabase times a reset from when it was requested, not from when the email arrived.
  flow_state_expired: "This password reset link has expired. Request a new one.",
  flow_state_not_found:
    "This password reset link has already been used or has expired. Request a new one.",
};

function describeExchangeError(error: { message: string; code?: string }): string {
  return (error.code && EXCHANGE_ERROR_MESSAGES[error.code]) || error.message;
}

/**
 * Returns the recovery credentials carried by `url`, or `null` if it isn't a
 * recovery link. Only the recovery paths count. Supabase sends no `type` param
 * under PKCE, so a `type=recovery` on any other path could only be forged.
 */
export function parseRecoveryLink(url: string): RecoveryLink | null {
  const parts = parseAppDeepLink(url);
  if (!parts || !RECOVERY_PATHS.has(parts.path)) return null;

  const { params } = parts;
  return {
    code: params.get("code") || null,
    errorMessage: params.get("error_description") || params.get("error") || null,
  };
}

/** True when the URL is a password-recovery callback rather than an OAuth one. */
export function isRecoveryUrl(url: string): boolean {
  return parseRecoveryLink(url) !== null;
}

/** The error to report for `link`, or `null` once its session is established. */
async function establishRecoverySession(link: RecoveryLink): Promise<string | null> {
  if (link.errorMessage) return link.errorMessage;
  // No code: session tokens in the URL are not credentials (see the module comment).
  if (!link.code) return MISSING_CREDENTIALS_MESSAGE;

  try {
    const { error } = await supabase.auth.exchangeCodeForSession(link.code);
    return error ? describeExchangeError(error) : null;
  } catch (error) {
    return error instanceof Error ? error.message : EXCHANGE_FAILED_MESSAGE;
  }
}

async function completeRecovery(link: RecoveryLink, callbacks: RecoveryCallbacks): Promise<void> {
  callbacks.onRecoveryDetected?.();
  // Called outside the exchange's try/catch, so a throwing callback is never
  // reported back to itself as a second recovery error.
  const errorMessage = await establishRecoverySession(link);
  if (errorMessage) callbacks.onRecoveryError?.(errorMessage);
}

/**
 * Establishes the recovery session carried by a deep link.
 *
 * No-ops for any URL that is not a recovery callback, so it is safe to run
 * against every incoming link.
 */
export async function completeRecoveryFromUrl(
  url: string,
  callbacks: RecoveryCallbacks = {},
): Promise<void> {
  const link = parseRecoveryLink(url);
  if (link) await completeRecovery(link, callbacks);
}

export interface RecoveryLinkHandler {
  /** Queues a deep link for recovery. Non-recovery links are ignored. */
  handle: (url: string) => void;
  /** Silences every pending and future callback — call on unmount. */
  cancel: () => void;
}

/**
 * Funnels every incoming deep link through one queue so recovery attempts never
 * overlap.
 *
 * Without it, two links (a second email tapped mid-exchange, or the cold-start
 * URL arriving through both `getInitialURL` and the `url` event) race: a late
 * `exchangeCodeForSession` can replace the newer session, and the stale link's
 * error can overwrite the newer link's state. So:
 *
 * - Supabase session changes run strictly one after another.
 * - Only the most recent link may report an error; a superseded link that has
 *   not started yet is skipped outright.
 * - A code this handler has already seen is dropped for the handler's whole
 *   lifetime, whether its attempt is still in flight or long finished. A spent
 *   code would fail a second exchange ("PKCE code verifier not found") and swap
 *   a working reset form for an error.
 */
export function createRecoveryLinkHandler(callbacks: RecoveryCallbacks = {}): RecoveryLinkHandler {
  let queue: Promise<void> = Promise.resolve();
  let latest = 0;
  let cancelled = false;
  const seen = new Set<string>();

  const handle = (url: string) => {
    const link = parseRecoveryLink(url);
    if (cancelled || !link) return;

    // Keyed on the code, so the same link spelled differently is still a repeat.
    const key = link.code ?? url;
    if (seen.has(key)) return;
    seen.add(key);

    const seq = ++latest;
    const isCurrent = () => !cancelled && seq === latest;

    // Flag recovery immediately, not when the link's turn in the queue comes —
    // the route guard must hold the reset screen for the whole wait.
    callbacks.onRecoveryDetected?.();

    queue = queue
      .then(() => {
        if (!isCurrent()) return;
        return completeRecovery(link, {
          onRecoveryError: (message) => {
            if (isCurrent()) callbacks.onRecoveryError?.(message);
          },
        });
      })
      // A throwing callback must not leave the queue rejected, or every later
      // link would be skipped without a word.
      .catch((err: unknown) => {
        console.error("[auth-recovery] Failed to handle a recovery link:", err);
      });
  };

  const cancel = () => {
    cancelled = true;
  };

  return { handle, cancel };
}
