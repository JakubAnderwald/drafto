import { createHash } from "node:crypto";
import {
  buildAppleRevocationDeepLink,
  isAppleAuthorizationCode,
  isAppleErrorCode,
  parseAppleRevocationState,
  type AppleRevocationPlatform,
  type AppleRevocationRelayFields,
} from "@drafto/shared";

/**
 * The pure half of `/auth/apple/revocation`, the return URL registered on the
 * Services ID. Android and macOS open Apple's authorize page in the browser for
 * a revocation code; Apple POSTs the answer here (`response_mode=form_post`) and
 * this relays it to the app as a deep link. Nothing here logs or reports a field
 * value: the code is a credential until the server redeems it.
 */

/** Any form-like source of Apple's fields: `FormData` or `URLSearchParams`. */
export interface AppleRelayFormSource {
  get(name: string): unknown;
}

/** A validated answer from Apple, and the platform whose app it goes back to. */
export interface AppleRevocationRelay {
  platform: AppleRevocationPlatform;
  fields: AppleRevocationRelayFields;
}

/**
 * Reads Apple's form post. Returns `null` unless `state` is one the apps build
 * and the post carries a well-formed `code` or, without one, a well-formed
 * `error`. Only those fields are forwarded; `id_token` and `user` are dropped.
 */
export function readAppleRevocationRelayForm(
  form: AppleRelayFormSource,
): AppleRevocationRelay | null {
  const state = form.get("state");
  const parsed = parseAppleRevocationState(state);
  if (!parsed || typeof state !== "string") return null;

  const code = form.get("code");
  if (code !== null && code !== undefined) {
    return isAppleAuthorizationCode(code)
      ? { platform: parsed.platform, fields: { state, code } }
      : null;
  }

  const error = form.get("error");
  return isAppleErrorCode(error) ? { platform: parsed.platform, fields: { state, error } } : null;
}

/** The deep link that hands Apple's answer to the app. The scheme comes from the platform tag only. */
export function appleRevocationDeepLink(relay: AppleRevocationRelay): string {
  return buildAppleRevocationDeepLink(relay.platform, relay.fields);
}

/** The id of the anchor whose `href` the static script follows. */
const RETURN_LINK_ID = "return-to-drafto";

/**
 * Static on purpose: it interpolates nothing, so its CSP hash never changes and
 * no input can reach script context. It follows the anchor's `href` once.
 */
export const APPLE_RELAY_SCRIPT = `(function(){var a=document.getElementById("${RETURN_LINK_ID}");var h=a&&a.getAttribute("href");if(h){window.location.href=h;}})();`;

const APPLE_RELAY_STYLE =
  "body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}" +
  "a{display:inline-block;margin-top:16px;padding:10px 20px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600}";

function cspHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

/** The CSP source for `APPLE_RELAY_SCRIPT`, e.g. `'sha256-…'`. */
export const APPLE_RELAY_SCRIPT_HASH = cspHash(APPLE_RELAY_SCRIPT);

/** The CSP source for the page's inline style. */
export const APPLE_RELAY_STYLE_HASH = cspHash(APPLE_RELAY_STYLE);

/** Escapes a value for a double-quoted HTML attribute. */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The macOS relay page. The deep link appears only HTML-attribute-escaped in the
 * anchor's `href`; the static script opens it, and the link is the fallback when
 * the browser asks before opening the app.
 */
export function renderAppleRevocationRelayPage(deepLink: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    "<title>Return to Drafto</title>",
    `<style>${APPLE_RELAY_STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<h1>Return to Drafto</h1>",
    "<p>Drafto is opening to finish deleting your account. If it does not open, use the button.</p>",
    `<a id="${RETURN_LINK_ID}" href="${escapeHtmlAttribute(deepLink)}">Return to Drafto</a>`,
    "</main>",
    `<script>${APPLE_RELAY_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/** The Content-Security-Policy for the relay page: nothing but its own script and style. */
export const APPLE_RELAY_CSP = [
  "default-src 'none'",
  `script-src ${APPLE_RELAY_SCRIPT_HASH}`,
  `style-src ${APPLE_RELAY_STYLE_HASH}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Headers every relay response carries, so the code is never cached or sent on as a referrer. */
export const APPLE_RELAY_PRIVATE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

/** Headers for the macOS relay page. */
export function appleRevocationRelayPageHeaders(): Record<string, string> {
  return {
    ...APPLE_RELAY_PRIVATE_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": APPLE_RELAY_CSP,
  };
}
