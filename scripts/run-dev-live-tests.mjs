#!/usr/bin/env node
// Runs the opt-in live tests against the DEV Supabase project
// (huhzactreblzcogqkbsd) with the keys this machine already holds, so nobody
// maps env vars by hand:
//
//   - profile-guard: scripts/__tests__/profile-privilege-guard.live.test.mjs
//     (needs the dev URL, anon key and service-role key)
//   - account-deletion: apps/web/__tests__/integration/account-deletion.live.test.ts
//     (needs the dev URL and service-role key)
//
// Both create real users on dev and delete them again.
//
// Where the keys come from:
//   - Service-role key: --key-file, by default ~/drafto-secrets/dev-supabase-admin.env
//     (the Mac mini; DEV_SUPABASE_URL= / DEV_SUPABASE_SERVICE_ROLE_KEY=, mode
//     600, the file the factory mints browser sign-in links with). Only when
//     no --key-file is given and that default file is missing: the DEV: line of
//     --keys-txt, by default ~/drafto-secrets/supabase service keys.txt (the
//     MacBook Air), also mode 600. A JWT key must carry the dev project's ref;
//     any other key format is used but reported as unverified.
//   - Anon key: NEXT_PUBLIC_SUPABASE_ANON_KEY in --env-local, by default
//     apps/web/.env.local, whose NEXT_PUBLIC_SUPABASE_URL must be the dev project.
//
// Each test gets the variables its entry in LIVE_TESTS needs, from
// NEXT_PUBLIC_SUPABASE_URL (always the dev URL), NEXT_PUBLIC_SUPABASE_ANON_KEY
// and SUPABASE_SERVICE_ROLE_KEY, plus DRAFTO_LIVE_REQUIRED=1. With that set, a
// live test that can't run fails instead of skipping, so a skip can't pass for
// a green run.
//
// Interactive sessions only. It refuses, before reading any key file, when it
// runs under an unattended session (DRAFTO_UNATTENDED=1, which the factory,
// support and nightly scripts and the verification lane export) or under
// `node --test`. The verification lane's guard (scripts/lib/verify-guard.mjs)
// also denies any command naming it or a `test:live` script.
//
// Usage:
//   pnpm test:live:supabase [-- --only profile-guard|account-deletion] [--dry-run]
//   node scripts/run-dev-live-tests.mjs [--key-file <f>] [--keys-txt <f>]
//        [--env-local <f>] [--only profile-guard|account-deletion] [--dry-run] [--help]
//
// --dry-run prints the commands and the names of the env vars it would set,
// then exits 0. Output names files and variables, never a key's value. Exit 0
// when every test passed (or for --help), 1 when one failed, timed out or a
// key couldn't be found, or the session is unattended, 2 on bad arguments.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvValues } from "./lib/browser-report.mjs";
import {
  DEV_SUPABASE_REF,
  DEV_SUPABASE_URL,
  keyFileProblem,
  parseKeyFile,
} from "./lib/browser-signin.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { parseFlags } from "./lib/parse-flags.mjs";
import { SERVICE_KEYS_TXT, serviceKeyFromText } from "./lib/service-keys-txt.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const URL_VAR = "NEXT_PUBLIC_SUPABASE_URL";
const ANON_VAR = "NEXT_PUBLIC_SUPABASE_ANON_KEY";
const SERVICE_VAR = "SUPABASE_SERVICE_ROLE_KEY";
export const REQUIRED_VAR = "DRAFTO_LIVE_REQUIRED";
// Exported by unattended sessions (factory, support, nightly, verify lane).
export const UNATTENDED_VAR = "DRAFTO_UNATTENDED";
// Wall cap per test: each makes a handful of requests, so this only catches a hang.
export const TEST_TIMEOUT_MS = 15 * 60_000;

// Commands run from the repo root; `needs` is every variable the test gets.
export const LIVE_TESTS = {
  "profile-guard": {
    command: "node",
    args: ["--test", "scripts/__tests__/profile-privilege-guard.live.test.mjs"],
    needs: [URL_VAR, ANON_VAR, SERVICE_VAR],
  },
  "account-deletion": {
    command: "pnpm",
    args: [
      "--filter",
      "@drafto/web",
      "exec",
      "vitest",
      "run",
      "__tests__/integration/account-deletion.live.test.ts",
    ],
    needs: [URL_VAR, SERVICE_VAR],
  },
};

export class UsageError extends Error {}

export const USAGE =
  "usage: run-dev-live-tests.mjs [--key-file <f>] [--keys-txt <f>] [--env-local <f>] " +
  `[--only ${Object.keys(LIVE_TESTS).join("|")}] [--dry-run] [--help]`;
const PATH_FLAGS = ["key-file", "keys-txt", "env-local"];
const VALUE_FLAGS = [...PATH_FLAGS, "only"];

export function defaultPaths({ home = homedir(), repoRoot = REPO_ROOT } = {}) {
  return {
    keyFile: path.join(home, "drafto-secrets", "dev-supabase-admin.env"),
    keysTxt: path.join(home, "drafto-secrets", SERVICE_KEYS_TXT),
    envLocal: path.join(repoRoot, "apps", "web", ".env.local"),
  };
}

/**
 * argv → {keyFile, keyFileGiven, keysTxt, envLocal, only, dryRun, help}.
 * Throws UsageError.
 */
export function parseArgs(argv, defaults = defaultPaths()) {
  let dryRun = false;
  let help = false;
  const rest = [];
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") help = true;
    // `pnpm test:live:supabase -- --only x` may hand the `--` through.
    else if (arg !== "--") rest.push(arg);
  }
  let parsed;
  try {
    parsed = parseFlags(rest);
  } catch (err) {
    throw new UsageError(`${err.message}\n${USAGE}`);
  }
  const { flags, positional } = parsed;
  if (positional.length) throw new UsageError(`unexpected argument: ${positional[0]}\n${USAGE}`);
  const unknown = Object.keys(flags).find((f) => !VALUE_FLAGS.includes(f));
  if (unknown) throw new UsageError(`unknown flag --${unknown}\n${USAGE}`);
  const empty = PATH_FLAGS.find((f) => flags[f] === "");
  if (empty) throw new UsageError(`--${empty} needs a path\n${USAGE}`);
  if (flags.only !== undefined && !Object.hasOwn(LIVE_TESTS, flags.only)) {
    throw new UsageError(`--only must be one of: ${Object.keys(LIVE_TESTS).join(", ")}`);
  }
  return {
    keyFile: flags["key-file"] ?? defaults.keyFile,
    keyFileGiven: flags["key-file"] !== undefined,
    keysTxt: flags["keys-txt"] ?? defaults.keysTxt,
    envLocal: flags["env-local"] ?? defaults.envLocal,
    only: flags.only ?? null,
    dryRun,
    help,
  };
}

/**
 * Why this process must not touch the dev keys, or null: an unattended
 * session, or a run under the node test runner (`node --test <this file>`
 * makes the file its own main module).
 */
export function refusalReason({ env = process.env, execArgv = process.execArgv } = {}) {
  if (env[UNATTENDED_VAR] === "1") {
    return (
      `${UNATTENDED_VAR}=1: this is an unattended session, and the dev live tests ` +
      "run only from interactive sessions. Ask the operator to run pnpm test:live:supabase."
    );
  }
  if (env.NODE_TEST_CONTEXT || execArgv.includes("--test")) {
    return "running under node --test; run it as pnpm test:live:supabase instead";
  }
  return null;
}

function describeProblem(file, problem) {
  if (problem === "mode") return `${file} is open to other users; chmod 600 it`;
  if (problem === "not-a-file") return `${file} is not a regular file`;
  return `${file} is missing`;
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * What a service-role key says about its project. A JWT (the legacy key
 * format) carries `ref` and `role` claims: {jwt: true, problem} where problem
 * is null for a dev service_role key. Anything else (an `sb_secret_…` key)
 * can't be checked offline: {jwt: false, problem: null}. Problems never quote
 * the key or its claims.
 */
export function inspectServiceKey(key) {
  if (!JWT_RE.test(key)) return { jwt: false, problem: null };
  let claims;
  try {
    claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return { jwt: true, problem: "its key looks like a JWT but its payload can't be read" };
  }
  if (claims?.ref !== DEV_SUPABASE_REF) {
    return { jwt: true, problem: `its key is not for the dev project (${DEV_SUPABASE_REF})` };
  }
  if (claims.role !== undefined && claims.role !== "service_role") {
    return { jwt: true, problem: "its key is not a service_role key" };
  }
  return { jwt: true, problem: null };
}

function checkedKey(serviceRoleKey, source, { urlChecked }) {
  const { jwt, problem } = inspectServiceKey(serviceRoleKey);
  if (problem) throw new Error(`${source}: ${problem}`);
  return { serviceRoleKey, source, verified: jwt || urlChecked };
}

/**
 * The dev service-role key: from <keyFile> (dev-supabase-admin.env), or, only
 * when <keyFileGiven> is false and that file is missing, from the DEV: line of
 * <keysTxt>. Both must be mode 600, and a JWT key must be dev's. Returns
 * {serviceRoleKey, source, verified}; throws naming the file and the missing
 * variable, never a value.
 */
export function resolveServiceRoleKey({ keyFile, keysTxt, keyFileGiven = false }) {
  const problem = keyFileProblem(keyFile);
  if (!problem) {
    let serviceRoleKey;
    try {
      ({ serviceRoleKey } = parseKeyFile(readFileSync(keyFile, "utf8")));
    } catch (err) {
      throw new Error(`${keyFile}: ${err.message}`);
    }
    return checkedKey(serviceRoleKey, keyFile, { urlChecked: true });
  }
  if (problem !== "missing" || keyFileGiven) {
    const given = keyFileGiven ? " (given with --key-file, so keys.txt isn't tried)" : "";
    throw new Error(`${describeProblem(keyFile, problem)}${given}`);
  }

  const txtProblem = keyFileProblem(keysTxt);
  if (txtProblem === "missing") {
    throw new Error(
      `no dev service-role key: ${keyFile} is missing, and so is ${keysTxt}. ` +
        "On the Mac mini, write dev-supabase-admin.env as in docs/operations/factory-runbook.md " +
        '("One-time setup", the dev sign-in key); or pass --key-file.',
    );
  }
  if (txtProblem) throw new Error(describeProblem(keysTxt, txtProblem));
  const serviceRoleKey = serviceKeyFromText(readFileSync(keysTxt, "utf8"), "DEV");
  if (!serviceRoleKey) throw new Error(`${keyFile} is missing, and ${keysTxt} has no DEV: line`);
  return checkedKey(serviceRoleKey, keysTxt, { urlChecked: false });
}

/**
 * NEXT_PUBLIC_SUPABASE_ANON_KEY from <envLocal>, refused unless the same
 * file's NEXT_PUBLIC_SUPABASE_URL is the dev project. Returns {anonKey,
 * source}; throws naming the file and variable, never a value.
 */
export function resolveAnonKey({ envLocal }) {
  if (!existsSync(envLocal)) {
    throw new Error(
      `${envLocal} is missing (it holds ${ANON_VAR}); in a worktree, run bash scripts/worktree-bootstrap.sh`,
    );
  }
  const values = parseEnvValues(readFileSync(envLocal, "utf8"), [URL_VAR, ANON_VAR]);
  if (!values[URL_VAR]) throw new Error(`${envLocal} has no ${URL_VAR}`);
  if (values[URL_VAR].replace(/\/+$/, "") !== DEV_SUPABASE_URL) {
    throw new Error(`${envLocal}: ${URL_VAR} is not the dev project (${DEV_SUPABASE_REF})`);
  }
  if (!values[ANON_VAR]) throw new Error(`${envLocal} has no ${ANON_VAR}`);
  return { anonKey: values[ANON_VAR], source: envLocal };
}

/**
 * What to run and with which env. Each selected test's `needs` decides what is
 * read and what that test gets: {runs: [{name, command, args, display, env}],
 * env (the union), sources: {VAR: where it came from}}.
 */
export function planRuns({ keyFile, keyFileGiven, keysTxt, envLocal, only }, tests = LIVE_TESTS) {
  const names = only ? [only] : Object.keys(tests);
  const needs = new Set(names.flatMap((n) => tests[n].needs));
  const values = {};
  const sources = {};
  // The service-role key first: it is the one most likely to be missing.
  if (needs.has(SERVICE_VAR)) {
    const service = resolveServiceRoleKey({ keyFile, keysTxt, keyFileGiven });
    values[SERVICE_VAR] = service.serviceRoleKey;
    sources[SERVICE_VAR] = service.verified
      ? service.source
      : `${service.source}; not a JWT, so its project couldn't be verified`;
  }
  if (needs.has(ANON_VAR)) {
    const anon = resolveAnonKey({ envLocal });
    values[ANON_VAR] = anon.anonKey;
    sources[ANON_VAR] = anon.source;
  }
  if (needs.has(URL_VAR)) {
    values[URL_VAR] = DEV_SUPABASE_URL;
    sources[URL_VAR] = `dev project ${DEV_SUPABASE_REF}`;
  }
  const required = { [REQUIRED_VAR]: "1" };
  const order = [URL_VAR, ANON_VAR, SERVICE_VAR].filter((v) => needs.has(v));
  const env = { ...Object.fromEntries(order.map((v) => [v, values[v]])), ...required };
  const runs = names.map((name) => {
    const { command, args, needs: own } = tests[name];
    const runEnv = { ...Object.fromEntries(own.map((v) => [v, values[v]])), ...required };
    return { name, command, args, display: [command, ...args].join(" "), env: runEnv };
  });
  return {
    runs,
    env,
    sources: {
      ...Object.fromEntries(order.map((v) => [v, sources[v]])),
      [REQUIRED_VAR]: "fails a test that can't run instead of skipping it",
    },
  };
}

/** The --dry-run text: commands and env var names, never a value. */
export function describePlan({ runs, sources }, repoRoot = REPO_ROOT) {
  const lines = [`Dry run: nothing executed. Commands run in ${repoRoot}. Variables:`];
  for (const [name, source] of Object.entries(sources)) lines.push(`  ${name}  (${source})`);
  lines.push("Commands (each gets the variables it needs):");
  for (const run of runs) {
    lines.push(`  [${run.name}] ${run.display}`);
    lines.push(`      sets ${Object.keys(run.env).join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

function outcomeOf(res, timeoutMs) {
  if (res.error?.code === "ETIMEDOUT")
    return `timed out after ${Math.round(timeoutMs / 60_000)} min`;
  if (res.error) return `could not start (${res.error.code ?? res.error.message})`;
  if (res.signal) return `killed by ${res.signal}`;
  if (res.status !== 0) return `failed (exit ${res.status})`;
  return "passed";
}

/**
 * Run each test in turn with process env + its own env; every test runs even
 * after one fails. Returns the exit code: 0 when all passed, 1 otherwise.
 */
export function runPlan({
  runs,
  repoRoot = REPO_ROOT,
  baseEnv = process.env,
  timeoutMs = TEST_TIMEOUT_MS,
  spawnImpl = spawnSync,
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  const results = [];
  for (const run of runs) {
    log(`\n[run-dev-live-tests] ${run.name}: ${run.display}`);
    // `node` is this same Node binary, so PATH can't swap it.
    const command = run.command === "node" ? process.execPath : run.command;
    const res = spawnImpl(command, run.args, {
      cwd: repoRoot,
      env: { ...baseEnv, ...run.env },
      stdio: "inherit",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    });
    const outcome = outcomeOf(res, timeoutMs);
    results.push({ name: run.name, ok: outcome === "passed", outcome });
  }
  log("\n[run-dev-live-tests] summary:");
  for (const r of results) log(`  ${r.name}: ${r.outcome}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`run-dev-live-tests: ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  // Before any key file is read.
  const refused = refusalReason();
  if (refused) {
    process.stderr.write(`run-dev-live-tests: refused: ${refused}\n`);
    return 1;
  }
  const plan = planRuns(opts);
  if (opts.dryRun) {
    process.stdout.write(describePlan(plan));
    return 0;
  }
  process.stderr.write(
    `[run-dev-live-tests] running ${plan.runs.length} live test(s) against the dev Supabase ` +
      `project (${DEV_SUPABASE_REF}); they create users there and delete them again.\n`,
  );
  return runPlan(plan);
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`run-dev-live-tests: ${err.message}\n`);
    process.exitCode = 1;
  }
}
