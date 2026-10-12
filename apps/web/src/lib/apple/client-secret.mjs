// @ts-check
// Signs the ES256 `client_secret` JWT that Apple's /auth/token and /auth/revoke
// endpoints require from a Sign in with Apple client.
//
// Plain JavaScript (type-checked through JSDoc) on purpose: it is shared by the
// web API, which revokes Apple tokens when an account is deleted, and by
// `scripts/apple-client-secret.mjs`, which plain `node` runs to rotate the
// secret installed in Supabase. Keep it free of `@/` imports and Next.js APIs.

import crypto from "node:crypto";

/** Apple's documented ceiling for `exp - iat`, in seconds (about 182 days). */
export const MAX_LIFETIME_SECONDS = 15_777_000;

/**
 * The Services ID. Browser sign-in (web, macOS, Apple on Android) goes through
 * Supabase with this client, and it must stay the first Apple Client ID there.
 * The native client, the iOS bundle ID, is `APPLE_NATIVE_CLIENT_ID` in
 * `@drafto/shared`, which the iOS app and the revocation code both read.
 */
export const APPLE_SERVICES_ID = "eu.drafto.web.auth";

/** @param {unknown} value */
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * @param {object} params
 * @param {string} params.privateKey PEM contents of the Sign in with Apple `.p8` key.
 * @param {string} params.keyId The key's ID, sent as the JWT `kid`.
 * @param {string} params.teamId The Apple Developer team ID, sent as `iss`.
 * @param {string} params.clientId The client the secret is for (bundle ID or Services ID), sent as `sub`.
 * @param {number} [params.issuedAt] Unix seconds; defaults to now.
 * @param {number} params.lifetimeSeconds Seconds until `exp`, at most {@link MAX_LIFETIME_SECONDS}.
 * @returns {string} The signed JWT.
 */
export function buildClientSecret({
  privateKey,
  keyId,
  teamId,
  clientId,
  issuedAt = Math.floor(Date.now() / 1000),
  lifetimeSeconds,
}) {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw new Error(`Lifetime must be a positive whole number of seconds, got ${lifetimeSeconds}`);
  }
  if (lifetimeSeconds > MAX_LIFETIME_SECONDS) {
    throw new Error(
      `Apple rejects client secrets that live longer than ${MAX_LIFETIME_SECONDS}s (about 182 days)`,
    );
  }
  const header = base64url({ alg: "ES256", kid: keyId });
  const claims = base64url({
    iss: teamId,
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
    aud: "https://appleid.apple.com",
    sub: clientId,
  });
  const unsigned = `${header}.${claims}`;
  // JWS wants the raw r||s signature, not Node's default DER encoding.
  const signature = crypto
    .sign("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${unsigned}.${signature}`;
}
