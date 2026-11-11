// The verification shell lane's dev live tests (ADR-0073). The supervisor runs
// the scenario's `### Live tests` (names from scripts/run-dev-live-tests.mjs
// LIVE_TESTS) at the PR head, with the dev service-role key, BEFORE the claude
// session starts, and stores only each test's name and outcome in
// private/lane-tests-results.json. The session's `live-tests <name>` reads that
// file; it never runs anything.
//
// Why before: the PR head's tests run with the key, so the code they run must
// be the commit under test. During the session the model can write to the
// worktree (and its node_modules), so a test run it could trigger would run
// whatever it wrote there, and an encoded key would get past any output
// filter. Before the session the worktree holds exactly the commit plus its
// install.
//
// How a test runs: the PR head's own runner, `node scripts/run-dev-live-tests.mjs
// --only <name> --key-file <dev key> --env-local <factory checkout's env file>`,
// in a scrubbed environment without DRAFTO_UNATTENDED (the runner's own refusal
// is for sessions that would hold the key themselves) and in its own process
// group, killed whole on timeout.
//
// What is stored is filtered, never raw: result lines only (node:test's spec
// and TAP lines, vitest's ✓/× lines and totals, the runner's per-test summary),
// each cut to 200 characters, at most 200 of them. If any of that still
// matches a secret pattern or the key itself, the whole output is withheld.
// Failure messages and stack traces are dropped: they can carry whatever the
// test printed.

import { spawn } from "node:child_process";
import * as nodeFs from "node:fs";
import path from "node:path";
import { keyFileProblem, parseKeyFile } from "./browser-signin.mjs";

export const LIVE_TEST_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
export const LIVE_TEST_TIMEOUT_MS = 10 * 60_000;
export const MAX_LIVE_TESTS = 5;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_LINES = 200;
const MAX_LINE = 200;
const KILL_GRACE_MS = 10_000;

// A result line from any of the reporters the live tests use.
const RESULT_LINE_RES = [
  /^\s*(?:not )?ok \d+ - /, // TAP
  /^\s*[✔✖] /, // node:test spec
  /^\s*[✓×✗] /, // vitest
  /^\s*(?:Test Files|Tests)\s+\d/, // vitest totals
  /^\s*ℹ (?:tests|suites|pass|fail|cancelled|skipped|todo) \d+$/, // node:test totals
  /^\s*[a-z][a-z0-9-]*: (?:passed|failed \(exit \d+\)|timed out after \d+ min|killed by [A-Z]+|could not start .*)$/, // runner summary
];

// What would mark a leaked secret in the filtered lines.
const SECRET_RES = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /sb_secret_[A-Za-z0-9_-]{8,}/,
  /sb-[a-z0-9]+-auth-token/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /token_hash=[A-Za-z0-9_-]{8,}/,
];

const STRIP_ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
// The runner's answer to an --only it doesn't know (a usage error, exit 2).
const UNKNOWN_TEST_RE = /--only must be one of: ([a-z0-9, -]+)/;

/** Keeps only result lines; returns {lines, withheld}. */
export function filterLiveOutput(text, { secrets = [] } = {}) {
  const lines = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(STRIP_ANSI, "").replace(/\s+$/, "");
    if (!RESULT_LINE_RES.some((re) => re.test(line))) continue;
    lines.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
    if (lines.length >= MAX_LINES) break;
  }
  const joined = lines.join("\n");
  const leaked =
    SECRET_RES.some((re) => re.test(joined)) ||
    secrets.some((s) => typeof s === "string" && s.length >= 8 && joined.includes(s));
  return leaked ? { lines: [], withheld: true } : { lines, withheld: false };
}

/** The runner's outcome for <name> from its summary line, or the exit code's. */
export function outcomeFrom(lines, name, exitCode) {
  const re = new RegExp(`^\\s*${name}: (.+)$`);
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return exitCode === 0 ? "passed" : `failed (exit ${exitCode})`;
}

/**
 * The test names in the scenario's `### Live tests` section, from the shell
 * bundle's enveloped sections: one bullet (or numbered line) per name,
 * optionally in backticks. Unknown shapes are ignored; at most MAX_LIVE_TESTS.
 */
export function liveTestNames(sections) {
  const names = [];
  for (const raw of Array.isArray(sections) ? sections : []) {
    const text = String(raw).replace(/^<scenario-section>|<\/scenario-section>$/g, "");
    const lines = text.split(/\r?\n/);
    if (!/^###\s+Live tests\s*$/i.test(lines[0]?.trim() ?? "")) continue;
    for (const line of lines.slice(1)) {
      const m = /^\s*(?:[-*]|\d+[.)])\s+`?([a-z][a-z0-9-]{0,40})`?\s*$/.exec(line);
      if (m && !names.includes(m[1])) names.push(m[1]);
    }
  }
  return names.slice(0, MAX_LIVE_TESTS);
}

function run(command, args, { cwd, env, timeoutMs, spawnFn }) {
  return new Promise((resolve) => {
    let out = "";
    let size = 0;
    let timedOut = false;
    // Its own process group, so a timeout stops the runner and the test it started.
    const child = spawnFn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const take = (chunk) => {
      size += chunk.length;
      if (size <= MAX_CAPTURE_BYTES) out += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref?.();
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, out: "", error: err.code ?? "error" });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), out, signal, timedOut });
    });
  });
}

/**
 * Runs one live test for config {keyFile, envLocal, worktree, node, home,
 * tmpdir, path}. Returns {test, outcome, results, withheld?}.
 */
export async function runLiveTest(
  name,
  { config, fs = nodeFs, spawnFn = spawn, timeoutMs = LIVE_TEST_TIMEOUT_MS },
) {
  if (!LIVE_TEST_NAME_RE.test(name ?? "")) {
    return { test: String(name).slice(0, 40), outcome: "not a live-test name", results: [] };
  }
  const fail = (outcome) => ({ test: name, outcome, results: [] });
  if (keyFileProblem(config.keyFile)) return fail("not run: the dev key file isn't usable");
  if (!fs.existsSync(config.envLocal)) {
    return fail("not run: no env file with the dev anon key on the factory machine");
  }
  const runner = path.join(config.worktree, "scripts", "run-dev-live-tests.mjs");
  if (!fs.existsSync(runner)) return fail("not run: this commit has no run-dev-live-tests.mjs");
  // Read only to scan the output for it; never passed on.
  let serviceKey;
  try {
    ({ serviceRoleKey: serviceKey } = parseKeyFile(fs.readFileSync(config.keyFile, "utf8")));
  } catch {
    return fail("not run: the dev key file can't be read");
  }
  const env = {
    HOME: config.home,
    PATH: config.path,
    LANG: "C.UTF-8",
    TMPDIR: config.tmpdir,
    NO_COLOR: "1",
    CI: "1",
  };
  const r = await run(
    config.node,
    [runner, "--only", name, "--key-file", config.keyFile, "--env-local", config.envLocal],
    { cwd: config.worktree, env, timeoutMs, spawnFn },
  );
  const unknown = r.code === 2 ? UNKNOWN_TEST_RE.exec(r.out) : null;
  if (unknown) {
    return fail(`not a live test at this commit (LIVE_TESTS: ${unknown[1].trim()})`);
  }
  if (r.timedOut) return fail(`timed out after ${Math.round(timeoutMs / 60_000)} min`);
  const { lines, withheld } = filterLiveOutput(r.out, { secrets: [serviceKey] });
  serviceKey = null;
  return {
    test: name,
    outcome: withheld ? `exit ${r.code}` : outcomeFrom(lines, name, r.code),
    ...(withheld ? { withheld: "the output matched a secret pattern, so it isn't shown" } : {}),
    results: lines,
  };
}

/**
 * The supervisor's pre-session run: every name in <names>, in order, while
 * there is time before <deadlineMs>. Returns {ran: [...], skipped: [...]}.
 */
export async function runScenarioLiveTests(
  names,
  { config, deadlineMs, now = Date.now, fs = nodeFs, spawnFn = spawn },
) {
  const ran = [];
  const skipped = [];
  for (const name of names) {
    const left = deadlineMs - now();
    if (left < 60_000) {
      skipped.push({ test: name, outcome: "not run: no time left before the session" });
      continue;
    }
    ran.push(
      await runLiveTest(name, {
        config,
        fs,
        spawnFn,
        timeoutMs: Math.min(LIVE_TEST_TIMEOUT_MS, left),
      }),
    );
  }
  return { ran, skipped };
}

/**
 * The session's `live-tests [<name>]`: prints the stored result for <name>,
 * or every stored result with no name. Runs nothing.
 */
export function liveTestsMain(argv, { results }) {
  const [name, ...extra] = argv;
  if (extra.length || (name !== undefined && !LIVE_TEST_NAME_RE.test(name))) {
    return { exitCode: 2, out: { error: "usage: live-tests [<name>]" } };
  }
  if (!results) return { exitCode: 2, out: { error: "this run has no live-test results" } };
  const all = [...(results.ran ?? []), ...(results.skipped ?? [])];
  if (name === undefined) return { exitCode: 0, out: { tests: all } };
  const hit = all.find((r) => r.test === name);
  if (!hit) {
    return {
      exitCode: 2,
      out: {
        error: `${name} wasn't in the scenario's ### Live tests section, so it wasn't run`,
        ran: all.map((r) => r.test),
      },
    };
  }
  return { exitCode: hit.outcome === "passed" ? 0 : 1, out: hit };
}
