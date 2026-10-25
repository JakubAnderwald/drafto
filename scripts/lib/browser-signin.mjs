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
// The sign-in lease. Supabase keeps one live magic-link token per user, so a
// newer mint invalidates an older link that hasn't been opened yet. Two
// factory lanes sign in to previews as the same test account: the browser
// runner (factory-agent.sh's browser_run mints, and the runner opens the link
// a minute or more later) and the verification shell lane (verify-lane.mjs's
// signInPreview mints and exchanges the link within seconds). Each takes the
// lease before minting, so one never mints over the other's unopened link.
// The lease is a small JSON file ({owner, pid, acquiredAt, until, nonce}),
// taken atomically: written whole to a temp file, then hard-linked into place,
// which fails if a lease is already there, so of two rivals only one link
// lands. A lease another owner holds is busy until its `until`. After that
// anyone may take it over, and the same owner may take its own again (a retry
// after a crash): the old lease is moved aside, checked to be exactly the one
// judged expired (put back if it changed in between), and the new one is
// linked in. Release moves the lease aside the same way and removes it only if
// it is its owner's, so a holder whose lease expired and was taken over can't
// remove the new holder's. A lease nobody releases expires on its own. A lease
// file that can't be used at all (an unwritable directory) fails open: the
// mint goes ahead without it, with a warning. Callers that pass no lease file
// mint exactly as before.
//
// CLI:
//   node browser-signin.mjs mint --key-file <f> --account-file <f> --origin <preview origin>
//        [--lease-file <f> --owner <o> [--hold-sec <n>]]
//     Prints the sign-in URL on stdout. Exit 0; 1 on any failure (the message
//     names what failed, never a key, password or token). With a lease file,
//     takes the lease first (held --hold-sec seconds, default 300) and gives
//     it back if minting then fails; when another owner holds it, prints one
//     JSON line {busy: true, owner, until} and exits 3, minting nothing.
//   node browser-signin.mjs release --lease-file <f> --owner <o>
//     Removes the lease if <o> holds it. Prints one JSON line {released, …};
//     exit 0 (1 only on bad argv).

import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

import { readAccountFile } from "./browser-report.mjs";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

// The dev project (docs/architecture/environments.md). Minting refuses any
// other project, so a key file pointed at production can never produce a link.
export const DEV_SUPABASE_REF = "huhzactreblzcogqkbsd";
export const DEV_SUPABASE_URL = `https://${DEV_SUPABASE_REF}.supabase.co`;
export const SIGN_IN_PATH = "/auth/test-sign-in";
const PREVIEW_ORIGIN = /^https:\/\/drafto-[a-z0-9-]+-jakubanderwalds-projects\.vercel\.app$/;

// The CLI's exit code for a lease another owner holds.
export const LEASE_BUSY_EXIT = 3;
export const DEFAULT_LEASE_SEC = 300;
// The generate_link request's cap: a lease must not sit behind a hung request.
export const MINT_TIMEOUT_MS = 30_000;
// Owners are log-safe labels like "browser:verify:501:0123456789ab".
const LEASE_OWNER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

/** Thrown by mint() when another owner holds the lease: nothing was minted. */
export class LeaseBusyError extends Error {
  constructor({ owner, until }) {
    super(`the sign-in lease is held by ${owner ?? "unknown"} until ${until ?? "unknown"}`);
    this.name = "LeaseBusyError";
    this.busy = true;
    this.owner = owner ?? null;
    this.until = until ?? null;
  }
}

/**
 * The lease in <file>: {owner, pid, acquiredAt, until, untilMs, nonce, raw};
 * null when there is none; {invalid: true, raw} when its text isn't a lease;
 * {invalid: true, unreadable: true} when the file can't be read at all.
 */
export function readLease(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return err?.code === "ENOENT" ? null : { invalid: true, unreadable: true };
  }
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return { invalid: true, raw };
  }
  const untilMs = Date.parse(v?.until ?? "");
  if (typeof v?.owner !== "string" || !Number.isFinite(untilMs)) return { invalid: true, raw };
  return {
    owner: v.owner,
    pid: v.pid ?? null,
    acquiredAt: v.acquiredAt ?? null,
    until: v.until,
    untilMs,
    nonce: v.nonce ?? null,
    raw,
  };
}

function checkLeaseArgs({ file, owner }) {
  if (typeof file !== "string" || file === "") throw new Error("lease file required");
  if (!LEASE_OWNER.test(String(owner ?? ""))) throw new Error(`invalid lease owner: ${owner}`);
}

function checkHold(holdSec) {
  if (!Number.isInteger(holdSec) || holdSec < 1) throw new Error(`invalid lease hold: ${holdSec}`);
}

function busy(held) {
  return { ok: false, busy: true, owner: held?.owner ?? "unknown", until: held?.until ?? null };
}

/**
 * Remove the lease in <file> only if its text is still <expectedRaw>: a
 * compare-and-swap built from one atomic rename. Whatever is in place is moved
 * aside; if it isn't the expected text (a rival replaced it since it was read),
 * it is linked straight back. True when the slot is now empty (the expected
 * lease was removed, or there was none); false when it held something else.
 * The slot is empty only for the moment between the rename and the link back.
 */
export function moveLeaseAside(file, expectedRaw) {
  const aside = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.aside`;
  try {
    renameSync(file, aside);
  } catch (err) {
    if (err?.code === "ENOENT") return true;
    throw err;
  }
  let movedRaw = null;
  try {
    movedRaw = readFileSync(aside, "utf8");
  } catch {
    movedRaw = null;
  }
  try {
    if (typeof expectedRaw === "string" && movedRaw === expectedRaw) return true;
    try {
      linkSync(aside, file);
    } catch (err) {
      // Only a third minter could have linked in that moment; there are two.
      if (err?.code !== "EEXIST") throw err;
    }
    return false;
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Take the lease in <file> for <owner>, for <holdSec> seconds. Returns
 * {ok: true, lease, takenOver} or {ok: false, busy: true, owner, until}.
 * Throws on bad arguments, and when the lease file can't be written or read
 * at all (mint() then fails open).
 */
export function acquireLease({ file, owner, holdSec, now = Date.now() }) {
  checkLeaseArgs({ file, owner });
  checkHold(holdSec);
  const lease = {
    owner,
    pid: process.pid,
    acquiredAt: new Date(now).toISOString(),
    until: new Date(now + holdSec * 1000).toISOString(),
    nonce: randomBytes(8).toString("hex"),
  };
  // Written whole before it is linked in, so a reader never sees half a lease.
  const tmp = `${file}.${process.pid}.${lease.nonce}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease) + "\n", { mode: 0o600, flag: "wx" });
  let takenOver = false;
  try {
    for (let i = 0; i < 4; i++) {
      try {
        linkSync(tmp, file);
        return { ok: true, lease, takenOver };
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
      }
      const held = readLease(file);
      // Released between the link and the read: link again.
      if (held === null) continue;
      if (held.unreadable) throw new Error(`lease file can't be read: ${file}`);
      if (!held.invalid && held.untilMs > now && held.owner !== owner) return busy(held);
      // Expired, not a lease, or this owner's own: remove exactly that one,
      // then link again. A rival that linked a fresh lease in between is put
      // back by the compare-and-swap, or wins the link, and this side reads busy.
      if (moveLeaseAside(file, held.raw)) takenOver = true;
    }
    return busy(readLease(file));
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Remove the lease in <file> if <owner> holds it. {released: true}, or
 * {released: false, reason: "none" | "not-owner", owner?}. Never throws on a
 * lease that is gone or someone else's.
 */
export function releaseLease({ file, owner }) {
  checkLeaseArgs({ file, owner });
  const held = readLease(file);
  if (held === null) return { released: false, reason: "none" };
  if (held.invalid || held.owner !== owner) {
    return { released: false, reason: "not-owner", owner: held.owner ?? null };
  }
  // The browser runner releases after its lease has usually expired, when the
  // shell lane may be taking it over: remove only the lease that was read.
  if (!moveLeaseAside(file, held.raw)) {
    return { released: false, reason: "not-owner", owner: readLease(file)?.owner ?? null };
  }
  return { released: true };
}

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
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
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

function warnToStderr(message) {
  process.stderr.write(`browser-signin: WARNING: ${message}\n`);
}

/**
 * Mint the one-time sign-in link for <origin>. With <lease> ({file, owner,
 * holdSec}), the lease is taken after the local checks and before the request;
 * LeaseBusyError when another owner holds it. The caller releases it once its
 * link has been used; mint() releases it itself only when minting fails. A
 * lease file that can't be used at all fails open: <onWarning> hears why, and
 * the mint goes ahead without a lease, as it did before the lease existed.
 */
export async function mint({
  keyFile,
  accountFile,
  origin,
  fetchImpl = fetch,
  lease = null,
  onWarning = warnToStderr,
}) {
  // Before any request: a token minted for a link that can't be built would
  // only be a live login token sitting unused.
  if (!PREVIEW_ORIGIN.test(String(origin ?? ""))) {
    throw new Error(`not a Drafto preview origin: ${origin}`);
  }
  const problem = keyFileProblem(keyFile);
  if (problem) throw new Error(`key file ${problem}: ${keyFile}`);
  const { url, serviceRoleKey } = parseKeyFile(readFileSync(keyFile, "utf8"));
  const { email } = readAccountFile(accountFile);
  let held = null;
  if (lease) {
    // Bad arguments are a caller's bug, not a lease file problem: they throw.
    checkLeaseArgs(lease);
    checkHold(lease.holdSec);
    let got = null;
    try {
      got = acquireLease({ file: lease.file, owner: lease.owner, holdSec: lease.holdSec });
    } catch (err) {
      onWarning(`the sign-in lease couldn't be used (${err.message}); minting without it`);
    }
    if (got && !got.ok) throw new LeaseBusyError(got);
    if (got) held = lease;
  }
  try {
    const hashed = await mintHashedToken({ url, serviceRoleKey, email, fetchImpl });
    return buildSignInUrl(origin, hashed);
  } catch (err) {
    if (held) {
      try {
        releaseLease({ file: held.file, owner: held.owner });
      } catch {
        /* it expires on its own; the mint error is the one to report */
      }
    }
    throw err;
  }
}

const USAGE =
  "usage: browser-signin.mjs mint --key-file <f> --account-file <f> --origin <o> " +
  "[--lease-file <f> --owner <o> [--hold-sec <n>]] | release --lease-file <f> --owner <o>";

function leaseFromFlags(flags) {
  if (!flags["lease-file"]) {
    if (flags.owner || flags["hold-sec"])
      throw new Error("--owner and --hold-sec need --lease-file");
    return null;
  }
  if (!flags.owner) throw new Error("--owner required with --lease-file");
  const raw = flags["hold-sec"] ?? String(DEFAULT_LEASE_SEC);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`--hold-sec must be a positive integer: ${raw}`);
  return { file: flags["lease-file"], owner: flags.owner, holdSec: Number(raw) };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== "mint" && cmd !== "release") throw new Error(USAGE);
  const { flags } = parseFlags(rest);
  if (cmd === "release") {
    for (const f of ["lease-file", "owner"]) {
      if (!flags[f]) throw new Error(`--${f} required`);
    }
    const out = releaseLease({ file: flags["lease-file"], owner: flags.owner });
    process.stdout.write(JSON.stringify(out) + "\n");
    return;
  }
  for (const f of ["key-file", "account-file", "origin"]) {
    if (!flags[f]) throw new Error(`--${f} required`);
  }
  let link;
  try {
    link = await mint({
      keyFile: flags["key-file"],
      accountFile: flags["account-file"],
      origin: flags.origin,
      lease: leaseFromFlags(flags),
    });
  } catch (err) {
    if (!(err instanceof LeaseBusyError)) throw err;
    process.stdout.write(JSON.stringify({ busy: true, owner: err.owner, until: err.until }) + "\n");
    process.exitCode = LEASE_BUSY_EXIT;
    return;
  }
  process.stdout.write(link + "\n");
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`browser-signin: ${err.message}\n`);
    process.exit(1);
  });
}
