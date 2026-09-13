#!/usr/bin/env node
// CodeRabbit CLI gap-fill lane — the IO half. See ADR-0036.
//
// The PR bot on this public repo runs on CodeRabbit's OSS tier and regularly
// skips commits (rate-limited, auto-paused after two reviewed commits, the
// <10-star skip). The CLI has its OWN allowance (3/hour), so --watch fills the
// gaps: on a converged In Review PR whose head the bot did not review, it runs
// `coderabbit review --agent` against that SHA and posts the findings as review
// threads for the ADR-0035 fix loop. Every decision lives in the pure
// coderabbit-review.mjs; this file only does the IO around it.
//
// Subcommands (each prints exactly ONE JSON line on stdout and exits 0; exit 1
// only on bad argv):
//
//   gate --issue N --pr P --sha S --state-file F --repo-root R --run-root D
//        [--dry-run 0|1] [--now ISO]
//       → {action: "promote"|"hold", reason, coverage, note}. Called by --watch
//         on a card that would otherwise be promoted to In Test. May START a
//         review (always answers "hold" when it does).
//   housekeeping --state-file F --repo-root R --run-root D [--dry-run 0|1] [--now ISO]
//       → collects a finished (or dead) run: posts its findings, records the
//         coverage, removes its worktree, releases the ledger's inFlight slot.
//         A still-running run whose PR head moved on (or whose PR closed) is
//         terminated instead: {state: "terminated", reason}.
//   free-pass --issue N --state-file F      (fetch_review_threads JSON on stdin)
//       → {exempt}. True when every open thread is a CLI finding the fix loop
//         has not yet had its one attempt-free pass on.
//   note --issue N --sha S --state-file F
//       → {note}. The In Test note for coverage already recorded for exactly
//         this SHA ("" when covered, undecided or unreadable). Read-only.
//   _supervise --run-dir D                  (internal; spawned detached by gate)
//
// Why a detached supervisor rather than a synchronous call: a review takes
// 7–30+ minutes, and factory-agent-loop.sh runs --plan/--implement/--watch/
// --release sequentially under one mutex. A synchronous run would stall the
// whole factory. The supervisor survives the tick (its own session via
// detached:true → setsid), writes only inside its run dir, and NEVER touches
// git, gh or factory-state.json — the single-writer rule for the state file
// (see factory-state.mjs) stays true because every state write happens inside
// a tick. That is also why this module loads factory-state.mjs lazily: the
// supervisor path never imports it. It does import the pure coderabbit-review
// module, for the paid-flag guard it re-runs right before spawning the CLI.
//
// "Single writer" still has one exception: an operator running state-cli
// (factory:pause, factory:cr-cli-pause-until, factory:cr-cli-finish, …) while a
// tick is live. The gate and housekeeping do seconds-to-a-minute of IO, so they
// never save a copy they loaded before that IO: decisions read a snapshot, and
// every write reloads, mutates and saves in one synchronous step (mutateState).
//
// Kill switch: with FACTORY_CR_CLI != "1" the bash gate is skipped entirely,
// and housekeeping still runs but only to wind down a run started before the
// flip — it terminates or discards it, never posts and never records coverage.
//
// Cost rule: the paid-overage flag is never passed. buildReviewArgs() throws if
// it ever appears, and an on-demand billing prompt is treated as "budget
// exhausted" (a lane pause), never as something to consent to.

import { spawn } from "node:child_process";
import * as nodeFs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

export const REPO = "JakubAnderwald/drafto";
// The Mac mini's gh identity. Factory-posted CLI findings are authored by it,
// which is what lets free-pass tell them apart from a public commenter who
// pastes the marker into a thread.
export const OWNER_LOGIN = "JakubAnderwald";

// The CLI gets this environment and nothing else: no GH_TOKEN, no support-agent
// secrets. The vendor process reads a public repo's diff; it has no business
// seeing credentials. PATH is forced so `git` resolves under launchd's minimal
// PATH and Homebrew's copy wins over a stale /usr/local one.
export const ENV_ALLOWLIST = ["HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "SHELL"];
export const SUPERVISED_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const THIS_FILE = fileURLToPath(import.meta.url);
const SHA40 = /^[0-9a-f]{40}$/;
const MINUTE_MS = 60_000;
const DOCTOR_TIMEOUT_MS = 60_000;
const DOCTOR_PAUSE_MIN = 60;
const AUTH_PAUSE_MIN = 6 * 60;
// A reservation whose tick died before the spawn was attached (pid still null)
// is declared lost after this long. Five minutes is one tick: a live gate
// finishes reserve → attach in seconds.
const UNATTACHED_LOST_MS = 5 * MINUTE_MS;
// Past its deadline the supervisor should already have killed the CLI and
// exited. Ten more minutes means it is wedged: SIGTERM the process group, and
// SIGKILL it once another ten have gone by.
const OVERDUE_GRACE_MS = 10 * MINUTE_MS;
const OVERDUE_KILL_MS = 20 * MINUTE_MS;
// A finished run whose results can't be posted (the PR can't be read, or a
// comment POST keeps failing) is retried every tick — but only until this long
// past its deadline + the overdue grace. The owning card holds "cli-in-flight"
// the whole time and the lane is blocked for every other card, so a persistent
// failure must end as "cli-failed" coverage rather than a card stuck forever.
const POST_GIVE_UP_MS = 60 * MINUTE_MS;
const SUPERVISOR_KILL_GRACE_MS = 10_000;
const RUN_DIR_RETENTION_MS = 30 * 24 * 60 * MINUTE_MS;
const MAX_THREADS = 10;

let libsPromise = null;
async function libs() {
  libsPromise ??= Promise.all([
    import("./factory-state.mjs"),
    import("./coderabbit-review.mjs"),
  ]).then(([state, review]) => ({ S: state, R: review }));
  return libsPromise;
}

// ── knobs ───────────────────────────────────────────────────────────────────

function positiveInt(raw, fallback) {
  return typeof raw === "string" && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : fallback;
}

// Read once per command. A garbage override falls back to the default rather
// than disabling a guard (0 or NaN would make every budget check pass).
export function readKnobs(env = process.env) {
  return {
    maxPerHour: positiveInt(env.FACTORY_CR_CLI_MAX_PER_HOUR, 3),
    maxRunsPerCard: positiveInt(env.FACTORY_CR_CLI_MAX_RUNS_PER_CARD, 2),
    timeoutMin: positiveInt(env.FACTORY_CR_CLI_TIMEOUT_MIN, 45),
    graceMin: positiveInt(env.FACTORY_CR_BOT_GRACE_MIN, 15),
    holdMaxMin: positiveInt(env.FACTORY_CR_HOLD_MAX_MIN, 60),
    limitFallbackMin: positiveInt(env.FACTORY_CR_CLI_LIMIT_FALLBACK_MIN, 60),
  };
}

export function supervisedEnv(env = process.env) {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    if (typeof env[key] === "string") out[key] = env[key];
  }
  out.PATH = SUPERVISED_PATH;
  return out;
}

export function resolveBinary({ env = process.env, isExecutable }) {
  // An explicit override is authoritative: pointing it at a missing binary
  // means "unavailable", not "go find another one".
  if (env.FACTORY_CR_CLI_BIN) {
    return isExecutable(env.FACTORY_CR_CLI_BIN) ? env.FACTORY_CR_CLI_BIN : null;
  }
  const candidates = (env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((dir) => path.join(dir, "coderabbit"));
  // launchd's PATH is minimal, so probe the Homebrew prefixes explicitly too.
  candidates.push("/opt/homebrew/bin/coderabbit", "/usr/local/bin/coderabbit");
  return candidates.find((p) => isExecutable(p)) ?? null;
}

// ── small helpers ───────────────────────────────────────────────────────────

// Seconds precision, no millis: factory-agent.sh's iso_age_min only parses
// YYYY-MM-DDTHH:MM:SSZ.
export function isoSeconds(iso) {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function addMinutes(iso, minutes) {
  return isoSeconds(new Date(Date.parse(iso) + minutes * MINUTE_MS).toISOString());
}

export function makeRunId(issue, sha, now) {
  const stamp = isoSeconds(now).replace(/[-:]/g, "");
  return `${issue}-${sha.slice(0, 12)}-${stamp}`;
}

export function worktreePathFor(repoRoot, issue, sha) {
  return path.join(repoRoot, "worktrees", `cr-cli-${issue}-${String(sha).slice(0, 12)}`);
}

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readText(fs, file, maxBytes = Infinity) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  } catch {
    return "";
  }
}

function writeJsonAtomic(fs, file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── real dependencies ───────────────────────────────────────────────────────

// Spawn and collect, never throw: callers branch on `code`. Output is buffered
// without a cap — `gh pr diff` on a large PR outgrows execFile's maxBuffer.
function runCommand(command, args, { cwd, input, env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env ?? process.env,
        stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: err.message, timedOut: false });
      return;
    }
    const out = [];
    const errOut = [];
    let timedOut = false;
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, timeoutMs);
      timer.unref();
    }
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => errOut.push(d));
    child.once("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: err.message, timedOut });
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : (code ?? (signal ? 128 : 1)),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errOut).toString("utf8"),
        timedOut,
      });
    });
    if (input != null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

// Modelled on dispatch-release.mjs realSpawnDetached: only a confirmed 'spawn'
// counts as started, so a supervisor that could not start is reported as such
// instead of leaving the ledger waiting on a process that never existed.
async function realSpawnDetached(command, args, { cwd, logPath, env }) {
  let out = "ignore";
  try {
    out = nodeFs.openSync(logPath, "a", 0o600);
  } catch {
    out = "ignore";
  }
  const closeOut = () => {
    if (typeof out === "number") {
      try {
        nodeFs.closeSync(out);
      } catch {
        /* already closed */
      }
    }
  };
  let child;
  try {
    child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", out, out], env });
  } catch (err) {
    closeOut();
    return { ok: false, reason: err.message };
  }
  const outcome = await new Promise((resolve) => {
    child.once("spawn", () => resolve({ ok: true }));
    child.once("error", (err) => resolve({ ok: false, reason: err.message }));
  });
  // An 'error' after a successful spawn would otherwise be rethrown here.
  child.on("error", () => {});
  closeOut();
  if (!outcome.ok) return outcome;
  child.unref();
  return { ok: true, pid: child.pid };
}

function realIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function realIsExecutable(file) {
  try {
    nodeFs.accessSync(file, nodeFs.constants.X_OK);
    return nodeFs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function createDeps() {
  return {
    env: process.env,
    now: () => new Date().toISOString(),
    fs: nodeFs,
    gh: (args, { input } = {}) => runCommand("gh", args, { input }),
    git: (args, { cwd } = {}) => runCommand("git", args, { cwd }),
    spawnDetached: realSpawnDetached,
    isPidAlive: realIsPidAlive,
    isExecutable: realIsExecutable,
    psCommand: async (pid) => {
      const r = await runCommand("ps", ["-o", "command=", "-p", String(pid)]);
      return r.code === 0 ? r.stdout.trim() : "";
    },
    // Every process's full command line, or null when ps fails. `ww` so a long
    // `--run-dir` path is never cut off before the run id.
    listProcessCommands: async () => {
      const r = await runCommand("ps", ["-axww", "-o", "command="]);
      return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : null;
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    },
    // Same exit-124-on-cap convention as run-with-timeout.mjs, but with the
    // output captured: that helper inherits stdio, which would corrupt this
    // command's one-JSON-line stdout contract.
    runWithTimeout: (command, args, { timeoutMs, env } = {}) =>
      runCommand(command, args, { timeoutMs, env }).then((r) => ({
        exitCode: r.code,
        timedOut: r.timedOut,
        stdout: r.stdout,
        stderr: r.stderr,
      })),
  };
}

// ── GitHub reads ────────────────────────────────────────────────────────────

async function ghPages(deps, apiPath) {
  const r = await deps.gh(["api", "--paginate", "--slurp", apiPath]);
  if (r.code !== 0) return { ok: false, error: (r.stderr || "").trim() || `gh exited ${r.code}` };
  const pages = parseJson(r.stdout);
  if (!Array.isArray(pages)) return { ok: false, error: "unparseable gh api output" };
  return { ok: true, items: pages.flat() };
}

export async function fetchBotActivity(pr, deps) {
  const [comments, reviews] = await Promise.all([
    ghPages(deps, `repos/${REPO}/issues/${pr}/comments?per_page=100`),
    ghPages(deps, `repos/${REPO}/pulls/${pr}/reviews?per_page=100`),
  ]);
  if (!comments.ok || !reviews.ok) {
    return { ok: false, error: comments.error ?? reviews.error };
  }
  return { ok: true, comments: comments.items, reviews: reviews.items };
}

// {state, headRefOid} of the PR, or null when it can't be read or parsed.
async function readPrHead(pr, deps) {
  const r = await deps.gh(["pr", "view", String(pr), "--repo", REPO, "--json", "state,headRefOid"]);
  const view = r.code === 0 ? parseJson(r.stdout) : null;
  if (!view || typeof view.state !== "string" || typeof view.headRefOid !== "string") return null;
  return view;
}

// ── state helpers ───────────────────────────────────────────────────────────

function crCliStatus(S, state, now) {
  S.clearExpiredCrCliPause(state, now);
  const ledger = S.getCrCli(state);
  return {
    ...ledger,
    ...S.crCliUsage(state, { now }),
    paused: S.isCrCliPaused(state, now),
  };
}

function recordCoverage(S, state, issue, sha, coverage) {
  S.setIssueField(state, issue, "crCoverageSha", sha);
  S.setIssueField(state, issue, "crCoverage", coverage);
}

// Reload → mutate → save, with nothing awaited in between, so a concurrent
// operator write is only lost if it lands inside those few milliseconds — the
// same window state-cli's own writes have. `fn` gets the fresh copy and must be
// synchronous; returning false skips the save. Returns whatever `fn` returned.
export async function mutateState(S, stateFile, fn) {
  const fresh = await S.loadFactoryState(stateFile);
  const out = fn(fresh);
  if (out && typeof out.then === "function") {
    throw new Error("mutateState: fn must be synchronous (no IO between reload and save)");
  }
  if (out !== false) await S.saveFactoryState(fresh, stateFile);
  return out;
}

// Never shorten or relabel a pause that already runs at least as long — e.g. an
// operator's factory:cr-cli-pause-until that landed while this tick did IO.
function pauseLaneAtLeast(S, state, { until, reason, now }) {
  const current = Date.parse(S.getCrCli(state).pausedUntil ?? "");
  if (S.isCrCliPaused(state, now) && current >= Date.parse(until)) return;
  S.pauseCrCli(state, { until, reason });
}

// Release a run on a fresh copy, applying its outcome writes in the same save.
// Skipped entirely when the ledger no longer holds this run: an operator's
// factory:cr-cli-finish got there first, and its decision stands.
async function finishRun(S, stateFile, runId, { refund, now, writes = [] }) {
  const out = await mutateState(S, stateFile, (s) => {
    if (S.getCrCli(s).inFlight?.runId !== runId) return false;
    for (const write of writes) write(s);
    S.finishCrCliRun(s, runId, { refund, now });
    return true;
  });
  return out === true;
}

// ── gate ────────────────────────────────────────────────────────────────────

export async function runGate(opts, deps) {
  const { S, R } = await libs();
  const { issue, pr, sha, stateFile } = opts;
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now ?? deps.now();
  const knobs = readKnobs(deps.env);

  // A snapshot for DECISIONS only — never saved. The gate reads GitHub, runs
  // doctor and prepares a worktree before it writes anything, and saving a copy
  // loaded before all that would silently undo an operator's factory:pause or
  // lane pause that landed meanwhile. Writes go through persist → mutateState.
  const snapshot = await S.loadFactoryState(stateFile);
  const rec = S.getIssue(snapshot, issue);
  // The grace and hold clocks start the first time this SHA reaches the gate —
  // i.e. green CI, reviewed by the Claude stage, no open threads. GitHub has no
  // reliable push time to anchor on (committedDate is client-set).
  const convergedAt = rec.crConvergedSha === sha ? rec.crConvergedAt : isoSeconds(now);
  if (rec.crConvergedSha !== sha) {
    S.setIssueField(snapshot, issue, "crConvergedSha", sha);
    S.setIssueField(snapshot, issue, "crConvergedAt", convergedAt);
  }
  // The gate's bookkeeping (converge anchor, expired lane pause) plus `mutate`,
  // applied to a fresh copy. Saves only when something actually changed.
  const bookkeep = (s) => {
    let changed = false;
    if (S.getIssue(s, issue).crConvergedSha !== sha) {
      S.setIssueField(s, issue, "crConvergedSha", sha);
      S.setIssueField(s, issue, "crConvergedAt", convergedAt);
      changed = true;
    }
    return S.clearExpiredCrCliPause(s, now) || changed;
  };
  const persist = async (mutate = null) => {
    if (dryRun) return;
    await mutateState(S, stateFile, (s) => {
      const changed = bookkeep(s);
      if (mutate) mutate(s);
      return changed || Boolean(mutate);
    });
  };
  const status = crCliStatus(S, snapshot, now);
  const answer = (action, reason, coverage = null, note = "") => ({
    action,
    reason,
    coverage,
    note,
  });

  // Coverage already decided, or a run already in flight for this exact SHA:
  // the decision needs no GitHub read, so a card held for an hour does not cost
  // two API calls every tick.
  const inFlightHere =
    status.inFlight &&
    String(status.inFlight.issue) === String(issue) &&
    status.inFlight.sha === sha;
  let bot = { state: "absent", coveredHeads: [] };
  if (rec.crCoverageSha !== sha && !inFlightHere) {
    const activity = await fetchBotActivity(pr, deps);
    if (!activity.ok) {
      // Unknown bot state: wait (bounded by the hold cap) rather than guess —
      // guessing "gap" would spend CLI quota on a SHA the bot may have covered.
      const holdDeadline = Date.parse(rec.crConvergedAt) + knobs.holdMaxMin * MINUTE_MS;
      if (dryRun) {
        return answer("promote", `dry-run:bot-activity-unavailable (${activity.error})`);
      }
      if (Date.parse(now) < holdDeadline) {
        await persist();
        return answer("hold", "bot-activity-unavailable");
      }
      await persist((s) => recordCoverage(S, s, issue, sha, "hold-expired"));
      return answer("promote", "hold-expired", "hold-expired", R.coverageNote("hold-expired", sha));
    }
    bot = R.classifyBotCoverage({
      comments: activity.comments,
      reviews: activity.reviews,
      headSha: sha,
    });
  }

  const bin = resolveBinary({ env: deps.env, isExecutable: deps.isExecutable });
  const decision = R.decideLane({
    sha,
    issueNumber: issue,
    issue: rec,
    crCli: status,
    bot,
    binaryAvailable: Boolean(bin),
    knobs,
    now,
    dryRun,
  });

  if (decision.action === "promote") {
    await persist(
      decision.record ? (s) => recordCoverage(S, s, issue, sha, decision.record) : null,
    );
    const coverage = decision.record ?? (rec.crCoverageSha === sha ? rec.crCoverage : null);
    const note =
      decision.note || (decision.record ? R.coverageNote(decision.record, sha) : "") || "";
    return answer("promote", decision.reason, coverage, note);
  }
  if (decision.action === "hold" || dryRun) {
    await persist();
    return dryRun
      ? answer("promote", `dry-run:${decision.reason}`)
      : answer("hold", decision.reason);
  }

  return startRun({ S, R, rec, bot, bin, knobs, now, opts, deps, persist, bookkeep, answer });
}

async function startRun({
  S,
  R,
  rec,
  bot,
  bin,
  knobs,
  now,
  opts,
  deps,
  persist,
  bookkeep,
  answer,
}) {
  const { issue, pr, sha, stateFile, repoRoot, runRoot } = opts;

  // doctor first: an expired login or an unreachable backend should pause the
  // lane (→ cards promote with "cli-unavailable"), not burn a reservation. This
  // card promotes the same way in this same tick: the pause already means the
  // CLI won't review its commit, so holding it one more tick would only delay it.
  const doctor = await deps.runWithTimeout(bin, ["doctor"], {
    timeoutMs: DOCTOR_TIMEOUT_MS,
    env: supervisedEnv(deps.env),
  });
  if (doctor.exitCode !== 0) {
    await persist((s) => {
      pauseLaneAtLeast(S, s, { until: addMinutes(now, DOCTOR_PAUSE_MIN), reason: "doctor", now });
      recordCoverage(S, s, issue, sha, "cli-unavailable");
    });
    return answer(
      "promote",
      `cli-doctor-failed (exit ${doctor.exitCode})`,
      "cli-unavailable",
      R.coverageNote("cli-unavailable", sha),
    );
  }

  // Reserve on a fresh copy, re-checking what the snapshot decided on: an
  // operator may have paused the factory or the lane during doctor, or a run
  // may be in flight after all. Any of those → hold and write nothing.
  const runId = makeRunId(issue, sha, now);
  let refused = null;
  let reservation = null;
  await mutateState(S, stateFile, (s) => {
    if (S.isFactoryPaused(s, now)) refused = "factory-paused";
    else if (S.isCrCliPaused(s, now)) refused = "paused";
    else if (S.getCrCli(s).inFlight) refused = "busy";
    if (refused) return false;
    bookkeep(s);
    reservation = S.reserveCrCliRun(s, {
      issue,
      sha,
      pr,
      runId,
      maxPerHour: knobs.maxPerHour,
      now,
    });
    return true;
  });
  if (refused) return answer("hold", `cli-reserve-${refused}`);
  if (!reservation.ok) return answer("hold", `cli-reserve-${reservation.reason}`);
  // The reservation is saved BEFORE any side effect: a tick that dies from here
  // on leaves an unattached inFlight that housekeeping declares lost, instead
  // of a CLI process nobody is accounting for.

  const worktree = worktreePathFor(repoRoot, issue, sha);
  let spawned = null;
  try {
    await prepareWorktree({ repoRoot, pr, sha, worktree }, deps);
    const base = await pickBase({ repoRoot, sha, rec, bot }, deps, R);
    const args = R.buildReviewArgs({ baseSha: base.baseSha });
    const runDir = path.join(runRoot, runId);
    deps.fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    deps.fs.chmodSync(runDir, 0o700);
    const deadlineAt = addMinutes(now, knobs.timeoutMin);
    const meta = {
      runId,
      bin,
      args,
      cwd: worktree,
      deadlineAt,
      issue: String(issue),
      pr: String(pr),
      sha,
      baseSha: base.baseSha,
      mode: base.mode,
    };
    writeJsonAtomic(deps.fs, path.join(runDir, "meta.json"), meta);
    spawned = await deps.spawnDetached(
      process.execPath,
      [THIS_FILE, "_supervise", "--run-dir", runDir],
      { cwd: runDir, logPath: path.join(runDir, "supervisor.log"), env: supervisedEnv(deps.env) },
    );
    if (!spawned.ok) throw new Error(`supervisor failed to start: ${spawned.reason}`);
    const attached = await mutateState(S, stateFile, (s) =>
      S.attachCrCliRun(s, runId, {
        pid: spawned.pid,
        baseSha: base.baseSha,
        mode: base.mode,
        deadlineAt,
        runDir,
        worktree,
      }),
    );
    if (!attached) {
      // The reservation was released while we prepared (an operator's
      // factory:cr-cli-finish). Nothing accounts for this supervisor any more,
      // and housekeeping would reap its worktree from under it: stop it now.
      deps.kill(-spawned.pid, "SIGTERM");
      await removeWorktree(repoRoot, worktree, deps);
      return answer("hold", "cli-start-abandoned (reservation released meanwhile)");
    }
    return answer("hold", `cli-started (${base.mode} vs ${base.baseSha.slice(0, 12)})`);
  } catch (err) {
    // A supervisor that did start (the attach write is what threw) is stopped
    // first, exactly as the !attached branch does: otherwise it keeps reviewing
    // a worktree about to be deleted, with nothing left to collect its results.
    if (spawned?.ok) deps.kill(-spawned.pid, "SIGTERM");
    // The review never got going, so nothing was spent: give back both the
    // hourly slot and the card's run.
    await mutateState(S, stateFile, (s) => S.finishCrCliRun(s, runId, { refund: "spawn", now }).ok);
    await removeWorktree(repoRoot, worktree, deps);
    return answer("hold", `cli-start-failed: ${err.message}`);
  }
}

async function gitOrThrow(deps, args, cwd, what) {
  const r = await deps.git(args, { cwd });
  if (r.code !== 0) {
    throw new Error(`${what} failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`);
  }
  return r.stdout.trim();
}

// Its own detached worktree: not $REPO_ROOT (factory-agent-loop.sh resets it to
// origin/main every tick, under a 30-minute run) and not the card worktree (the
// fix loop mutates it). No .env copy — the vendor reads this tree.
async function prepareWorktree({ repoRoot, pr, sha, worktree }, deps) {
  await gitOrThrow(
    deps,
    ["fetch", "--quiet", "origin", `pull/${pr}/head`],
    repoRoot,
    "fetch PR head",
  );
  await gitOrThrow(deps, ["fetch", "--quiet", "origin", "main"], repoRoot, "fetch main");
  if (deps.fs.existsSync(worktree)) await removeWorktree(repoRoot, worktree, deps);
  await gitOrThrow(deps, ["worktree", "add", "--detach", worktree, sha], repoRoot, "worktree add");
  const head = await gitOrThrow(deps, ["rev-parse", "HEAD"], worktree, "rev-parse");
  if (head !== sha) throw new Error(`worktree HEAD ${head} != ${sha}`);
}

// Incremental when a CodeRabbit-reviewed ancestor exists (the CLI then reviews
// exactly the commits nobody reviewed); full against the merge-base otherwise.
async function pickBase({ repoRoot, sha, rec, bot }, deps, R) {
  const mergeBase = await gitOrThrow(
    deps,
    ["merge-base", "origin/main", sha],
    repoRoot,
    "merge-base",
  );
  const candidates = [
    ...new Set(
      [rec.crLastCoveredSha, ...(bot.coveredHeads ?? [])].filter((c) => SHA40.test(c ?? "")),
    ),
  ].filter((c) => c !== sha);
  const info = new Map();
  for (const c of candidates) {
    const exists = await deps.git(["cat-file", "-e", `${c}^{commit}`], { cwd: repoRoot });
    if (exists.code !== 0) continue; // force-pushed away
    const ancestor = await deps.git(["merge-base", "--is-ancestor", c, sha], { cwd: repoRoot });
    if (ancestor.code !== 0) continue;
    const count = await deps.git(["rev-list", "--count", `${c}..${sha}`], { cwd: repoRoot });
    const merges = await deps.git(["rev-list", "--merges", `${c}..${sha}`], { cwd: repoRoot });
    info.set(c, {
      distance: count.code === 0 ? Number(count.stdout.trim()) : Infinity,
      // An update-branch merge in range would drag all of main into the review.
      hasMerges: merges.code !== 0 || merges.stdout.trim() !== "",
    });
  }
  return R.chooseBase({
    candidates,
    headSha: sha,
    isAncestor: (c) => info.has(c),
    distance: (c) => info.get(c)?.distance ?? Infinity,
    hasMerges: (c) => info.get(c)?.hasMerges ?? true,
    mergeBase,
  });
}

async function removeWorktree(repoRoot, worktree, deps) {
  if (!worktree) return;
  await deps.git(["worktree", "remove", "--force", worktree], { cwd: repoRoot });
  if (deps.fs.existsSync(worktree)) {
    try {
      deps.fs.rmSync(worktree, { recursive: true, force: true });
    } catch {
      /* reaped on a later tick */
    }
  }
  await deps.git(["worktree", "prune"], { cwd: repoRoot });
}

// ── supervisor (detached) ───────────────────────────────────────────────────

export async function runSupervise({ runDir }, { env = process.env } = {}) {
  const { assertNoPaidFlags } = await import("./coderabbit-review.mjs");
  return new Promise((resolve) => {
    const meta = JSON.parse(nodeFs.readFileSync(path.join(runDir, "meta.json"), "utf8"));
    const exitFile = path.join(runDir, "exit.json");
    let settled = false;
    let timedOut = false;
    let child = null;
    const finish = (exitCode, signal, extra = {}) => {
      if (settled) return;
      settled = true;
      writeJsonAtomic(nodeFs, exitFile, {
        exitCode,
        signal: signal ?? null,
        timedOut,
        endedAt: isoSeconds(new Date().toISOString()),
        ...extra,
      });
      resolve({ exitCode, signal, timedOut });
    };

    // buildReviewArgs already refused the paid-overage flag, but what runs here
    // is whatever meta.json says by now — a file on disk, not that array. The
    // guard belongs at the one place the vendor process is actually started.
    try {
      assertNoPaidFlags([meta.bin, ...(Array.isArray(meta.args) ? meta.args : [meta.args])]);
    } catch {
      finish(1, null, { error: "paid-flag-refused" });
      return;
    }

    const out = nodeFs.openSync(path.join(runDir, "events.ndjson"), "a", 0o600);
    const err = nodeFs.openSync(path.join(runDir, "stderr.log"), "a", 0o600);
    try {
      child = spawn(meta.bin, meta.args, {
        cwd: meta.cwd,
        env: supervisedEnv(env),
        stdio: ["ignore", out, err],
      });
    } catch (e) {
      finish(127, null, { error: e.message });
      return;
    }
    nodeFs.closeSync(out);
    nodeFs.closeSync(err);

    const terminate = () => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), SUPERVISOR_KILL_GRACE_MS).unref();
    };
    const deadlineMs = Math.max(0, Date.parse(meta.deadlineAt) - Date.now());
    const deadline = setTimeout(terminate, deadlineMs);

    // housekeeping's overdue kill signals the whole process group; still write
    // exit.json so the run is collected as a timeout rather than "lost".
    const onSignal = () => {
      terminate();
      setTimeout(() => finish(null, "SIGTERM"), SUPERVISOR_KILL_GRACE_MS + 1000).unref();
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGHUP", onSignal);

    child.once("error", (e) => {
      clearTimeout(deadline);
      finish(127, null, { error: e.message });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGHUP", onSignal);
      finish(code, signal);
    });
  });
}

// ── housekeeping ────────────────────────────────────────────────────────────

export async function pollRun(inFlight, { now }, deps) {
  const exitFile = inFlight.runDir ? path.join(inFlight.runDir, "exit.json") : null;
  if (exitFile && deps.fs.existsSync(exitFile)) {
    const exit = parseJson(readText(deps.fs, exitFile), null);
    if (exit) return { state: "done", exit };
  }
  if (inFlight.pid == null) {
    const age = Date.parse(now) - Date.parse(inFlight.startedAt ?? now);
    return age >= UNATTACHED_LOST_MS ? { state: "lost", unattached: true } : { state: "starting" };
  }
  if (deps.isPidAlive(inFlight.pid)) {
    // pid reuse after a reboot: only trust a live pid whose command line is
    // this run's supervisor.
    const command = await deps.psCommand(inFlight.pid);
    if (command.includes(inFlight.runId)) {
      const pastDeadline = Date.parse(now) - Date.parse(inFlight.deadlineAt ?? now);
      if (pastDeadline >= OVERDUE_GRACE_MS) {
        return {
          state: "overdue",
          signal: pastDeadline >= OVERDUE_KILL_MS ? "SIGKILL" : "SIGTERM",
        };
      }
      return { state: "running" };
    }
  }
  const events = inFlight.runDir
    ? readText(deps.fs, path.join(inFlight.runDir, "events.ndjson"))
    : "";
  // The supervisor died but the CLI had already reported completion: salvage.
  if (/"type"\s*:\s*"complete"/.test(events)) {
    return { state: "done", exit: { exitCode: 0, signal: null, timedOut: false, salvaged: true } };
  }
  return { state: "lost" };
}

export async function runHousekeeping(opts, deps) {
  const { S, R } = await libs();
  const { stateFile, repoRoot, runRoot } = opts;
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now ?? deps.now();
  const knobs = readKnobs(deps.env);

  // The kill switch (FACTORY_CR_CLI, validated and exported by factory-agent.sh).
  // Anything but "1" is off: a run started before the flip is wound down here,
  // never collected, since its card may already have been promoted without it.
  const laneOn = deps.env?.FACTORY_CR_CLI === "1";
  // …and a run whose SHA the gate has already decided (e.g. promoted as
  // cli-in-flight-expired after collection kept failing) is wound down the same
  // way: its results would open threads on a card that has moved on, and flip a
  // recorded "did not review" into "cli" behind the tester's back.

  // A snapshot for DECISIONS only — never saved; see mutateState. Collecting a
  // run means a PR read, several comment fetches, up to eleven POSTs and a
  // worktree removal, all before the ledger is written.
  const snapshot = await S.loadFactoryState(stateFile);
  const inFlight = S.getCrCli(snapshot).inFlight;
  if (!inFlight) {
    const reaped = dryRun
      ? { worktrees: [], runDirs: [] }
      : await reap({ repoRoot, runRoot, inFlight, now }, deps);
    return { state: "idle", reaped };
  }

  const base = { runId: inFlight.runId, issue: inFlight.issue, sha: inFlight.sha };
  const worktree = inFlight.worktree ?? worktreePathFor(repoRoot, inFlight.issue, inFlight.sha);
  const decidedSha = String(snapshot.issues?.[String(inFlight.issue)]?.crCoverageSha ?? "");
  const windDown = !laneOn
    ? "lane-off"
    : decidedSha && decidedSha.toLowerCase() === String(inFlight.sha ?? "").toLowerCase()
      ? "already-decided"
      : null;
  const poll = await pollRun(inFlight, { now }, deps);
  if (!windDown && !dryRun && (poll.state === "running" || poll.state === "overdue")) {
    // A run whose PR head moved on can now only end in a stale, thread-less
    // summary, yet it holds the lane's only slot for up to its full timeout
    // while the new head waits at cli-busy. One cheap PR read per tick frees
    // the lane as soon as that happens. An unreadable PR changes nothing.
    const view = await readPrHead(inFlight.pr, deps);
    const why = !view
      ? null
      : view.state !== "OPEN"
        ? "pr-closed"
        : view.headRefOid !== inFlight.sha
          ? "head-moved"
          : null;
    if (why) {
      const signal = poll.signal ?? "SIGTERM";
      deps.kill(-inFlight.pid, signal);
      await removeWorktree(repoRoot, worktree, deps);
      // "card": the vendor review did start, so its hourly slot stays spent,
      // but a run made pointless by a push must not use up the card's run cap.
      const finished = await finishRun(S, stateFile, inFlight.runId, { refund: "card", now });
      const reaped = await reap({ repoRoot, runRoot, inFlight: null, now }, deps);
      return {
        ...base,
        state: "terminated",
        reason: why,
        signal,
        refund: "card",
        ...(finished ? {} : { finishedElsewhere: true }),
        reaped,
      };
    }
  }
  if (poll.state === "starting" || (!windDown && poll.state === "running")) {
    if (!dryRun) await reap({ repoRoot, runRoot, inFlight, now }, deps);
    return { ...base, state: poll.state };
  }
  if (!windDown && poll.state === "overdue") {
    if (!dryRun) deps.kill(-inFlight.pid, poll.signal);
    return { ...base, state: "overdue", signal: poll.signal };
  }

  // A reservation whose supervisor never started never reached the vendor:
  // refund it like a failed spawn and let the gate try again.
  if (poll.unattached) {
    if (dryRun) return { ...base, state: "lost", outcome: "unattached" };
    await removeWorktree(repoRoot, worktree, deps);
    const finished = await finishRun(S, stateFile, inFlight.runId, { refund: "spawn", now });
    return {
      ...base,
      state: "lost",
      outcome: "unattached",
      refund: "spawn",
      ...(finished ? {} : { finishedElsewhere: true }),
    };
  }

  if (windDown) {
    // Lane switched off, or the SHA already decided: posting now would open
    // threads on a card that may be In Test already (--release would then bounce
    // it back for re-approval). Stop a live supervisor the way the overdue path
    // does, discard whatever a finished one produced, and free the slot and the
    // worktree.
    const result = { ...base, state: poll.state, discarded: windDown };
    if (dryRun) return { ...result, dryRun: true };
    if (poll.state === "running" || poll.state === "overdue") {
      result.signal = poll.signal ?? "SIGTERM";
      deps.kill(-inFlight.pid, result.signal);
    }
    await removeWorktree(repoRoot, worktree, deps);
    const finished = await finishRun(S, stateFile, inFlight.runId, { refund: "none", now });
    if (!finished) result.finishedElsewhere = true;
    const reaped = await reap({ repoRoot, runRoot, inFlight: null, now }, deps);
    return { ...result, refund: "none", reaped };
  }

  // A malformed in-flight record can lack runDir (pollRun already tolerates
  // that). Throwing here would fail every tick and never reach finishRun, so
  // the run is classified from nothing (→ a failed run) and cleaned up.
  const runDir = typeof inFlight.runDir === "string" && inFlight.runDir ? inFlight.runDir : null;
  const eventsText = runDir ? readText(deps.fs, path.join(runDir, "events.ndjson")) : "";
  const events = R.parseEvents(eventsText);
  const exit = poll.exit ?? { exitCode: null, signal: null, timedOut: false };
  const classified = R.classifyOutcome({
    exitCode: exit.exitCode,
    signal: exit.signal,
    timedOut: Boolean(exit.timedOut),
    events,
    stderr: runDir ? readText(deps.fs, path.join(runDir, "stderr.log"), 64 * 1024) : "",
    now,
    fallbackMin: knobs.limitFallbackMin,
  });
  const outcome = classified.outcome;
  const result = { ...base, state: poll.state, outcome };
  if (dryRun) return { ...result, dryRun: true };

  // Every ledger/issue write this collection decides on, applied together with
  // the finish in one reload → mutate → save (finishRun).
  const writes = [];
  const recordFailed = () =>
    writes.push((s) => recordCoverage(S, s, inFlight.issue, inFlight.sha, "cli-failed"));
  let refund = "none";
  if (outcome === "rate_limited" || outcome === "action_required") {
    // Never consent to on-demand billing: an action_required prompt is a
    // budget signal exactly like a rate limit.
    const until = classified.retryAt ?? addMinutes(now, knobs.limitFallbackMin);
    writes.push((s) => pauseLaneAtLeast(S, s, { until, reason: outcome, now }));
    refund = "card";
  } else if (outcome === "auth") {
    const until = addMinutes(now, AUTH_PAUSE_MIN);
    writes.push((s) => pauseLaneAtLeast(S, s, { until, reason: "auth", now }));
    refund = "card";
  } else if (outcome === "transient") {
    refund = "card";
  } else {
    // Posting failures are retried on later ticks, but not forever: past this
    // point the run is written off as cli-failed so its card can promote.
    const anchorMs = Date.parse(inFlight.deadlineAt ?? inFlight.startedAt ?? "");
    const givingUp = Number.isFinite(anchorMs)
      ? Date.parse(now) > anchorMs + OVERDUE_GRACE_MS + POST_GIVE_UP_MS
      : true;
    const view = await readPrHead(inFlight.pr, deps);
    if (!view) {
      if (!givingUp) return { ...result, deferred: "pr-view-failed" };
      // The PR can't be read, so head and open-state are unknown. Record the
      // failure anyway: the run is spent and this SHA won't be reviewed again.
      result.abandoned = "pr-view-failed";
      recordFailed();
    } else {
      const open = view.state === "OPEN";
      const headSame = view.headRefOid === inFlight.sha;

      if (outcome === "ok" || outcome === "empty") {
        if (open) {
          const posted = await postFindings(
            {
              pr: inFlight.pr,
              sha: inFlight.sha,
              baseSha: inFlight.baseSha,
              runMode: inFlight.mode ?? "full",
              mode: headSame ? "inline" : "summary-only",
              events,
              outcome,
              stale: !headSame,
            },
            deps,
          );
          if (!posted.ok) {
            // Leave inFlight (and the worktree) in place: posting is idempotent,
            // so the next tick simply tries again — until the give-up point.
            if (!givingUp) return { ...result, deferred: "post-failed", detail: posted.reason };
            result.abandoned = posted.reason;
            if (headSame) recordFailed();
          } else {
            result.posted = posted;
            if (headSame) {
              // "cli-partial" is an uncovered kind: a threaded-severity finding
              // that only made the summary is one nothing downstream acts on
              // (the fix loop reads threads), so the tester has to be told.
              const coverage =
                events.findings.length === 0
                  ? "cli-empty"
                  : posted.partial || classified.incomplete
                    ? "cli-partial"
                    : "cli";
              writes.push((s) => {
                S.setIssueField(s, inFlight.issue, "crLastCoveredSha", inFlight.sha);
                recordCoverage(S, s, inFlight.issue, inFlight.sha, coverage);
              });
            }
          }
        }
      } else if (open && headSame) {
        recordFailed();
      }
    }
  }

  await removeWorktree(repoRoot, worktree, deps);
  const finished = await finishRun(S, stateFile, inFlight.runId, { refund, now, writes });
  if (!finished) result.finishedElsewhere = true;
  const reaped = await reap({ repoRoot, runRoot, inFlight: null, now }, deps);
  return { ...result, refund, reaped };
}

async function reap({ repoRoot, runRoot, inFlight, now }, deps) {
  const reaped = { worktrees: [], runDirs: [] };
  const keepWorktrees = new Set();
  if (inFlight) {
    if (inFlight.worktree) keepWorktrees.add(inFlight.worktree);
    keepWorktrees.add(worktreePathFor(repoRoot, inFlight.issue, inFlight.sha));
  }
  const wtRoot = path.join(repoRoot, "worktrees");
  let entries = [];
  try {
    entries = deps.fs.readdirSync(wtRoot);
  } catch {
    entries = [];
  }
  let runs = [];
  try {
    runs = deps.fs.readdirSync(runRoot);
  } catch {
    runs = [];
  }

  const candidates = entries
    .filter((name) => name.startsWith("cr-cli-"))
    .map((name) => path.join(wtRoot, name))
    .filter((full) => !keepWorktrees.has(full));
  const live = candidates.length
    ? await liveRunWorktrees({ runRoot, runs, candidates }, deps)
    : new Set();
  for (const full of candidates) {
    if (live.has(full)) continue;
    await removeWorktree(repoRoot, full, deps);
    reaped.worktrees.push(full);
  }

  for (const name of runs) {
    const full = path.join(runRoot, name);
    if (inFlight?.runDir === full) continue;
    try {
      const age = Date.parse(now) - deps.fs.statSync(full).mtimeMs;
      if (age > RUN_DIR_RETENTION_MS) {
        deps.fs.rmSync(full, { recursive: true, force: true });
        reaped.runDirs.push(full);
      }
    } catch {
      /* vanished mid-scan */
    }
  }
  return reaped;
}

// The candidate worktrees a still-running supervisor is reviewing. The ledger
// is not proof of orphanhood: factory:cr-cli-finish (or a lost state file)
// drops the inFlight record, and until the supervisor has actually exited,
// deleting its tree leaves a vendor review running on nothing, whose results
// nobody collects. A run dir's meta.json names its worktree (cwd), and the
// supervisor's command line carries the run id (`--run-dir …/<runId>`), which
// also rules out a reused pid. An unreadable process table keeps every tree a
// run dir claims; the next tick looks again.
async function liveRunWorktrees({ runRoot, runs, candidates }, deps) {
  const wanted = new Map(candidates.map((c) => [path.resolve(c), c]));
  const runIdsByWorktree = new Map();
  for (const name of runs) {
    const meta = parseJson(readText(deps.fs, path.join(runRoot, name, "meta.json")), null);
    const worktree = typeof meta?.cwd === "string" ? wanted.get(path.resolve(meta.cwd)) : null;
    if (!worktree) continue;
    const runId = typeof meta.runId === "string" && meta.runId ? meta.runId : name;
    runIdsByWorktree.set(worktree, [...(runIdsByWorktree.get(worktree) ?? []), runId]);
  }
  const live = new Set();
  if (runIdsByWorktree.size === 0) return live;
  const commands = await deps.listProcessCommands();
  for (const [worktree, runIds] of runIdsByWorktree) {
    if (!Array.isArray(commands) || runIds.some((id) => commands.some((c) => c.includes(id)))) {
      live.add(worktree);
    }
  }
  return live;
}

// ── posting ─────────────────────────────────────────────────────────────────

function isValidationError(r) {
  return /HTTP 422|Unprocessable|Validation Failed/i.test(`${r.stderr}\n${r.stdout}`);
}

async function ghPost(deps, apiPath, payload) {
  // JSON on stdin: vendor text never travels through argv.
  return deps.gh(["api", "--method", "POST", apiPath, "--input", "-"], {
    input: JSON.stringify(payload),
  });
}

const REVIEW_THREADS_QUERY =
  "query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated path line comments(first:100){nodes{databaseId}}}}}}}";
const MAX_THREAD_PAGES = 20;

// Read-only. REST review comments carry no resolved/outdated flag, so the
// thread state comes from GraphQL and is joined back by comment databaseId.
// A comment beyond a thread's first 100 simply stays unjoined (state unknown),
// which planFindings treats as "never demotes".
export async function fetchReviewThreads(pr, deps) {
  const [owner, repo] = REPO.split("/");
  const threads = [];
  let cursor = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const args = ["api", "graphql", "-f", `owner=${owner}`, "-f", `repo=${repo}`];
    args.push("-F", `number=${pr}`, "-f", `query=${REVIEW_THREADS_QUERY}`);
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const r = await deps.gh(args);
    if (r.code !== 0) return { ok: false, error: (r.stderr || "").trim() || `gh exited ${r.code}` };
    const conn = parseJson(r.stdout)?.data?.repository?.pullRequest?.reviewThreads;
    if (!conn || !Array.isArray(conn.nodes)) {
      return { ok: false, error: "unparseable reviewThreads output" };
    }
    threads.push(...conn.nodes.filter((t) => t && typeof t === "object"));
    if (!conn.pageInfo?.hasNextPage) return { ok: true, threads };
    cursor = conn.pageInfo.endCursor;
    if (!cursor) return { ok: false, error: "reviewThreads page without endCursor" };
  }
  return { ok: false, error: `more than ${MAX_THREAD_PAGES} pages of review threads` };
}

// Only the factory's own identity and the authenticated CodeRabbit App speak
// for the PR. On a public repo anyone can comment, and a stranger's comment must
// not be able to de-dup a finding away or divert it from a thread.
function isTrustedAuthor(R, item) {
  return item?.user?.login === OWNER_LOGIN || R.isTrustedBotItem(item);
}

// REST review comments → planFindings' existingComments: trusted authors only,
// each carrying its thread's current line and flags (null when unknown), plus
// REST's original_line. The fp de-dup falls back to that when the thread line is
// unknown (outdated, or no thread state): without it an fp posted far from a new
// finding's line would still suppress it as "already answered".
function toExistingComments(R, reviewComments, threads) {
  const byCommentId = new Map();
  for (const t of threads ?? []) {
    for (const c of t.comments?.nodes ?? []) {
      if (Number.isInteger(c?.databaseId)) byCommentId.set(c.databaseId, t);
    }
  }
  return reviewComments
    .filter((c) => isTrustedAuthor(R, c))
    .map((c) => {
      const t = byCommentId.get(c.id);
      return {
        path: t?.path ?? c.path,
        line: t && Number.isInteger(t.line) ? t.line : null,
        original_line: Number.isInteger(c.original_line) ? c.original_line : null,
        body: c.body ?? "",
        trusted: true,
        resolved: t ? t.isResolved === true : null,
        outdated: t ? t.isOutdated === true : null,
      };
    });
}

// Idempotent by construction: a finding whose fingerprint is already on the PR
// is skipped by planFindings, and the summary is only posted when its SHA-scoped
// marker is absent. A tick that dies mid-post re-runs this safely.
export async function postFindings(opts, deps) {
  const { R } = await libs();
  const {
    pr,
    sha,
    baseSha,
    runMode = "full",
    mode = "inline",
    events,
    outcome,
    stale = false,
  } = opts;

  const [reviewComments, issueComments] = await Promise.all([
    ghPages(deps, `repos/${REPO}/pulls/${pr}/comments?per_page=100`),
    ghPages(deps, `repos/${REPO}/issues/${pr}/comments?per_page=100`),
  ]);
  if (!reviewComments.ok || !issueComments.ok) {
    return {
      ok: false,
      reason: `comment fetch failed: ${reviewComments.error ?? issueComments.error}`,
    };
  }

  // A stale run's line numbers no longer match the PR head: list, don't thread.
  const planMode = mode === "inline" ? runMode : "summary-only";
  const threadSeverities =
    planMode === "incremental" ? R.SEVERITIES_INCREMENTAL : R.SEVERITIES_FULL;
  const canThread =
    planMode !== "summary-only" &&
    events.findings.some((f) => threadSeverities.includes(String(f?.severity ?? "").toLowerCase()));

  const extra = {};
  let hunks = new Map();
  let threads = null;
  if (canThread) {
    // The diff only anchors LINE threads. GitHub refuses it outright past
    // 20,000 lines or 300 files, which no retry fixes — and that is exactly the
    // PR most likely to carry criticals. So a failure opens the threads at file
    // level instead (subject_type "file" needs no hunk) rather than failing the
    // post or burying them in a summary nothing acts on.
    const diff = await deps.gh(["pr", "diff", String(pr), "--repo", REPO]);
    if (diff.code === 0) hunks = R.parseDiffHunks(diff.stdout);
    else extra.diffUnavailable = (diff.stderr || "").trim().split("\n")[0] || `exit ${diff.code}`;
    const fetched = await fetchReviewThreads(pr, deps);
    // Without thread state no comment can be told live from resolved, so
    // none demotes a finding (the fp de-dup still applies).
    if (fetched.ok) threads = fetched.threads;
    else extra.threadsUnavailable = fetched.error;
  }

  const plan = R.planFindings({
    findings: events.findings,
    hunks,
    diffUnavailable: extra.diffUnavailable != null,
    existingComments: toExistingComments(R, reviewComments.items, threads),
    mode: planMode,
    sha,
    maxThreads: MAX_THREADS,
  });

  // True when a finding that should have opened a thread is only in the
  // summary; the caller records that commit as "cli-partial", not "cli".
  let partial = plan.partial === true;
  const posted = [];
  const summary = [...plan.summary];
  for (const item of plan.inline) {
    const body = item.body;
    const filePayload = { body, commit_id: sha, path: item.path, subject_type: "file" };
    let r =
      item.subjectType === "line" && item.line != null
        ? await ghPost(deps, `repos/${REPO}/pulls/${pr}/comments`, {
            body,
            commit_id: sha,
            path: item.path,
            line: item.line,
            side: "RIGHT",
          })
        : await ghPost(deps, `repos/${REPO}/pulls/${pr}/comments`, filePayload);
    let subjectType = item.subjectType;
    if (r.code !== 0 && isValidationError(r) && item.subjectType === "line") {
      // The line fell outside what GitHub considers the diff; anchor to the file.
      r = await ghPost(deps, `repos/${REPO}/pulls/${pr}/comments`, filePayload);
      subjectType = "file";
    }
    if (r.code === 0) {
      posted.push({ ...item, subjectType });
    } else if (isValidationError(r)) {
      // Every inline item has a threaded severity, so this one falling back to
      // the summary is a finding no fix loop will see.
      partial = true;
      summary.push({
        fileName: item.path,
        severity: item.severity,
        text: item.body,
        fp: item.fp,
        why: "post-rejected",
      });
    } else {
      return {
        ok: false,
        reason: `comment post failed: ${(r.stderr || "").trim().split("\n")[0]}`,
      };
    }
  }

  // Only the factory's own full marker counts: a stranger pasting it into a PR
  // comment must not be able to suppress the summary (and its findings).
  const marker = `<!-- ${R.SUMMARY_MARKER} sha=${sha} -->`;
  const summaryExists = issueComments.items.some(
    (c) => c?.user?.login === OWNER_LOGIN && (c.body ?? "").includes(marker),
  );
  let summaryPosted = false;
  if (!summaryExists) {
    // A retried post already opened some of this run's threads on an earlier
    // attempt; the summary's count should include them.
    const ownTag = `<!-- ${R.FINDING_MARKER} sha=${String(sha).toLowerCase().slice(0, 12)} `;
    const openedEarlier = reviewComments.items.filter(
      (c) =>
        c?.user?.login === OWNER_LOGIN &&
        c.in_reply_to_id == null &&
        (c.body ?? "").includes(ownTag),
    ).length;
    const body = R.renderSummary({
      sha,
      baseSha,
      mode: runMode,
      outcome,
      inline: posted.length + openedEarlier,
      summary,
      stale,
    });
    const r = await ghPost(deps, `repos/${REPO}/issues/${pr}/comments`, { body });
    if (r.code !== 0) return { ok: false, reason: "summary post failed" };
    summaryPosted = true;
  }
  return {
    ok: true,
    inline: posted.length,
    summarized: summary.length,
    summaryPosted,
    partial,
    ...extra,
  };
}

// ── free pass ───────────────────────────────────────────────────────────────

export async function runFreePass(opts, deps) {
  const { S, R } = await libs();
  const threads = parseJson(opts.threadsJson ?? "[]", []);
  if (!Array.isArray(threads)) return { exempt: false };
  let exempt = false;
  // No IO between the read and the write, so decide and record on one copy.
  await mutateState(S, opts.stateFile, (s) => {
    const rec = S.getIssue(s, opts.issue);
    exempt = R.decideFreePass({ threads, issue: rec, ownerLogin: OWNER_LOGIN }).exempt;
    if (!exempt || opts.dryRun) return false;
    S.setIssueField(s, opts.issue, "crCliFreePassSha", rec.crLastCoveredSha);
    return true;
  });
  return { exempt: Boolean(exempt) };
}

// ── In Test note ────────────────────────────────────────────────────────────

// The note a re-run In Test hand-off needs for a SHA whose coverage the gate
// already decided — rebuilt from state, since the gate's own answer only
// travels with the tick that promoted the card. Only a decision for exactly
// this SHA counts: coverage of an older head says nothing about this one.
export async function runNote({ issue, sha, stateFile }) {
  const { S, R } = await libs();
  if (!issue || !sha || !stateFile) return { note: "" };
  const rec = S.getIssue(await S.loadFactoryState(stateFile), issue);
  const head = String(sha).toLowerCase();
  if (String(rec.crCoverageSha ?? "").toLowerCase() !== head) return { note: "" };
  return { note: R.coverageNote(rec.crCoverage, head) || "" };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE =
  "Usage: coderabbit-cli.mjs <" +
  "gate --issue N --pr P --sha S --state-file F --repo-root R --run-root D|" +
  "housekeeping --state-file F --repo-root R --run-root D|" +
  "free-pass --issue N --state-file F (threads JSON on stdin)|" +
  "note --issue N --sha S --state-file F|" +
  "_supervise --run-dir D> [--dry-run 0|1] [--now ISO]";

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

class UsageError extends Error {}

function required(flags, names) {
  for (const name of names) {
    if (!flags[name]) throw new UsageError(`missing --${name}`);
  }
}

export async function main(argv, deps = createDeps()) {
  const [sub, ...rest] = argv;
  if (sub === "note") {
    // Feeds the In Test hand-off, which must never fail because of this lane:
    // bad argv, a missing or corrupt state file — all answer "no note".
    try {
      const { flags } = parseFlags(rest);
      return await runNote({
        issue: flags.issue,
        sha: flags.sha,
        stateFile: flags["state-file"],
      });
    } catch {
      return { note: "" };
    }
  }
  const { flags } = parseFlags(rest);
  const dryRun = flags["dry-run"] === "1" || flags["dry-run"] === "true";
  const common = {
    stateFile: flags["state-file"],
    repoRoot: flags["repo-root"],
    runRoot: flags["run-root"],
    dryRun,
    now: flags.now,
  };
  switch (sub) {
    case "gate":
      required(flags, ["issue", "pr", "sha", "state-file", "repo-root", "run-root"]);
      if (!SHA40.test(flags.sha)) throw new UsageError(`--sha must be a 40-hex SHA: ${flags.sha}`);
      try {
        return await runGate({ ...common, issue: flags.issue, pr: flags.pr, sha: flags.sha }, deps);
      } catch (err) {
        // Fail open: a broken lane must never keep a card out of In Test. The
        // note still tells the tester nobody vouched for CodeRabbit coverage;
        // cr_lane_gate's own fail-open branches use the same wording.
        return {
          action: "promote",
          reason: `gate-error: ${err.message}`,
          coverage: null,
          note: `CodeRabbit coverage of ${flags.sha.slice(0, 12)} unknown (lane error)`,
        };
      }
    case "housekeeping":
      required(flags, ["state-file", "repo-root", "run-root"]);
      try {
        return await runHousekeeping(common, deps);
      } catch (err) {
        return { state: "error", error: err.message };
      }
    case "free-pass":
      required(flags, ["issue", "state-file"]);
      try {
        return await runFreePass(
          { ...common, issue: flags.issue, threadsJson: await readStdin() },
          deps,
        );
      } catch (err) {
        return { exempt: false, error: err.message };
      }
    case "_supervise":
      required(flags, ["run-dir"]);
      return runSupervise({ runDir: flags["run-dir"] });
    default:
      throw new UsageError(sub ? `unknown subcommand: ${sub}` : "missing subcommand");
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => {
      if (out != null) process.stdout.write(JSON.stringify(out) + "\n");
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message, usage: USAGE }) + "\n");
      process.exit(1);
    },
  );
}
