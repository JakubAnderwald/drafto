#!/usr/bin/env node
// Mints the one-time sign-in link the browser runner opens on a preview.
//
// Why this exists: the runner drives Claude in Chrome, which will not type a
// password into a site that isn't a local development host (measured on
// 2026-10-17: it refused on a vercel.app preview). Previews run against the dev
// Supabase project, and the web app has a preview-only route,
// /auth/test-sign-in, that turns a Supabase magic-link token into a session
// (apps/web/src/app/auth/test-sign-in/route.ts, ADR-0051). This module asks
// dev Supabase for such a token for the factory's test account (admin
// generate_link, which sends no email) and prints the link to that route on
// the run's exact preview origin. The runner opens it instead of typing a
// password, so the password never reaches the runner at all.
//
// The token is single-use and short-lived, and minting one needs the dev
// service-role key, read from a mode-600 file in ~/drafto-secrets. The key is
// never printed and never reaches the runner; only the link does.
//
// CLI:
//   node browser-signin.mjs mint --key-file <f> --account-file <f> --origin <preview origin>
//     Prints the sign-in URL on stdout. Exit 0; 1 on any failure (the message
//     names what failed, never a key, password or token).

import { readFileSync, statSync } from "node:fs";

import { readAccountFile } from "./browser-report.mjs";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

// The dev project (docs/architecture/environments.md). Minting refuses any
// other project, so a key file pointed at production can never produce a link.
export const DEV_SUPABASE_REF = "huhzactreblzcogqkbsd";
export const DEV_SUPABASE_URL = `https://${DEV_SUPABASE_REF}.supabase.co`;
export const SIGN_IN_PATH = "/auth/test-sign-in";
const PREVIEW_ORIGIN = /^https:\/\/drafto-[a-z0-9-]+-jakubanderwalds-projects\.vercel\.app$/;

/** KEY=VALUE lines → {url, serviceRoleKey}. Throws naming the missing key, never a value. */
export function parseKeyFile(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const q = /^(["'])(.*)\1$/.exec(value);
    if (q) value = q[2];
    out[m[1]] = value;
  }
  if (!out.DEV_SUPABASE_URL) throw new Error("key file has no DEV_SUPABASE_URL");
  if (!out.DEV_SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("key file has no DEV_SUPABASE_SERVICE_ROLE_KEY");
  }
  if (out.DEV_SUPABASE_URL.replace(/\/+$/, "") !== DEV_SUPABASE_URL) {
    throw new Error(`key file is not for the dev project (${DEV_SUPABASE_REF})`);
  }
  return { url: DEV_SUPABASE_URL, serviceRoleKey: out.DEV_SUPABASE_SERVICE_ROLE_KEY };
}

/** Why the key file must not be used, or null. Same rule as the account file. */
export function keyFileProblem(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return "missing";
  }
  if (!st.isFile()) return "not-a-file";
  if ((st.mode & 0o077) !== 0) return "mode";
  return null;
}

/** The link the runner opens: the preview's own origin, so the guard allows it. */
export function buildSignInUrl(origin, hashedToken) {
  if (!PREVIEW_ORIGIN.test(String(origin ?? ""))) {
    throw new Error(`not a Drafto preview origin: ${origin}`);
  }
  if (typeof hashedToken !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(hashedToken)) {
    throw new Error("Supabase returned no usable hashed_token");
  }
  const u = new URL(SIGN_IN_PATH, origin);
  u.searchParams.set("token_hash", hashedToken);
  u.searchParams.set("next", "/");
  return u.toString();
}

/** Ask dev Supabase for a magic-link token for <email>. No email is sent. */
export async function mintHashedToken({ url, serviceRoleKey, email, fetchImpl = fetch }) {
  const res = await fetchImpl(`${url}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", email }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    // GoTrue's error text names the problem (unknown user, bad key) and holds
    // no secret; the status alone is not enough to fix it.
    const why = body && (body.msg || body.error_description || body.error);
    throw new Error(
      `generate_link failed: HTTP ${res.status}${why ? ` (${String(why).slice(0, 200)})` : ""}`,
    );
  }
  // Flat in the GoTrue response; supabase-js re-nests it under `properties`.
  return body?.hashed_token ?? body?.properties?.hashed_token;
}

export async function mint({ keyFile, accountFile, origin, fetchImpl = fetch }) {
  // Before any request: a token minted for a link that can't be built would
  // only be a live login token sitting unused.
  if (!PREVIEW_ORIGIN.test(String(origin ?? ""))) {
    throw new Error(`not a Drafto preview origin: ${origin}`);
  }
  const problem = keyFileProblem(keyFile);
  if (problem) throw new Error(`key file ${problem}: ${keyFile}`);
  const { url, serviceRoleKey } = parseKeyFile(readFileSync(keyFile, "utf8"));
  const { email } = readAccountFile(accountFile);
  const hashed = await mintHashedToken({ url, serviceRoleKey, email, fetchImpl });
  return buildSignInUrl(origin, hashed);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== "mint")
    throw new Error(
      `usage: browser-signin.mjs mint --key-file <f> --account-file <f> --origin <o>`,
    );
  const { flags } = parseFlags(rest);
  for (const f of ["key-file", "account-file", "origin"]) {
    if (!flags[f]) throw new Error(`--${f} required`);
  }
  const link = await mint({
    keyFile: flags["key-file"],
    accountFile: flags["account-file"],
    origin: flags.origin,
  });
  process.stdout.write(link + "\n");
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`browser-signin: ${err.message}\n`);
    process.exit(1);
  });
}
