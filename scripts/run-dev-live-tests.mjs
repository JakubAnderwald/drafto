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
//     600, the file the factory mints browser sign-in links with). When that
//     file is missing, the DEV: line of --keys-txt, by default
//     ~/drafto-secrets/supabase service keys.txt (the MacBook Air), also mode 600.
//   - Anon key: NEXT_PUBLIC_SUPABASE_ANON_KEY in --env-local, by default
//     apps/web/.env.local, whose NEXT_PUBLIC_SUPABASE_URL must be the dev project.
//
// Each test gets NEXT_PUBLIC_SUPABASE_URL (always the dev URL),
// NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY and
// DRAFTO_LIVE_REQUIRED=1. With DRAFTO_LIVE_REQUIRED=1 a live test that can't
// run fails instead of skipping, so a skip can't pass for a green run.
//
// Interactive sessions only. The factory's verification lane can't call it:
// its guard denies any pnpm script named with "supabase" (pnpm
// test:live:supabase) and any `node scripts/…` (scripts/lib/verify-guard.mjs).
//
// Usage:
//   pnpm test:live:supabase [-- --only profile-guard|account-deletion] [--dry-run]
//   node scripts/run-dev-live-tests.mjs [--key-file <f>] [--keys-txt <f>]
//        [--env-local <f>] [--only profile-guard|account-deletion] [--dry-run]
//
// --dry-run prints the commands and the names of the env vars it would set,
// then exits 0. Output names files and variables, never a key's value. Exit 0
// when every test passed, 1 when one failed or a key couldn't be found, 2 on
// bad arguments.

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

// Commands run from the repo root; `display` is what --dry-run prints.
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

const USAGE =
  "usage: run-dev-live-tests.mjs [--key-file <f>] [--keys-txt <f>] [--env-local <f>] " +
  `[--only ${Object.keys(LIVE_TESTS).join("|")}] [--dry-run]`;
const VALUE_FLAGS = ["key-file", "keys-txt", "env-local", "only"];

export function defaultPaths({ home = homedir(), repoRoot = REPO_ROOT } = {}) {
  return {
    keyFile: path.join(home, "drafto-secrets", "dev-supabase-admin.env"),
    keysTxt: path.join(home, "drafto-secrets", SERVICE_KEYS_TXT),
    envLocal: path.join(repoRoot, "apps", "web", ".env.local"),
  };
}

/** argv → {keyFile, keysTxt, envLocal, only, dryRun}. Throws UsageError. */
export function parseArgs(argv, defaults = defaultPaths()) {
  let dryRun = false;
  const rest = [];
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
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
  if (flags.only !== undefined && !Object.hasOwn(LIVE_TESTS, flags.only)) {
    throw new UsageError(`--only must be one of: ${Object.keys(LIVE_TESTS).join(", ")}`);
  }
  return {
    keyFile: flags["key-file"] ?? defaults.keyFile,
    keysTxt: flags["keys-txt"] ?? defaults.keysTxt,
    envLocal: flags["env-local"] ?? defaults.envLocal,
    only: flags.only ?? null,
    dryRun,
  };
}

function describeProblem(file, problem) {
  if (problem === "mode") return `${file} is open to other users; chmod 600 it`;
  if (problem === "not-a-file") return `${file} is not a regular file`;
  return `${file} is missing`;
}

/**
 * The dev service-role key: from <keyFile> (dev-supabase-admin.env), or, only
 * when that file is missing, from the DEV: line of <keysTxt>. Both must be
 * mode 600. Returns {serviceRoleKey, source}; throws naming the file and the
 * missing variable, never a value.
 */
export function resolveServiceRoleKey({ keyFile, keysTxt }) {
  const problem = keyFileProblem(keyFile);
  if (!problem) {
    try {
      return {
        serviceRoleKey: parseKeyFile(readFileSync(keyFile, "utf8")).serviceRoleKey,
        source: keyFile,
      };
    } catch (err) {
      throw new Error(`${keyFile}: ${err.message}`);
    }
  }
  if (problem !== "missing") throw new Error(describeProblem(keyFile, problem));

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
  return { serviceRoleKey, source: keysTxt };
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
 * What to run and with which env: {runs: [{name, command, args, display}],
 * env: {VAR: value}, sources: {VAR: file}}. Reads the anon key only when a
 * selected test needs it.
 */
export function planRuns({ keyFile, keysTxt, envLocal, only }) {
  const names = only ? [only] : Object.keys(LIVE_TESTS);
  const needs = new Set(names.flatMap((n) => LIVE_TESTS[n].needs));
  const service = resolveServiceRoleKey({ keyFile, keysTxt });
  const env = { [URL_VAR]: DEV_SUPABASE_URL };
  const sources = { [URL_VAR]: `dev project ${DEV_SUPABASE_REF}` };
  if (needs.has(ANON_VAR)) {
    const anon = resolveAnonKey({ envLocal });
    env[ANON_VAR] = anon.anonKey;
    sources[ANON_VAR] = anon.source;
  }
  env[SERVICE_VAR] = service.serviceRoleKey;
  sources[SERVICE_VAR] = service.source;
  env[REQUIRED_VAR] = "1";
  sources[REQUIRED_VAR] = "fails a test that can't run instead of skipping it";
  const runs = names.map((name) => {
    const { command, args } = LIVE_TESTS[name];
    return { name, command, args, display: [command, ...args].join(" ") };
  });
  return { runs, env, sources };
}

/** The --dry-run text: commands and env var names, never a value. */
export function describePlan({ runs, sources }, repoRoot = REPO_ROOT) {
  const lines = [`Dry run: nothing executed. Each command runs in ${repoRoot} with these set:`];
  for (const [name, source] of Object.entries(sources)) lines.push(`  ${name}  (${source})`);
  lines.push("Commands:");
  for (const run of runs) lines.push(`  [${run.name}] ${run.display}`);
  return lines.join("\n") + "\n";
}

/**
 * Run each test in turn with process env + <env>; every test runs even after
 * one fails. Returns the exit code: 0 when all passed, 1 otherwise.
 */
export function runPlan({
  runs,
  env,
  repoRoot = REPO_ROOT,
  baseEnv = process.env,
  spawnImpl = spawnSync,
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  const childEnv = { ...baseEnv, ...env };
  const results = [];
  for (const run of runs) {
    log(`\n[run-dev-live-tests] ${run.name}: ${run.display}`);
    // `node` is this same Node binary, so PATH can't swap it.
    const command = run.command === "node" ? process.execPath : run.command;
    const res = spawnImpl(command, run.args, { cwd: repoRoot, env: childEnv, stdio: "inherit" });
    let outcome;
    if (res.error) outcome = `could not start (${res.error.code ?? res.error.message})`;
    else if (res.signal) outcome = `killed by ${res.signal}`;
    else if (res.status !== 0) outcome = `failed (exit ${res.status})`;
    else outcome = "passed";
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
