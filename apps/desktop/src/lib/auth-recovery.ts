import { apiUrl } from "@/lib/config";
import { supabase } from "@/lib/supabase";

/**
 * Password-recovery deep links for the macOS app.
 *
 * Supabase mails a link to `/auth/v1/verify?...&type=recovery&redirect_to=<hand-off page>`,
 * which 302s to `https://drafto.eu/auth/desktop/recovery`. That page forwards the
 * result to the app's registered scheme as `eu.drafto.desktop://auth/recovery`
 * (ADR-0044) — redirecting straight to the scheme left the browser tab blank and
 * loading, and did nothing at all on a device without the app.
 *
 * The desktop client sets `flowType: "pkce"` in `src/lib/supabase.ts`, so a
 * genuine callback carries only a `code`, and only this install holds the
 * `code_verifier` that redeems it. Implicit-flow `access_token`/`refresh_token`
 * params are deliberately ignored. Any website can open
 * `eu.drafto.desktop://auth/recovery#access_token=…&refresh_token=…`, and honouring
 * those tokens with `setSession` would sign the app into an attacker's account. A
 * token-only link therefore gets the missing-credentials error.
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

/**
 * Redirect target handed to `resetPasswordForEmail`: the drafto.eu hand-off page,
 * which opens `eu.drafto.desktop://auth/recovery`. Must be allowlisted in Supabase Auth.
 */
export const RECOVERY_REDIRECT_URL = `${apiUrl}/auth/desktop/recovery`;

const APP_SCHEME_PREFIX = "eu.drafto.desktop://";

/**
 * Paths that identify a recovery callback, as opposed to the `auth/callback`
 * path OAuth sign-in uses. `reset-password` is accepted as well so an operator
 * who allowlists the mobile-style path does not silently break the flow.
 */
const RECOVERY_PATHS = new Set(["auth/recovery", "reset-password"]);

export interface RecoveryLink {
  /** PKCE authorization code, when present. Session tokens in the URL are never read. */
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

  // Query first, fragment second: Supabase can put an expired-link error in the
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

    // No code: session tokens in the URL are not credentials (see the module comment).
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
 * `exchangeCodeForSession` can replace the newer session, and the stale link's
 * error can overwrite the newer link's state. So:
 *
 * - Supabase session changes run strictly one after another.
 * - Only the most recent link may report an error; a superseded link that has
 *   not started yet is skipped outright.
 * - A link this handler has already seen is dropped for the handler's whole
 *   lifetime, whether its attempt is still in flight or long finished. Its
 *   one-time code would fail a second exchange ("PKCE code verifier not found")
 *   and swap a working reset form for an error. The repeat is routine: the
 *   drafto.eu hand-off page opens the app automatically and also offers an
 *   "Open Drafto" button carrying the same link.
 */
export function createRecoveryLinkHandler(callbacks: RecoveryCallbacks = {}): RecoveryLinkHandler {
  let queue: Promise<void> = Promise.resolve();
  let latest = 0;
  let cancelled = false;
  const seen = new Set<string>();

  const handle = (url: string) => {
    if (cancelled || seen.has(url) || !isRecoveryUrl(url)) return;

    const seq = ++latest;
    const isCurrent = () => !cancelled && seq === latest;
    seen.add(url);

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
