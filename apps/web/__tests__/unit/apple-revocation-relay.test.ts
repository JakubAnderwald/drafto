/**
 * @vitest-environment node
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPLE_RELAY_CSP,
  APPLE_RELAY_SCRIPT,
  APPLE_RELAY_SCRIPT_HASH,
  appleRevocationDeepLink,
  appleRevocationRelayPageHeaders,
  escapeHtmlAttribute,
  readAppleRevocationRelayForm,
  renderAppleRevocationRelayPage,
} from "@/lib/apple/revocation-relay";

const NONCE = "n0nce_abcdefghijklmnop";
const ANDROID_STATE = `android.${NONCE}`;
const MACOS_STATE = `macos.${NONCE}`;
const CODE = "c1a2b3.0.abcd.EFGH-ij_kl";

const form = (fields: Record<string, string>) => new URLSearchParams(fields);

describe("readAppleRevocationRelayForm", () => {
  it("accepts a code for a platform tag, and forwards only state and code", () => {
    const fd = new FormData();
    fd.set("state", ANDROID_STATE);
    fd.set("code", CODE);
    fd.set("id_token", "header.payload.sig");
    fd.set("user", '{"name":{"firstName":"A"}}');

    expect(readAppleRevocationRelayForm(fd)).toEqual({
      platform: "android",
      fields: { state: ANDROID_STATE, code: CODE },
    });
  });

  it("accepts Apple's error for macOS", () => {
    expect(
      readAppleRevocationRelayForm(form({ state: MACOS_STATE, error: "user_cancelled_authorize" })),
    ).toEqual({
      platform: "macos",
      fields: { state: MACOS_STATE, error: "user_cancelled_authorize" },
    });
  });

  it.each([
    ["no state", { code: CODE }],
    ["an unknown platform tag", { state: `ios.${NONCE}`, code: CODE }],
    ["a short nonce", { state: "android.short", code: CODE }],
    ["a state with a quote", { state: `android.${NONCE}"`, code: CODE }],
    ["a state with markup", { state: `macos.${NONCE}<script>`, code: CODE }],
    ["a code with a quote", { state: MACOS_STATE, code: 'abc"onload="x' }],
    ["a code with markup", { state: MACOS_STATE, code: "<script>alert(1)</script>" }],
    ["a javascript: code", { state: ANDROID_STATE, code: "javascript:alert(1)" }],
    ["an empty code", { state: ANDROID_STATE, code: "" }],
    ["a bad code next to a good error", { state: ANDROID_STATE, code: "a b", error: "x" }],
    ["neither code nor error", { state: ANDROID_STATE }],
    ["an error that is not Apple's", { state: ANDROID_STATE, error: "Bad Error!" }],
    ["an error with markup", { state: MACOS_STATE, error: "<b>" }],
  ])("refuses %s", (_label, fields) => {
    expect(readAppleRevocationRelayForm(form(fields))).toBeNull();
  });

  it("refuses a file in place of a field", () => {
    const fd = new FormData();
    fd.set("state", ANDROID_STATE);
    fd.set("code", new Blob([CODE]), "code.txt");
    expect(readAppleRevocationRelayForm(fd)).toBeNull();
  });
});

describe("appleRevocationDeepLink", () => {
  it("returns to the Android scheme", () => {
    expect(
      appleRevocationDeepLink({
        platform: "android",
        fields: { state: ANDROID_STATE, code: CODE },
      }),
    ).toBe(`drafto://auth/apple-revocation?code=${CODE}&state=${ANDROID_STATE}`);
  });

  it("returns to the macOS scheme", () => {
    expect(
      appleRevocationDeepLink({
        platform: "macos",
        fields: { state: MACOS_STATE, error: "user_cancelled_authorize" },
      }),
    ).toBe(
      `eu.drafto.desktop://auth/apple-revocation?error=user_cancelled_authorize&state=${MACOS_STATE}`,
    );
  });
});

describe("relay page", () => {
  const link = `eu.drafto.desktop://auth/apple-revocation?code=${CODE}&state=${MACOS_STATE}`;

  it("puts the deep link only in the anchor's escaped href", () => {
    const html = renderAppleRevocationRelayPage(link);
    const escaped = escapeHtmlAttribute(link);

    expect(html).toContain(`<a id="return-to-drafto" href="${escaped}">Return to Drafto</a>`);
    expect(escaped).toContain("&amp;state=");
    // The link is nowhere else, and never inside the script.
    expect(html.split(CODE)).toHaveLength(2);
    expect(html).toContain(`<script>${APPLE_RELAY_SCRIPT}</script>`);
    expect(APPLE_RELAY_SCRIPT).not.toContain(CODE);
  });

  it("escapes hostile characters in an attribute", () => {
    expect(escapeHtmlAttribute(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
    const html = renderAppleRevocationRelayPage('x" onclick="alert(1)<script>');
    expect(html).not.toContain('" onclick="');
    expect(html).not.toContain("<script>alert");
  });

  it("keeps a static script whose CSP hash matches", () => {
    const expected = `'sha256-${createHash("sha256").update(APPLE_RELAY_SCRIPT).digest("base64")}'`;
    expect(APPLE_RELAY_SCRIPT_HASH).toBe(expected);
    expect(APPLE_RELAY_CSP).toContain(`script-src ${expected}`);
    expect(renderAppleRevocationRelayPage(link)).toContain(APPLE_RELAY_SCRIPT);
    expect(renderAppleRevocationRelayPage("eu.drafto.desktop://other")).toContain(
      APPLE_RELAY_SCRIPT,
    );
  });

  it("hashes the inline style the CSP allows", () => {
    const style = /<style>([^<]*)<\/style>/.exec(renderAppleRevocationRelayPage(link))?.[1] ?? "";
    const hash = `'sha256-${createHash("sha256").update(style).digest("base64")}'`;
    expect(APPLE_RELAY_CSP).toContain(`style-src ${hash}`);
  });

  it("sends private, uncached, unindexed headers with a locked-down CSP", () => {
    expect(appleRevocationRelayPageHeaders()).toEqual({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": APPLE_RELAY_CSP,
    });
    for (const directive of [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(APPLE_RELAY_CSP).toContain(directive);
    }
    expect(APPLE_RELAY_CSP).not.toContain("unsafe-inline");
  });
});
