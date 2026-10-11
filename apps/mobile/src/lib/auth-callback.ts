/**
 * The `drafto://auth/callback` redirect that ends Apple sign-in on Android.
 *
 * While the app is running, the redirect reaches it twice: `openAuthSessionAsync`
 * resolves with it, and Expo Router hears the same `Linking` event
 * (`app/+native-intent.tsx`). The router's copy is the only one when the session
 * is gone: Android killed the app while the user was on Apple's page, or the
 * session resolved as "dismiss" because the app came to the foreground before the
 * redirect arrived. Both copies go through `completeAuthCallback`, which
 * exchanges each code once.
 */

import { parseAppDeepLink } from "@/lib/app-deep-link";
import { clearAuthCallbackError, reportAuthCallbackError } from "@/lib/auth-callback-errors";
import { supabase } from "@/lib/supabase";

/** Where Supabase sends the browser back to after Apple sign-in on Android. */
export const AUTH_CALLBACK_URL = "drafto://auth/callback";

const AUTH_CALLBACK_PATH = "auth/callback";

export const APPLE_SIGN_IN_FAILED_MESSAGE = "Apple Sign-In failed. Please try again.";

/**
 * Errors that mean the user backed out on Apple's own page. Apple reports
 * `user_cancelled_authorize`, and Supabase may pass it on as `access_denied`.
 */
const APPLE_CANCEL_ERRORS = new Set(["user_cancelled_authorize", "access_denied"]);

export interface AuthCallbackResult {
  error: string | null;
}

/**
 * Every code this process has exchanged, with its outcome. auth-js deletes the
 * PKCE verifier after the first attempt, so a second exchange of the same code
 * could only fail, and its error would replace a sign-in that worked.
 */
const exchanges = new Map<string, Promise<AuthCallbackResult>>();

/** In-app browser sign-ins still waiting for their redirect. */
let openBrowserSessions = 0;

async function exchangeCode(code: string): Promise<AuthCallbackResult> {
  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      clearAuthCallbackError();
    }
    return { error: error ? error.message : null };
  } catch {
    return { error: APPLE_SIGN_IN_FAILED_MESSAGE };
  }
}

/**
 * Signs in from an auth callback URL, or returns `null` when `url` is not one.
 *
 * Only a PKCE `code` counts. Tokens in the URL are never read: any website or
 * app can open the scheme, and a code is useless without this device's verifier.
 */
export function completeAuthCallback(url: string): Promise<AuthCallbackResult> | null {
  // Parsed by hand: React Native's `URL` is unreliable with a custom scheme.
  const link = parseAppDeepLink(url);
  if (link?.path !== AUTH_CALLBACK_PATH) {
    return null;
  }

  const code = link.params.get("code");
  if (code) {
    let outcome = exchanges.get(code);
    if (!outcome) {
      outcome = exchangeCode(code);
      exchanges.set(code, outcome);
    }
    return outcome;
  }

  // No code: Supabase or Apple sent an error back.
  const providerError = link.params.get("error_code") || link.params.get("error") || "";
  if (APPLE_CANCEL_ERRORS.has(providerError)) {
    return Promise.resolve({ error: null });
  }
  return Promise.resolve({
    error: link.params.get("error_description") || APPLE_SIGN_IN_FAILED_MESSAGE,
  });
}

/**
 * Runs an in-app browser sign-in whose caller reports the callback's outcome
 * itself, so a router delivery during it stays quiet instead of showing the
 * same error twice.
 */
export async function withBrowserSignIn<T>(run: () => Promise<T>): Promise<T> {
  openBrowserSessions += 1;
  try {
    return await run();
  } finally {
    openBrowserSessions -= 1;
  }
}

/**
 * Handles an auth callback that reached the app through the router. Returns
 * `false` for any other URL. A failure goes to the login screen only when no
 * browser sign-in is waiting to report it.
 *
 * That failure is always the generic message, never the link's
 * `error_description`: with no sign-in in progress, the link may have come from
 * any website or app, and its text must not appear in Drafto's UI.
 */
export function claimAuthCallbackDelivery(url: string): boolean {
  const outcome = completeAuthCallback(url);
  if (!outcome) {
    return false;
  }
  if (openBrowserSessions === 0) {
    void outcome.then(({ error }) => {
      if (error) {
        reportAuthCallbackError(APPLE_SIGN_IN_FAILED_MESSAGE);
      }
    });
  }
  return true;
}
