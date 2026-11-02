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

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "./lib/is-main.mjs";
import { parseFlags } from "./lib/parse-flags.mjs";
// The signer is shared with the web API, which signs short-lived secrets to
// revoke Apple tokens when an account is deleted.
import {
  APPLE_SERVICES_ID,
  MAX_LIFETIME_SECONDS,
  buildClientSecret,
} from "../apps/web/src/lib/apple/client-secret.mjs";

export { MAX_LIFETIME_SECONDS, buildClientSecret };

const DEFAULTS = {
  key: path.join(os.homedir(), "drafto-secrets", "AuthKey_7BS35Y82Q6.p8"),
  "key-id": "7BS35Y82Q6",
  "team-id": "4J2USPSG2U",
  // The Services ID, which must stay the FIRST Apple Client ID in Supabase:
  // the browser flows send that entry as Apple's client_id.
  "client-id": APPLE_SERVICES_ID,
  days: "180",
};

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
