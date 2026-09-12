import { supabase } from "@/lib/supabase";

/**
 * Password-recovery deep links for the macOS app.
 *
 * Supabase mails a link to `/auth/v1/verify?...&type=recovery&redirect_to=<app link>`,
 * which 302s to the app's registered `eu.drafto.desktop` scheme. The desktop
 * client sets `flowType: "pkce"` in `src/lib/supabase.ts`, so the callback
 * normally carries a `code` — the implicit fragment shape is accepted too so the
 * parser survives a future flow change.
 *
 * Because PKCE stores the `code_verifier` in this install's AsyncStorage, a
 * reset requested on the Mac can only be completed on the Mac. The request
 * screen says so rather than leaving a user to discover it.
 *
 * Recovery callbacks share a scheme with the OAuth ones handled in `oauth.ts`;
 * they are told apart by path (see `RECOVERY_PATHS`) so neither handler consumes
 * the other's code.
 *
 * Parsing is hand-rolled rather than using `URL`: WHATWG parsing treats the
 * first path segment of a custom scheme as the host, and the Hermes URL shim
 * patched in `src/lib/url-polyfill.ts` only papers over part of that.
 */

/** Redirect target handed to `resetPasswordForEmail`. Must be allowlisted in Supabase Auth. */
export const RECOVERY_REDIRECT_URL = "eu.drafto.desktop://auth/recovery";

const APP_SCHEME_PREFIX = "eu.drafto.desktop://";

/**
 * Paths that identify a recovery callback, as opposed to the `auth/callback`
 * path OAuth sign-in uses. `reset-password` is accepted as well so an operator
 * who allowlists the mobile-style path does not silently break the flow.
 */
const RECOVERY_PATHS = new Set(["auth/recovery", "reset-password"]);

export interface RecoveryLink {
  /** Implicit-flow access token, when present. */
  accessToken: string | null;
  /** Implicit-flow refresh token, when present. */
  refreshToken: string | null;
  /** PKCE authorization code, when present. */
  code: string | null;
  /** Message Supabase returned instead of credentials (expired or already-used link). */
  errorMessage: string | null;
}

export interface RecoveryCallbacks {
  /**
   * Fired synchronously the moment a URL is recognised as a recovery link —
   * before any network call — so `RootNavigator` can hold the user on the reset
   * screen instead of flashing the main app while the session is established.
   */
  onRecoveryDetected?: () => void;
  /** Fired when the link cannot be turned into a usable session. */
  onRecoveryError?: (message: string) => void;
}

const MISSING_CREDENTIALS_MESSAGE =
  "This password reset link is missing its credentials. Request a new one.";

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // A malformed escape sequence must not take down the whole callback.
    return value;
  }
}

function parseParams(raw: string, into: Map<string, string>): Map<string, string> {
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const key = separator === -1 ? pair : pair.slice(0, separator);
    const value = separator === -1 ? "" : pair.slice(separator + 1);
    into.set(decodeComponent(key), decodeComponent(value));
  }
  return into;
}

/** Splits `eu.drafto.desktop://<path>?<query>#<fragment>` without relying on `URL`. */
function splitAppUrl(url: string): { path: string; params: Map<string, string> } | null {
  // URL schemes are case-insensitive per RFC 3986 — normalize before match.
  if (!url.toLowerCase().startsWith(APP_SCHEME_PREFIX)) {
    return null;
  }

  const rest = url.slice(APP_SCHEME_PREFIX.length);
  const hashAt = rest.indexOf("#");
  const beforeHash = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : rest.slice(hashAt + 1);

  const queryAt = beforeHash.indexOf("?");
  const rawPath = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);

  // Query first, fragment second: implicit-flow credentials live in the
  // fragment, so it wins any collision.
  const params = parseParams(query, new Map<string, string>());
  parseParams(fragment, params);

  return { path: rawPath.replace(/^\/+|\/+$/g, "").toLowerCase(), params };
}

/** True when the URL is a password-recovery callback rather than an OAuth one. */
export function isRecoveryUrl(url: string): boolean {
  const parts = splitAppUrl(url);
  if (!parts) return false;
  return RECOVERY_PATHS.has(parts.path) || parts.params.get("type") === "recovery";
}

/** Returns the recovery credentials carried by `url`, or `null` if it isn't a recovery link. */
export function parseRecoveryLink(url: string): RecoveryLink | null {
  const parts = splitAppUrl(url);
  if (!parts) return null;

  const { path, params } = parts;
  if (!RECOVERY_PATHS.has(path) && params.get("type") !== "recovery") {
    return null;
  }

  return {
    accessToken: params.get("access_token") ?? null,
    refreshToken: params.get("refresh_token") ?? null,
    code: params.get("code") ?? null,
    errorMessage: params.get("error_description") ?? params.get("error") ?? null,
  };
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
  if (!link) return;

  callbacks.onRecoveryDetected?.();

  if (link.errorMessage) {
    callbacks.onRecoveryError?.(link.errorMessage);
    return;
  }

  try {
    if (link.code) {
      const { error } = await supabase.auth.exchangeCodeForSession(link.code);
      if (error) callbacks.onRecoveryError?.(error.message);
      return;
    }

    if (link.accessToken && link.refreshToken) {
      const { error } = await supabase.auth.setSession({
        access_token: link.accessToken,
        refresh_token: link.refreshToken,
      });
      if (error) callbacks.onRecoveryError?.(error.message);
      return;
    }

    callbacks.onRecoveryError?.(MISSING_CREDENTIALS_MESSAGE);
  } catch (error) {
    callbacks.onRecoveryError?.(
      error instanceof Error ? error.message : "Could not open this password reset link.",
    );
  }
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
 * `setSession` / `exchangeCodeForSession` can replace the newer session, and
 * the stale link's error can overwrite the newer link's state. So:
 *
 * - Supabase session changes run strictly one after another.
 * - Only the most recent link may report an error; a superseded link that has
 *   not started yet is skipped outright.
 * - A link identical to one still in flight is dropped — its one-time
 *   credentials would fail a second exchange and mask a recovery that worked.
 */
export function createRecoveryLinkHandler(callbacks: RecoveryCallbacks = {}): RecoveryLinkHandler {
  let queue: Promise<void> = Promise.resolve();
  let latest = 0;
  let cancelled = false;
  const inFlight = new Set<string>();

  const handle = (url: string) => {
    if (cancelled || inFlight.has(url) || !isRecoveryUrl(url)) return;

    const seq = ++latest;
    const isCurrent = () => !cancelled && seq === latest;
    inFlight.add(url);

    // Flag recovery immediately, not when the link's turn in the queue comes —
    // the route guard must hold the reset screen for the whole wait.
    callbacks.onRecoveryDetected?.();

    queue = queue
      .then(() => {
        if (!isCurrent()) return;
        return completeRecoveryFromUrl(url, {
          onRecoveryError: (message) => {
            if (isCurrent()) callbacks.onRecoveryError?.(message);
          },
        });
      })
      .finally(() => {
        inFlight.delete(url);
      });
  };

  const cancel = () => {
    cancelled = true;
  };

  return { handle, cancel };
}
