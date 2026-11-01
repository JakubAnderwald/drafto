/**
 * Sign in with Apple revocation for the platforms without Apple's native sheet
 * (web, Android, macOS). Each one asks Apple for a fresh authorization code for
 * the Services ID, sends it with `DELETE /api/account`, and the server redeems
 * and revokes it once the account is gone (App Store Review Guideline 5.1.1(v)).
 *
 * Android and macOS open Apple's authorize page in the browser. Apple POSTs the
 * result (`response_mode=form_post`, so the code never sits in a URL Apple
 * redirects to) to `APPLE_REVOCATION_REDIRECT_URI`, a drafto.eu route that
 * relays it to the app as a deep link. The web uses Apple's JS in popup mode,
 * which posts the result back to the page, so it never reaches the relay.
 */

/** The Services ID that Supabase's Apple OAuth flow and every revocation code here use. */
export const APPLE_SERVICES_ID = "eu.drafto.web.auth";

/** Only origin whose pages Apple will hand a Services ID code to (registered on the Services ID). */
export const APPLE_REVOCATION_ORIGIN = "https://drafto.eu";

/**
 * The return URL registered on the Services ID. Apple binds each code to it, so the
 * server must send it again as `redirect_uri` when it redeems a Services ID code.
 */
export const APPLE_REVOCATION_REDIRECT_URI = `${APPLE_REVOCATION_ORIGIN}/auth/apple/revocation`;

export const APPLE_AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";

/** Host + path of the deep link the relay opens in the app, after the scheme. */
export const APPLE_REVOCATION_DEEP_LINK_PATH = "auth/apple-revocation";

/** Platforms whose confirmation goes through the relay. The web uses the popup instead. */
export type AppleRevocationPlatform = "android" | "macos";

/**
 * The fixed deep link each platform tag returns to. The relay never takes a scheme
 * from its input, so it cannot be turned into an open redirect.
 */
export const APPLE_REVOCATION_RETURN_URLS: Readonly<Record<AppleRevocationPlatform, string>> = {
  android: `drafto://${APPLE_REVOCATION_DEEP_LINK_PATH}`,
  macos: `eu.drafto.desktop://${APPLE_REVOCATION_DEEP_LINK_PATH}`,
};

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const STATE_PATTERN = /^(android|macos)\.([A-Za-z0-9_-]{16,128})$/;
/** Apple's codes are dotted runs of letters, digits, `-` and `_`. Anything else is refused. */
const AUTHORIZATION_CODE_PATTERN = /^[A-Za-z0-9._-]{1,1024}$/;
/** Apple's documented error codes are short snake_case words. */
const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;

/** True for a value shaped like an Apple authorization code. */
export function isAppleAuthorizationCode(value: unknown): value is string {
  return typeof value === "string" && AUTHORIZATION_CODE_PATTERN.test(value);
}

/** True for a value shaped like one of Apple's error codes (`user_cancelled_authorize`, …). */
export function isAppleErrorCode(value: unknown): value is string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value);
}

/** True for a nonce the state may carry: 16–128 URL-safe characters. */
export function isAppleRevocationNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

/**
 * The `state` sent to Apple: the platform tag the relay picks the app's scheme
 * from, and a nonce that ties the answer to the confirmation the app is waiting for.
 */
export function buildAppleRevocationState(
  platform: AppleRevocationPlatform,
  nonce: string,
): string {
  if (!isAppleRevocationNonce(nonce)) {
    throw new Error("Apple revocation nonce must be 16-128 URL-safe characters");
  }
  return `${platform}.${nonce}`;
}

/** Reads a `state` built by `buildAppleRevocationState`, or `null` for anything else. */
export function parseAppleRevocationState(
  value: unknown,
): { platform: AppleRevocationPlatform; nonce: string } | null {
  if (typeof value !== "string") return null;
  const match = STATE_PATTERN.exec(value);
  if (!match) return null;
  return { platform: match[1] as AppleRevocationPlatform, nonce: match[2] as string };
}

/**
 * Apple's authorize URL for a revocation code: the Services ID, the registered
 * return URL, `response_type=code`, `response_mode=form_post`, and no scope, so
 * Apple asks for no name or email.
 */
export function buildAppleRevocationAuthorizeUrl(state: string): string {
  const query = [
    ["client_id", APPLE_SERVICES_ID],
    ["redirect_uri", APPLE_REVOCATION_REDIRECT_URI],
    ["response_type", "code"],
    ["response_mode", "form_post"],
    ["state", state],
  ]
    .map(([name, value]) => `${name}=${encodeURIComponent(value as string)}`)
    .join("&");
  return `${APPLE_AUTHORIZE_URL}?${query}`;
}

/** What the relay forwards to the app: the state, and either Apple's code or its error. */
export type AppleRevocationRelayFields =
  { state: string; code: string } | { state: string; error: string };

/** The deep link the relay opens for a platform tag. Values are URL-encoded. */
export function buildAppleRevocationDeepLink(
  platform: AppleRevocationPlatform,
  fields: AppleRevocationRelayFields,
): string {
  const pairs: [string, string][] =
    "code" in fields
      ? [
          ["code", fields.code],
          ["state", fields.state],
        ]
      : [
          ["error", fields.error],
          ["state", fields.state],
        ];
  const query = pairs.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("&");
  return `${APPLE_REVOCATION_RETURN_URLS[platform]}?${query}`;
}

/**
 * True when `url` is a revocation deep link (`<scheme>://auth/apple-revocation…`)
 * or the router's path for one (`/auth/apple-revocation…`), on any scheme.
 */
export function isAppleRevocationDeepLink(url: string): boolean {
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/+/, "");
  const path = withoutScheme.split(/[?#]/, 1)[0] ?? "";
  return path.replace(/\/+$/, "") === APPLE_REVOCATION_DEEP_LINK_PATH;
}

export type AppleRevocationCallback =
  /** Apple's code for the confirmation the app is waiting for. */
  | { kind: "code"; authorizationCode: string }
  /** Apple's answer for that confirmation carried no usable code (cancelled, refused, malformed). */
  | { kind: "error"; error: string }
  /** Not an answer to that confirmation: another link, or another (stale) confirmation's state. */
  | { kind: "not-ours" };

/**
 * Reads a revocation deep link against the state the app sent to Apple. Parses the
 * query by hand, because React Native's `URLSearchParams` is incomplete.
 */
export function readAppleRevocationCallback(
  url: string,
  expectedState: string,
): AppleRevocationCallback {
  if (!isAppleRevocationDeepLink(url)) return { kind: "not-ours" };
  const params = readQuery(url);
  if (!expectedState || params.get("state") !== expectedState) return { kind: "not-ours" };

  const code = params.get("code");
  if (isAppleAuthorizationCode(code)) return { kind: "code", authorizationCode: code };
  const error = params.get("error");
  return { kind: "error", error: isAppleErrorCode(error) ? error : "invalid_response" };
}

function readQuery(url: string): Map<string, string> {
  const params = new Map<string, string>();
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return params;
  const hashStart = url.indexOf("#", queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const rawName = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? "" : pair.slice(separator + 1);
    try {
      const name = decodeURIComponent(rawName.replace(/\+/g, " "));
      // The first value wins, so a repeated parameter cannot override the real one.
      if (!params.has(name)) params.set(name, decodeURIComponent(rawValue.replace(/\+/g, " ")));
    } catch {
      // A malformed escape: skip the pair, so the link reads as missing that field.
    }
  }
  return params;
}

/** The parts of a Supabase user that say whether Sign in with Apple is linked. */
export interface AppleLinkableUser {
  identities?: ReadonlyArray<{ provider: string }> | null;
  app_metadata?: { providers?: unknown } | null;
}

/** True when the account has a Sign in with Apple identity linked. */
export function hasAppleIdentity(user: AppleLinkableUser | null | undefined): boolean {
  if (!user) return false;
  if (user.identities?.some((identity) => identity.provider === "apple")) return true;
  const providers: unknown = user.app_metadata?.providers;
  return Array.isArray(providers) && providers.includes("apple");
}

/**
 * Where Apple asks the user to confirm: the native sheet (iOS), a pop-up window
 * (web), or Apple's page in the browser (Android, macOS).
 */
export type AppleConfirmationKind = "sheet" | "popup" | "browser";

const NOTICE_LEAD: Record<AppleConfirmationKind, string> = {
  sheet: "You use Sign in with Apple, so Apple will ask you to confirm.",
  popup: "You use Sign in with Apple, so Apple will ask you to confirm in a pop-up window.",
  browser: "You use Sign in with Apple, so Apple will ask you to confirm in your browser.",
};

/** The delete dialog's notice for an Apple-linked user, said before they start. */
export function appleDeletionNotice(kind: AppleConfirmationKind): string {
  return (
    `${NOTICE_LEAD[kind]} This lets Drafto stop using your Apple ID. ` +
    "If you cancel that step, your account is still deleted."
  );
}
