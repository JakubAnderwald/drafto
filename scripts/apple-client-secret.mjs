#!/usr/bin/env node
// Generates the "Secret Key" that Supabase Auth's Apple provider needs.
//
// Apple has no static OAuth client secret. The secret is an ES256 JWT signed
// with a Sign in with Apple key (.p8), and Apple refuses any that lives longer
// than 6 months. When it lapses, every browser-based Apple sign-in (web, macOS,
// Apple on Android) fails with "Unable to exchange external code", and the
// Supabase auth log shows `oauth2: "invalid_client"`. Native iOS sign-in sends
// an ID token instead and keeps working, which hides the outage.
// Rotation steps: docs/features/auth.md → "client secret that expires".
//
// Usage:
//   node scripts/apple-client-secret.mjs --out <file>
//     [--key ~/drafto-secrets/AuthKey_7BS35Y82Q6.p8] [--key-id 7BS35Y82Q6]
//     [--team-id 4J2USPSG2U] [--client-id eu.drafto.web.auth] [--days 180]
//
// The secret goes to --out (mode 0600) and is never printed. There is no
// offline way to test it: Apple's token endpoint rejects a dummy code before
// it authenticates the client, so it answers `invalid_grant` even for a
// garbage secret. Only a real Apple sign-in proves the secret works.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "./lib/is-main.mjs";
import { parseFlags } from "./lib/parse-flags.mjs";

// Apple's documented ceiling for exp - iat.
export const MAX_LIFETIME_SECONDS = 15_777_000;

const DEFAULTS = {
  key: path.join(os.homedir(), "drafto-secrets", "AuthKey_7BS35Y82Q6.p8"),
  "key-id": "7BS35Y82Q6",
  "team-id": "4J2USPSG2U",
  // The Services ID, which must stay the FIRST Apple Client ID in Supabase:
  // the browser flows send that entry as Apple's client_id.
  "client-id": "eu.drafto.web.auth",
  days: "180",
};

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

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

export async function writeSecret(outPath, secret) {
  // "wx" refuses to overwrite: an existing file may hold the secret that is
  // still live, and it may have been created with looser permissions.
  await fs.writeFile(outPath, secret, { mode: 0o600, flag: "wx" });
}

async function main(argv) {
  const { flags } = parseFlags(argv);
  const opts = { ...DEFAULTS, ...flags };
  if (!flags.out) {
    throw new Error("--out <file> is required; the secret is never printed");
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const lifetimeSeconds = Math.round(Number(opts.days) * 24 * 3600);
  const secret = buildClientSecret({
    privateKey: await fs.readFile(opts.key, "utf8"),
    keyId: opts["key-id"],
    teamId: opts["team-id"],
    clientId: opts["client-id"],
    issuedAt,
    lifetimeSeconds,
  });
  await writeSecret(flags.out, secret);
  const expiresAt = new Date((issuedAt + lifetimeSeconds) * 1000).toISOString();
  process.stdout.write(
    `Wrote the Apple client secret to ${flags.out}; it expires ${expiresAt}.\n` +
      "Install it in both Supabase projects, then confirm with a real Apple sign-in.\n",
  );
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`apple-client-secret: ${err.message}\n`);
    process.exit(1);
  });
}
