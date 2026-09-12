import { supabase } from "./supabase";

/**
 * Password-recovery deep links for the mobile app.
 *
 * Supabase mails a link to `/auth/v1/verify?...&type=recovery&redirect_to=<app link>`,
 * which 302s to the app's custom scheme. The mobile client leaves `flowType`
 * unset in `src/lib/supabase.ts`, so supabase-js runs the implicit flow and the
 * credentials arrive as fragment tokens rather than a PKCE `code` — but both
 * shapes are accepted here so the parser survives a future flow change.
 *
 * The redirect target is `drafto://reset-password`, i.e. the Expo Router path of
 * `app/(auth)/reset-password.tsx` (route groups are not part of the URL). A cold
 * start therefore lands on the reset screen natively instead of Expo Router's
 * "Unmatched route" fallback.
 *
 * Parsing is deliberately hand-rolled rather than using `URL` /
 * `URLSearchParams`: React Native ships partial implementations of both, and
 * WHATWG parsing treats the first path segment of a custom scheme as the host.
 */

/** Redirect target handed to `resetPasswordForEmail`. Must be allowlisted in Supabase Auth. */
export const RECOVERY_REDIRECT_URL = "drafto://reset-password";

const APP_SCHEME_PREFIX = "drafto://";

/**
 * Paths that identify a recovery callback. `reset-password` is what we ask for;
 * `auth/recovery` is accepted too so an operator who allowlists the more
 * conventional path does not silently break the flow.
 */
const RECOVERY_PATHS = new Set(["reset-password", "auth/recovery"]);

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
   * before any network call — so the route guard can hold the user on the reset
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

/** Splits `drafto://<path>?<query>#<fragment>` without relying on `URL`. */
function splitAppUrl(url: string): { path: string; params: Map<string, string> } | null {
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

  // Query first, fragment second: Supabase puts implicit-flow credentials in the
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
    if (link.accessToken && link.refreshToken) {
      const { error } = await supabase.auth.setSession({
        access_token: link.accessToken,
        refresh_token: link.refreshToken,
      });
      if (error) callbacks.onRecoveryError?.(error.message);
      return;
    }

    if (link.code) {
      const { error } = await supabase.auth.exchangeCodeForSession(link.code);
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
