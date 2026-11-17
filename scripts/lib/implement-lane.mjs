#!/usr/bin/env node
// Detached --implement runs (ADR-0085).
//
// Without this, `factory-agent.sh --implement` runs its claude call in the
// foreground for up to FACTORY_IMPLEMENT_TIMEOUT_SEC (45 min), and the loop's
// single mutex holds every other mode (--release, --watch, --browser, --plan)
// for every other card until it ends. With FACTORY_IMPLEMENT_DETACHED=1 the
// tick starts the claude call here, detached, and goes on; a later tick
// collects the finished run and hands it to the same implement_handle_result
// the synchronous path uses.
//
// The split of work follows the verification lane and the CodeRabbit CLI lane:
// the TICK does every state, git and gh write (start, finish, kill run in the
// tick). The detached SUPERVISOR (`_supervise`) only runs claude and writes its
// own run dir. It never reads or writes logs/factory-state.json, never runs git
// or gh, and never touches the board.
//
// Run dir: logs/factory/implement/<issue>-<runId>/ (0700), holding
//   meta.json       formatVersion 1: what the supervisor runs (argv, paths,
//                   deadlines) and `ctx`, the handler globals the tick restores
//                   at collection
//   input.md        claude's -p input (the prompt and bundle, or the resume note)
//   stdout.txt      claude's stdout (the summary line)
//   stderr.txt      claude's and run-claude.mjs's stderr
//   supervisor.log  the supervisor's own log lines
//   exit.json       formatVersion 1, written by the supervisor however it ends
//                   (a SIGKILL or a reboot excepted)
//   collected.json  written by the tick when the run leaves the ledger
//
// Subcommands (all print one JSON line; exit 0 for an answer, including a
// refusal, and 1 with {"error"} on stderr when something broke):
//   precheck  --max-running <n> [--state-file f]
//             Capacity before the expensive part of a start (worktree,
//             install): {ok:true} or {ok:false, reason:"max-running"|"memory"}.
//   start     --spec-file <json> --run-root <dir> --repo-root <dir> [--state-file f]
//             Reserve the run, write its run dir, `git worktree lock` the
//             worktree, spawn the supervisor detached, attach its pid and hand
//             the card's slot to it. {started:true, runId, pid, runDir,
//             deadlineAt, hardKillAt} or {started:false, reason}.
//   _supervise --run-dir <dir>
//             The detached supervisor. Internal.
//   status    [--issue n] [--state-file f]
//             Every ledger run with its state (below). Read-only. Fails (exit
//             1) when it can't tell whether a run is alive.
//   kill      --issue <n> [--finish 1 --outcome <word>] [--wait-ms <ms>]
//             [--repo-root dir] [--state-file f]
//             Stop the run: SIGTERM, then SIGKILL after --wait-ms (default
//             60000), following the process groups it found at the start
//             until each is gone (trackRun). With --finish 1 and the run gone,
//             finish it too (ok:false if that is refused).
//   finish    --issue <n> --run-id <id> --outcome <word> [--pid <n>|none]
//             [--repo-root dir] [--state-file f]
//             Unlock the worktree, drop the run from the ledger, write
//             collected.json. Refused while anything of the run is alive, or
//             when the run's pid is no longer --pid (attached since).
//   housekeeping --run-root <dir> [--max-age-days 30] [--state-file f]
//             Reap run dirs the ledger no longer names, after 30 days.
//
// Run states (status):
//   starting    reserved, no pid yet, under 2 minutes old
//   unattached  reserved and never attached: the tick died mid-start. alive
//               says whether a supervisor for it is running anyway
//   running     alive and not yet overdue (exit.json, if written, is fresh)
//   draining    exit.json written over a minute ago, but something in the
//               run's process groups is still alive
//   overdue     alive, no exit.json, 2 minutes past hardKillAt: the
//               supervisor's own backstop did not end it
//   done        exit.json written and nothing left alive
//   lost        nothing alive and no exit.json (a SIGKILL, a reboot)
//   unreadable  meta.json or exit.json is missing, corrupt or of another
//               formatVersion
// Liveness: the supervisor's process group (its pid, with the run id on its
// command line, or any live member of its group), every process group below
// it, and any process whose command line carries the run's claude session id.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants as osConstants } from "node:os";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { SESSION_ID_RE } from "./session-limit.mjs";
import { memoryPressure } from "./host-resources.mjs";
import { descendants, groupRunState, isLiveRow, processTable } from "./supervisor-proc.mjs";
import { parseWorktreePorcelain } from "./worktree-cli.mjs";
import {
  acquireSlot,
  attachImplementRun,
  finishImplementRun,
  getImplement,
  getImplementRun,
  getSlot,
  isFactoryPaused,
  markImplementRollback,
  loadFactoryState,
  reserveImplementRun,
  saveFactoryState,
  DEFAULT_FACTORY_STATE_PATH,
} from "./factory-state.mjs";

export const FORMAT_VERSION = 1;
const THIS_FILE = fileURLToPath(import.meta.url);
export const RUN_CLAUDE = path.join(path.dirname(THIS_FILE), "run-claude.mjs");
export const EFFORTS = Object.freeze(["ultracode", "max", "xhigh", "high", "medium", "low"]);
export const SESSION_FLAGS = Object.freeze({ fresh: "--session-id", resume: "--resume" });
export const MAX_RUNNING_LIMIT = 2;

const MINUTE_MS = 60 * 1000;
// A reservation still without a pid this long after it was made: the tick
// that made it died between reserve and attach.
export const UNATTACHED_LOST_MS = 2 * MINUTE_MS;
// After exit.json, the supervisor exits within milliseconds. Something still
// alive in its groups a minute later is draining and gets stopped.
export const DRAINING_AFTER_MS = MINUTE_MS;
// The supervisor's own backstop ends a run at hardKillAt; one still alive this
// long after it is overdue, and the tick stops it.
export const OVERDUE_AFTER_MS = 2 * MINUTE_MS;
export const DEFAULT_STOP_WAIT_MS = 60 * 1000;
const KILL_SETTLE_MS = 10 * 1000;
// The supervisor touches <runDir>/heartbeat this often, so a run that dies
// without exit.json can still be placed before or after its deadline.
export const HEARTBEAT_MS = 30 * 1000;
// leftover.json's state when the supervisor couldn't look at the process
// table at all, so what the run left behind is unknown.
export const UNVERIFIED = "cleanup-unverified";
// How often the supervisor reads the process table to follow what the run
// starts, and how long it gives leftovers between SIGTERM and SIGKILL.
const FOLLOW_MS = 1000;
const LEFTOVER_WAIT_MS = 5000;
const LEFTOVER_RETRIES = 5;
const LEFTOVER_RETRY_MS = 2000;
const POLL_MS = 250;
export const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;
const RUN_DIR_NAME_RE = /^[1-9][0-9]*-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;

// ── argv and env: exactly the synchronous path's ────────────────────────────
// factory-agent.sh's synchronous --implement call is
//   ( cd "$WT_PATH" && CLAUDE_CALL_TIMEOUT_SEC="$IMPLEMENT_TIMEOUT_SEC" \
//       CLAUDE_CALL_KILL_GRACE_SEC="$FACTORY_IMPLEMENT_TERM_GRACE_SEC" CLAUDE_CALL_KILL_GROUP=1 \
//       node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$CLAUDE_INPUT" <the flags below> )
// and implement-lane-parity.test.mjs pins the two to each other.

export function buildImplementArgv({ effort, mode, sessionId }) {
  if (!EFFORTS.includes(effort)) throw new Error(`invalid effort: ${effort}`);
  if (!Object.hasOwn(SESSION_FLAGS, mode)) throw new Error(`invalid mode: ${mode} (fresh|resume)`);
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }
  return [
    "--dangerously-skip-permissions",
    "--effort",
    effort,
    "--no-chrome",
    "--strict-mcp-config",
    SESSION_FLAGS[mode],
    sessionId,
  ];
}

// The tick's own environment (the synchronous call inherits it too), plus the
// three variables the synchronous call sets inline.
export function buildImplementEnv(baseEnv, { timeoutSec, termGraceSec }) {
  return {
    ...baseEnv,
    CLAUDE_CALL_TIMEOUT_SEC: String(timeoutSec),
    CLAUDE_CALL_KILL_GRACE_SEC: String(termGraceSec),
    CLAUDE_CALL_KILL_GROUP: "1",
  };
}

// ── small helpers ───────────────────────────────────────────────────────────

function positiveInt(raw, what) {
  const s = String(raw ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(s)) throw new Error(`invalid ${what}: ${raw}`);
  return Number(s);
}

function isoSeconds(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

export function makeRunId(nowMs, rand = () => randomBytes(3).toString("hex")) {
  const stamp = new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${rand()}`;
}

export function runDirFor(runRoot, issue, runId) {
  return path.join(runRoot, `${issue}-${runId}`);
}

function readJson(fs, file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (err) {
    return { error: err.code === "ENOENT" ? "missing" : "corrupt" };
  }
}

function writeJsonAtomic(fs, file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function appendLog(fs, file, line) {
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 });
  } catch {
    /* the log is best effort */
  }
}

// Reload → mutate → save with nothing awaited in between (verify-lane.mjs).
// `fn` must be synchronous; returning false skips the save.
async function mutateState(stateFile, fn) {
  const fresh = await loadFactoryState(stateFile);
  const out = fn(fresh);
  if (out !== false) await saveFactoryState(fresh, stateFile);
  return out;
}

// ── dependencies (real ones; tests inject their own) ────────────────────────

function realGit(args, { cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: err.message });
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.once("error", (e) => resolve({ code: 127, stdout: "", stderr: e.message }));
    child.once("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

// Detached (its own session and process group, so launchd's process-group
// kill at the end of the tick never reaches it), stdio to a file and never to
// the tick's pipes: `$(node implement-lane.mjs start …)` would otherwise wait
// on the supervisor for the whole run. Only a confirmed 'spawn' counts.
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
  child.on("error", () => {});
  closeOut();
  if (!outcome.ok) return outcome;
  child.unref();
  return { ok: true, pid: child.pid };
}

function realKill(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// When the machine last booted, in ms, or null. A run whose supervisor beat
// last before it is certainly gone, with everything it started.
export function bootTimeMs({ run = spawnSync } = {}) {
  const r = run("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
  const m = /sec\s*=\s*(\d+)/.exec(String(r?.stdout ?? ""));
  return r && r.status === 0 && m ? Number(m[1]) * 1000 : null;
}

export function createDeps() {
  return {
    env: process.env,
    fs: nodeFs,
    nowMs: () => Date.now(),
    table: () => processTable(),
    kill: realKill,
    git: realGit,
    spawnDetached: realSpawnDetached,
    memoryPressure: () => memoryPressure(),
    bootTimeMs: () => bootTimeMs(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    selfPids: [process.pid, process.ppid],
  };
}

// ── liveness ────────────────────────────────────────────────────────────────

// An ORPHANED claude call for <sessionId>: a process re-parented to launchd
// (ppid 1) after the supervisor and run-claude.mjs died, carrying the id as
// the value of --session-id or --resume on a command line that names claude.
// While its parents live, a run's claude is found down the process tree
// instead. Only orphans: an operator's interactive `claude --resume <id>` has
// a shell for a parent and is never counted as the run, nor signalled.
export function sessionMatcher(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return () => false;
  const flag = new RegExp(`(?:^|\\s)--(?:session-id|resume)\\s+${sessionId}(?:\\s|$)`);
  return (row) => row.ppid === 1 && flag.test(row.command) && /claude/.test(row.command);
}

// Every process group that belongs to <run> in the snapshot <rows>: the
// supervisor's (attached pid, or any supervisor carrying the run id when the
// ledger never got its pid), every group below one of its members (the claude
// session leads its own), and the group of any process carrying the run's
// claude session id (a session whose parents were killed). Never the group of
// this process or of the one that called it.
export function runGroups(run, rows, { selfPids = [] } = {}) {
  const live = rows.filter(isLiveRow);
  const groups = new Set();
  const isSession = sessionMatcher(run.sessionId);
  if (
    Number.isInteger(run.pid) &&
    groupRunState(rows, { pid: run.pid, runId: run.runId }) === "alive"
  ) {
    groups.add(run.pid);
  }
  for (const r of live) {
    if (
      r.command.includes("implement-lane.mjs") &&
      r.command.includes("_supervise") &&
      r.command.includes(run.runId)
    ) {
      groups.add(r.pgid);
    }
    if (isSession(r)) groups.add(r.pgid);
  }
  // Down the tree from every member of every group found, until nothing new.
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of live) {
      if (!groups.has(r.pgid)) continue;
      for (const d of descendants(rows, r.pid)) {
        if (!groups.has(d.pgid)) {
          groups.add(d.pgid);
          grew = true;
        }
      }
    }
  }
  const ownGroups = new Set(rows.filter((r) => selfPids.includes(r.pid)).map((r) => r.pgid));
  for (const g of [...groups]) {
    if (g <= 1 || ownGroups.has(g)) groups.delete(g);
    else if (!live.some((r) => r.pgid === g)) groups.delete(g);
  }
  return [...groups];
}

function readRunFiles(fs, run) {
  if (!run.runDir) {
    return { meta: null, metaProblem: "no-run-dir", exit: null, exitProblem: null, leftover: null };
  }
  const m = readJson(fs, path.join(run.runDir, "meta.json"));
  let meta = null;
  let metaProblem = null;
  if (m.error) metaProblem = `meta.json ${m.error}`;
  else if (m.value?.formatVersion !== FORMAT_VERSION)
    metaProblem = `meta.json formatVersion ${JSON.stringify(m.value?.formatVersion)}`;
  else meta = m.value;
  const e = readJson(fs, path.join(run.runDir, "exit.json"));
  let exit = null;
  let exitProblem = null;
  if (e.error === "corrupt") exitProblem = "exit.json corrupt";
  else if (!e.error && e.value?.formatVersion !== FORMAT_VERSION)
    exitProblem = `exit.json formatVersion ${JSON.stringify(e.value?.formatVersion)}`;
  else if (!e.error) exit = e.value;
  let heartbeatMs = null;
  try {
    heartbeatMs = fs.statSync(path.join(run.runDir, "heartbeat")).mtimeMs;
  } catch {
    heartbeatMs = null;
  }
  const leftover = leftoverOf(fs, run.runDir);
  const cleared = clearedOf(fs, run.runDir);
  // Cleanup the supervisor couldn't vouch for: it said so (leftover.json), or
  // exit.json says it wasn't clean and no leftover.json made it to disk.
  const unverifiedCleanup =
    leftover.seed?.state === UNVERIFIED ||
    (exit != null && exit.cleanup !== "clean" && leftover.seed == null && !leftover.problem);
  return {
    meta,
    metaProblem,
    exit,
    // An operator's clear (implement-lane.mjs clear) lifts what can't be
    // checked: an unreadable leftover.json and an unverified cleanup.
    exitProblem: exitProblem ?? (cleared ? null : leftover.problem),
    heartbeatMs,
    leftover: leftover.problem ? null : leftover.seed,
    unverified: !cleared && unverifiedCleanup,
    cleared,
  };
}

// leftover.json: written by a supervisor that couldn't confirm that what its
// run left behind is gone (ps failing, or a group surviving SIGKILL). It holds
// the tracked identities (pgid and leader start time, member pid and start
// time), so status keeps the run alive while they are, and kill and finish
// carry the cleanup on from them before anything is unlocked.
export function leftoverOf(fs, runDir) {
  if (!runDir) return { seed: null, problem: null };
  const r = readJson(fs, path.join(runDir, "leftover.json"));
  if (r.error === "missing") return { seed: null, problem: null };
  if (r.error) return { seed: null, problem: "leftover.json corrupt" };
  if (r.value?.formatVersion !== FORMAT_VERSION) {
    return {
      seed: null,
      problem: `leftover.json formatVersion ${JSON.stringify(r.value?.formatVersion)}`,
    };
  }
  return { seed: r.value, problem: null };
}

// cleared.json: an operator checked by hand that nothing of the run is left
// running (implement-lane.mjs clear), so what couldn't be verified is lifted.
function clearedOf(fs, runDir) {
  if (!runDir) return false;
  const r = readJson(fs, path.join(runDir, "cleared.json"));
  return !r.error && r.value?.formatVersion === FORMAT_VERSION;
}

// Pure: a run's state from its ledger record, run files and liveness.
export function classifyRun({
  run,
  metaProblem,
  exit,
  exitProblem,
  alive,
  nowMs,
  unverified = false,
  cleared = false,
  heartbeatMs = null,
  bootMs = null,
}) {
  const ms = (iso) => {
    const t = Date.parse(iso ?? "");
    return Number.isNaN(t) ? null : t;
  };
  const deadline = ms(run.deadlineAt);
  const hardKill = ms(run.hardKillAt);
  const pastDeadline = deadline != null && nowMs >= deadline;
  const base = { alive, pastDeadline };
  // A start that couldn't confirm its supervisor gone: never collected, only
  // stopped and dropped (implement_lane_collect_one).
  if (run.rollbackPending === true) return { ...base, state: "rollback" };
  // The supervisor couldn't inspect what the run left behind: not done until
  // a person has looked (the runbook's "Detached implement runs").
  if (unverified) return { ...base, state: "unverified", problem: "cleanup unverified" };
  if (!Number.isInteger(run.pid)) {
    if (alive) return { ...base, state: "unattached" };
    const started = ms(run.startedAt);
    if (started != null && nowMs - started < UNATTACHED_LOST_MS)
      return { ...base, state: "starting" };
    return { ...base, state: "unattached" };
  }
  if (metaProblem || exitProblem) {
    return { ...base, state: "unreadable", problem: metaProblem ?? exitProblem };
  }
  if (exit) {
    if (!alive) return { ...base, state: "done" };
    const ended = ms(exit.endedAt);
    if (ended != null && nowMs - ended >= DRAINING_AFTER_MS) return { ...base, state: "draining" };
    return { ...base, state: "running" };
  }
  if (!alive) {
    // The supervisor died without exit.json, so it never cleaned up after
    // the run. Only a reboot since its last heartbeat proves everything it
    // started is gone; otherwise, until a person has checked, unverified.
    const rebooted =
      Number.isFinite(bootMs) && Number.isFinite(heartbeatMs) && bootMs > heartbeatMs;
    if (!rebooted && !cleared) {
      return { ...base, state: "unverified", problem: "supervisor died without exit.json" };
    }
    return { ...base, state: "lost" };
  }
  if (hardKill != null && nowMs - hardKill >= OVERDUE_AFTER_MS)
    return { ...base, state: "overdue" };
  return { ...base, state: "running" };
}

// Pure: what the tick hands implement_handle_result for an ended run (done or
// lost), as the exit code the synchronous call would have returned:
//   - no exit.json: past the deadline it was killed at the cap → 124; before
//     it, the supervisor died with it (a reboot, a SIGKILL) → interrupted;
//   - the supervisor's backstop ended it → 124;
//   - stopped by a signal from outside (exit.json says terminated) with no
//     result of its own: past the deadline → 124, else interrupted. A run that
//     ended 0 or 124 on its own keeps that code;
//   - no exit code at all (the supervisor failed before claude ran) → 1, so
//     the attempt is spent and a broken supervisor can't loop a card forever;
//   - else claude's (run-claude.mjs's) own exit code.
// "interrupted" spends no attempt (implement_lane_collect_one).
export function collectOutcome({ exit, pastDeadline }) {
  if (!exit) {
    return pastDeadline
      ? { exitCode: 124, interrupted: false, why: "no exit.json, past the deadline" }
      : { exitCode: null, interrupted: true, why: "no exit.json, before the deadline" };
  }
  if (exit.backstop) return { exitCode: 124, interrupted: false, why: "stopped at hardKillAt" };
  const code = Number.isInteger(exit.exitCode) ? exit.exitCode : null;
  if (exit.terminated && code !== 0 && code !== 124) {
    return pastDeadline
      ? { exitCode: 124, interrupted: false, why: "stopped past the deadline" }
      : { exitCode: null, interrupted: true, why: "stopped from outside before the deadline" };
  }
  if (code == null) {
    return { exitCode: 1, interrupted: false, why: `supervisor error: ${exit.error ?? "unknown"}` };
  }
  return { exitCode: code, interrupted: false, why: "claude exited" };
}

// A run counts as live (the card is off limits) while anything of it runs, or
// while it is still being started.
export function isLiveState(s) {
  return s.alive || s.state === "starting" || s.state === "unverified";
}

function describeRun(issue, run, files, cls, nowMs) {
  const exit = files.exit
    ? {
        exitCode: Number.isInteger(files.exit.exitCode) ? files.exit.exitCode : null,
        timedOut: files.exit.timedOut === true,
        terminated: files.exit.terminated === true,
        backstop: files.exit.backstop === true,
        endedAt: typeof files.exit.endedAt === "string" ? files.exit.endedAt : null,
        error: typeof files.exit.error === "string" ? files.exit.error : null,
      }
    : null;
  return {
    issue: String(issue),
    runId: run.runId,
    state: cls.state,
    live: isLiveState(cls),
    alive: cls.alive,
    pastDeadline: cls.pastDeadline,
    ...(cls.problem ? { problem: cls.problem } : {}),
    pid: run.pid,
    ...(run.rollbackPending === true ? { rollbackPending: true } : {}),
    slot: run.slot,
    sessionId: run.sessionId,
    mode: run.mode,
    startedAt: run.startedAt,
    deadlineAt: run.deadlineAt,
    hardKillAt: run.hardKillAt,
    runDir: run.runDir,
    worktree: run.worktree,
    exit,
    ...(cls.state === "done" || cls.state === "lost"
      ? { collect: collectFields(run, exit, files.heartbeatMs, nowMs) }
      : {}),
  };
}

// When the run ended, as best known: exit.json's endedAt; for a run that died
// without one, the supervisor's last heartbeat plus its interval; failing
// both, now. "Past the deadline" is judged at that moment, never at the
// collecting tick's: a run killed at minute 10 and collected an hour later
// was interrupted, not timed out.
export function runEndMs({ exit, heartbeatMs, nowMs }) {
  const ended = Date.parse(exit?.endedAt ?? "");
  if (!Number.isNaN(ended)) return ended;
  if (Number.isFinite(heartbeatMs)) return Math.min(nowMs, heartbeatMs + HEARTBEAT_MS);
  return nowMs;
}

function collectFields(run, exit, heartbeatMs, nowMs) {
  const endedMs = runEndMs({ exit, heartbeatMs, nowMs });
  const deadline = Date.parse(run.deadlineAt ?? "");
  const pastDeadline = !Number.isNaN(deadline) && endedMs >= deadline;
  return {
    ...collectOutcome({ exit, pastDeadline }),
    endedAt: isoSeconds(endedMs),
    endedEpoch: Math.floor(endedMs / 1000),
  };
}

export async function runStatus({ stateFile, issue = null }, deps) {
  const state = await loadFactoryState(stateFile);
  const entries = Object.entries(getImplement(state).runs).filter(
    ([n]) => issue == null || n === String(issue),
  );
  if (entries.length === 0) return { ok: true, runs: [], issues: [], live: [] };
  const rows = deps.table();
  if (!rows) throw new Error("ps failed: can't tell whether the implement runs are alive");
  const nowMs = deps.nowMs();
  const bootMs = deps.bootTimeMs ? deps.bootTimeMs() : null;
  const runs = entries.map(([n, run]) => {
    const files = readRunFiles(deps.fs, run);
    const alive =
      trackRun(run, rows, { selfPids: deps.selfPids, seed: files.leftover }).alive.length > 0;
    return describeRun(n, run, files, classifyRun({ run, ...files, alive, nowMs, bootMs }), nowMs);
  });
  return {
    ok: true,
    runs,
    issues: runs.map((r) => r.issue),
    live: runs.filter((r) => r.live).map((r) => r.issue),
  };
}

// ── precheck ────────────────────────────────────────────────────────────────

export async function runPrecheck({ stateFile, maxRunning }, deps) {
  const max = positiveInt(maxRunning, "--max-running");
  if (max > MAX_RUNNING_LIMIT) throw new Error(`--max-running above ${MAX_RUNNING_LIMIT}: ${max}`);
  const state = await loadFactoryState(stateFile);
  const running = Object.keys(getImplement(state).runs).length;
  if (running >= max) return { ok: false, reason: "max-running", running, maxRunning: max };
  const pressure = await deps.memoryPressure();
  if (Number.isInteger(pressure) && pressure >= 2) return { ok: false, reason: "memory", pressure };
  return { ok: true, running, maxRunning: max };
}

// ── start (in the tick) ─────────────────────────────────────────────────────

export function readSpec(fs, file) {
  const spec = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw new Error("spec: not an object");
  const issue = String(spec.issue ?? "");
  if (!/^[1-9][0-9]*$/.test(issue)) throw new Error(`spec: invalid issue: ${spec.issue}`);
  const slot = Number(spec.slot);
  if (!Number.isInteger(slot) || slot < 0) throw new Error(`spec: invalid slot: ${spec.slot}`);
  if (typeof spec.worktree !== "string" || !path.isAbsolute(spec.worktree)) {
    throw new Error(`spec: worktree must be an absolute path: ${spec.worktree}`);
  }
  if (typeof spec.inputFile !== "string" || spec.inputFile === "") {
    throw new Error("spec: inputFile is required");
  }
  const argv = buildImplementArgv({
    effort: spec.effort,
    mode: spec.mode,
    sessionId: spec.sessionId,
  });
  const maxRunning = positiveInt(spec.maxRunning, "maxRunning");
  if (maxRunning > MAX_RUNNING_LIMIT)
    throw new Error(`spec: maxRunning above ${MAX_RUNNING_LIMIT}`);
  if (!spec.ctx || typeof spec.ctx !== "object" || Array.isArray(spec.ctx)) {
    throw new Error("spec: ctx must be an object");
  }
  return {
    issue,
    slot,
    worktree: spec.worktree,
    inputFile: spec.inputFile,
    effort: spec.effort,
    mode: spec.mode,
    sessionId: spec.sessionId,
    argv,
    timeoutSec: positiveInt(spec.timeoutSec, "timeoutSec"),
    termGraceSec: positiveInt(spec.termGraceSec, "termGraceSec"),
    killGraceSec: positiveInt(spec.killGraceSec, "killGraceSec"),
    maxRunning,
    ctx: spec.ctx,
  };
}

// Lock <worktree> for run <runId>. Fail closed: a worktree already locked
// (by a run nothing has cleaned up after: its owner is unknown), one git
// doesn't list, a list that can't be read, or a lock that fails, all refuse
// the start. Returns null, or the reason.
async function lockWorktree(deps, repoRoot, worktree, runId) {
  const list = await deps.git(["worktree", "list", "--porcelain"], { cwd: repoRoot });
  if (list.code !== 0) return "lock-unknown";
  const canon = (p) => {
    try {
      return deps.fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const entry = parseWorktreePorcelain(list.stdout).find((w) => canon(w.path) === canon(worktree));
  if (!entry) return "not-a-worktree";
  if (entry.locked) return "worktree-locked";
  const r = await deps.git(["worktree", "lock", "--reason", `implement run ${runId}`, worktree], {
    cwd: repoRoot,
  });
  return r.code === 0 ? null : `lock-failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`;
}

async function unlockWorktree(deps, repoRoot, worktree) {
  if (!repoRoot || !worktree) return;
  await deps.git(["worktree", "unlock", worktree], { cwd: repoRoot });
}

export async function runStart({ specFile, stateFile, runRoot, repoRoot }, deps) {
  const fs = deps.fs;
  const refuse = (reason, extra = {}) => ({ started: false, reason, ...extra });
  if (!runRoot || !path.isAbsolute(runRoot)) throw new Error("--run-root must be absolute");
  if (!repoRoot || !path.isAbsolute(repoRoot)) throw new Error("--repo-root must be absolute");
  const spec = readSpec(fs, specFile);
  if (!fs.existsSync(spec.worktree)) return refuse("worktree-missing");
  let input;
  try {
    input = fs.readFileSync(spec.inputFile, "utf8");
  } catch {
    return refuse("input-missing");
  }
  if (input === "") return refuse("input-empty");

  const nowMs = deps.nowMs();
  const now = new Date(nowMs).toISOString();
  const runId = makeRunId(nowMs);
  let reservation = null;
  let refused = null;
  await mutateState(stateFile, (s) => {
    if (isFactoryPaused(s, now)) refused = "factory-paused";
    else if (String(getSlot(s, spec.slot).issueNumber ?? "") !== spec.issue)
      refused = "slot-not-held";
    else if (
      Object.entries(getImplement(s).runs).some(
        ([n, r]) => n !== spec.issue && r.worktree === spec.worktree,
      )
    )
      refused = "worktree-held";
    if (refused) return false;
    reservation = reserveImplementRun(s, {
      worktree: spec.worktree,
      runDir: runDirFor(runRoot, spec.issue, runId),
      issue: spec.issue,
      runId,
      slot: spec.slot,
      mode: spec.mode,
      sessionId: spec.sessionId,
      maxRunning: spec.maxRunning,
      now,
    });
    return reservation.ok;
  });
  if (refused) return refuse(refused);
  if (!reservation.ok) return refuse(reservation.reason);

  const runDir = runDirFor(runRoot, spec.issue, runId);
  let spawned = null;
  // The lock first, before anything else exists: nothing to roll back but the
  // reservation if the worktree can't be locked.
  const lockError = await lockWorktree(deps, repoRoot, spec.worktree, runId);
  if (lockError) {
    await mutateState(stateFile, (s) => finishImplementRun(s, spec.issue, runId).ok);
    return refuse(lockError.startsWith("lock-failed") ? "lock-failed" : lockError, {
      ...(lockError.startsWith("lock-failed") ? { error: lockError } : {}),
    });
  }
  const locked = true;
  try {
    fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(runDir, { mode: 0o700 });
    fs.chmodSync(runDir, 0o700);
    fs.writeFileSync(path.join(runDir, "input.md"), input, { mode: 0o600 });
    const startMs = deps.nowMs();
    const deadlineMs = startMs + spec.timeoutSec * 1000;
    const startedAt = isoSeconds(startMs);
    const deadlineAt = new Date(deadlineMs).toISOString();
    const hardKillAt = new Date(deadlineMs + spec.killGraceSec * 1000).toISOString();
    const meta = {
      formatVersion: FORMAT_VERSION,
      runId,
      issue: spec.issue,
      slot: spec.slot,
      worktree: spec.worktree,
      runDir,
      repoRoot,
      startedAt,
      deadlineAt,
      hardKillAt,
      timeoutSec: spec.timeoutSec,
      termGraceSec: spec.termGraceSec,
      killGraceSec: spec.killGraceSec,
      mode: spec.mode,
      effort: spec.effort,
      sessionId: spec.sessionId,
      node: process.execPath,
      runClaude: RUN_CLAUDE,
      argv: spec.argv,
      ctx: spec.ctx,
    };
    writeJsonAtomic(fs, path.join(runDir, "meta.json"), meta);
    // The run id rides on the supervisor's command line (in --run-dir): status
    // and kill identify the live process by it, so a reused pid never counts.
    spawned = await deps.spawnDetached(
      process.execPath,
      [THIS_FILE, "_supervise", "--run-dir", runDir],
      {
        cwd: runDir,
        logPath: path.join(runDir, "supervisor.log"),
        env: deps.env,
      },
    );
    if (!spawned.ok) throw new Error(`supervisor failed to start: ${spawned.reason}`);
    const attached = await mutateState(stateFile, (s) => {
      const ok = attachImplementRun(s, spec.issue, runId, {
        pid: spawned.pid,
        deadlineAt,
        hardKillAt,
        runDir,
        worktree: spec.worktree,
      });
      if (!ok) return false;
      // The slot is held by the supervisor from here on: slot_acquire defers
      // this card while it runs, and no other card can take the slot.
      if (String(getSlot(s, spec.slot).issueNumber ?? "") === spec.issue) {
        acquireSlot(s, spec.slot, { issueNumber: spec.issue, pid: spawned.pid, now });
      }
      return true;
    });
    if (!attached) {
      // Finished while we spawned (an operator's kill): nothing tracks this
      // supervisor any more, so stop it here, and unlock only once it's gone.
      const stop = await stopRun(
        { runId, pid: spawned.pid, sessionId: spec.sessionId },
        deps,
        rollbackWaitMs(spec),
      );
      if (stop.state !== "gone") {
        // Not confirmed gone: the run goes back into the ledger, pending its
        // rollback, so the card stays held and the worktree locked until a
        // later tick's collector has stopped it.
        await markRollback(stateFile, spec, runId, {
          pid: spawned.pid,
          runDir,
          deadlineAt,
          hardKillAt,
          startedAt,
        });
        return refuse("abandoned", { runId, stillAlive: true, pid: spawned.pid });
      }
      if (locked) await unlockWorktree(deps, repoRoot, spec.worktree);
      return refuse("abandoned", { runId });
    }
    return {
      started: true,
      runId,
      pid: spawned.pid,
      runDir,
      startedAt,
      deadlineAt,
      hardKillAt,
      locked,
    };
  } catch (err) {
    // Roll back only once nothing of the run is left: a supervisor that did
    // start is stopped (SIGTERM, then SIGKILL) and waited for. If it survives,
    // or ps can't tell, the reservation and the lock stay, so no other run
    // starts in this worktree; the collector stops it on a later tick.
    const stop = await stopRun(
      { runId, pid: spawned?.ok ? spawned.pid : null, sessionId: spec.sessionId },
      deps,
      rollbackWaitMs(spec),
    );
    if (stop.state !== "gone") {
      await markRollback(stateFile, spec, runId, {
        pid: spawned?.ok ? spawned.pid : null,
        runDir,
      });
      return refuse("start-failed", { error: err.message, runId, stillAlive: true });
    }
    try {
      await mutateState(stateFile, (s) => finishImplementRun(s, spec.issue, runId).ok);
    } catch (e) {
      return refuse("start-failed", { error: `${err.message}; rollback: ${e.message}`, runId });
    }
    if (locked) await unlockWorktree(deps, repoRoot, spec.worktree);
    return refuse("start-failed", { error: err.message, runId });
  }
}

// Keep (or put back) the run in the ledger as rollbackPending. Best effort:
// if even that write fails, the lock still stands, and the worktree-cli and
// start refuse a locked worktree.
async function markRollback(stateFile, spec, runId, extra) {
  try {
    await mutateState(stateFile, (s) =>
      markImplementRollback(s, spec.issue, runId, {
        slot: spec.slot,
        sessionId: spec.sessionId,
        mode: spec.mode,
        worktree: spec.worktree,
        ...extra,
      }),
    );
  } catch {
    /* the lock stays either way */
  }
}

// How long a start rollback waits after SIGTERM: run-claude.mjs's own grace
// for claude, plus a margin for it and the supervisor to exit.
function rollbackWaitMs(spec) {
  return (spec.termGraceSec ?? 30) * 1000 + 15_000;
}

// ── the supervisor (detached; never state, git or gh) ───────────────────────

function exitCodeOf(code, signal) {
  if (code != null) return code;
  if (signal) return 128 + (osConstants.signals[signal] ?? 0);
  return 1;
}

export async function runSupervise(
  { runDir },
  {
    env = process.env,
    fs = nodeFs,
    spawnImpl = spawn,
    table = () => processTable(),
    signalProcess = process,
    leftover = { retries: LEFTOVER_RETRIES, waitMs: LEFTOVER_WAIT_MS, retryMs: LEFTOVER_RETRY_MS },
  } = {},
) {
  const logFile = path.join(runDir, "supervisor.log");
  const startedAt = new Date().toISOString();
  let exitCode = null;
  let signal = null;
  let error = null;
  let terminated = false;
  let backstop = false;
  let child = null;
  let backstopTimer = null;
  let killTimer = null;
  let meta = null;

  // Every process group below the child (claude leads its own), then the
  // child itself: the backstop's SIGKILL, once SIGTERM was ignored.
  const killTree = () => {
    const rows = table();
    if (rows && child?.pid) {
      const own = rows.find((r) => r.pid === process.pid)?.pgid;
      const groups = new Set(descendants(rows, child.pid).map((r) => r.pgid));
      for (const g of groups) {
        if (g > 1 && g !== own) {
          try {
            signalProcess.kill(-g, "SIGKILL");
          } catch {
            /* gone */
          }
        }
      }
    }
    try {
      child?.kill("SIGKILL");
    } catch {
      /* gone */
    }
  };

  // SIGTERM/SIGHUP/SIGINT reach this process when the run is stopped (kill
  // signals the whole group, run-claude.mjs included, which stops claude's
  // own group), or when the machine shuts down. Record it and pass it on to
  // the child, then still write exit.json once the child is gone.
  const onSignal = (sig) => {
    terminated = true;
    appendLog(fs, logFile, `received ${sig}; stopping the claude call`);
    try {
      child?.kill(sig);
    } catch {
      /* gone */
    }
  };
  // Everything the run starts, followed while it runs (trackRun), so that at
  // the end a group that left claude's (a setsid test runner, a daemon) and
  // ignored the stop is still found and stopped, not left in the worktree.
  let tracker = null;
  let following = null;
  let followSoon = null;
  // How the end-of-run cleanup went, for exit.json: "clean" only when the
  // supervisor saw the run's process groups and saw them all gone.
  let cleanup = "unverified";
  let childRunning = false;
  let psFailedWhileRunning = false;
  let observedWhileRunning = false;
  const follow = () => {
    const rows = table();
    if (!meta) return;
    if (!rows) {
      if (childRunning) psFailedWhileRunning = true;
      return;
    }
    if (childRunning) observedWhileRunning = true;
    if (!tracker) {
      tracker = trackRun({ runId: meta.runId, pid: process.pid, sessionId: meta.sessionId }, rows, {
        selfPids: [process.pid],
      });
    } else {
      observeRun(tracker, rows);
    }
  };
  const beat = () => {
    try {
      fs.writeFileSync(path.join(runDir, "heartbeat"), new Date().toISOString() + "\n", {
        mode: 0o600,
      });
    } catch {
      /* best effort */
    }
  };
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  const handlers = {};
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    handlers[sig] = () => onSignal(sig);
    signalProcess.on(sig, handlers[sig]);
  }

  try {
    const m = readJson(fs, path.join(runDir, "meta.json"));
    if (m.error) throw new Error(`meta.json ${m.error}`);
    if (m.value?.formatVersion !== FORMAT_VERSION) {
      throw new Error(`meta.json formatVersion ${JSON.stringify(m.value?.formatVersion)}`);
    }
    meta = m.value;
    if (!Array.isArray(meta.argv) || !meta.argv.every((a) => typeof a === "string")) {
      throw new Error("meta.json: argv is not a list of strings");
    }
    const input = fs.readFileSync(path.join(runDir, "input.md"), "utf8");
    // Stopped before claude was even started: start nothing.
    if (terminated) throw new Error("stopped before the claude call started");
    const out = fs.openSync(path.join(runDir, "stdout.txt"), "a", 0o600);
    const err = fs.openSync(path.join(runDir, "stderr.txt"), "a", 0o600);
    appendLog(
      fs,
      logFile,
      `starting claude (run ${meta.runId}, ${meta.mode}, session ${meta.sessionId})`,
    );
    const result = await new Promise((resolve) => {
      try {
        child = spawnImpl(meta.node, [meta.runClaude, "-p", input, ...meta.argv], {
          cwd: meta.worktree,
          env: buildImplementEnv(env, meta),
          stdio: ["ignore", out, err],
        });
      } catch (e) {
        resolve({ code: 127, signal: null, error: `spawn failed: ${e.message}` });
        return;
      }
      childRunning = true;
      following = setInterval(follow, FOLLOW_MS);
      followSoon = setTimeout(follow, 300);
      child.once("error", (e) =>
        resolve({ code: 127, signal: null, error: `spawn failed: ${e.message}` }),
      );
      child.once("exit", (code, sig) => resolve({ code, signal: sig, error: null }));
      // The backstop: run-claude.mjs ends the call at the cap; this ends a
      // run-claude.mjs that didn't, at hardKillAt.
      const hardKillMs = Date.parse(meta.hardKillAt) - Date.now();
      backstopTimer = setTimeout(
        () => {
          backstop = true;
          appendLog(fs, logFile, "hardKillAt reached with the claude call still running; SIGTERM");
          try {
            child.kill("SIGTERM");
          } catch {
            /* gone */
          }
          const graceMs = (Number(meta.termGraceSec) || 30) * 1000 + 15_000;
          killTimer = setTimeout(() => {
            appendLog(fs, logFile, "still running after SIGTERM; SIGKILL");
            killTree();
          }, graceMs);
        },
        Math.max(0, Number.isFinite(hardKillMs) ? hardKillMs : 0),
      );
    });
    for (const fd of [out, err]) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    childRunning = false;
    // Whatever the run left behind in a group of its own: stopped now.
    clearInterval(following);
    clearTimeout(followSoon);
    follow();
    if (!tracker) {
      // Never got a look at the table: try again before giving up on it.
      for (let i = 0; i < leftover.retries && !tracker; i++) {
        await new Promise((r) => setTimeout(r, leftover.retryMs));
        follow();
      }
      if (!tracker)
        appendLog(fs, logFile, "ps never answered; what the run left behind is unknown");
    }
    // No look at all while claude ran (every read failed), or none ever: what
    // it started can't be known, so the cleanup can't be called clean.
    const unverifiedNow = !tracker || (psFailedWhileRunning && !observedWhileRunning);
    if (unverifiedNow) {
      writeJsonAtomic(fs, path.join(runDir, "leftover.json"), {
        formatVersion: FORMAT_VERSION,
        runId: meta.runId,
        state: UNVERIFIED,
        at: new Date().toISOString(),
        ...(tracker ? trackerIdentities(tracker) : { groups: [], members: [] }),
      });
      appendLog(
        fs,
        logFile,
        "cleanup unverified: ps failed while the run lived; see leftover.json",
      );
    }
    if (!unverifiedNow) cleanup = "clean";
    if (tracker && tracker.groups.size > 0) {
      appendLog(
        fs,
        logFile,
        `stopping what the run left running (groups ${[...tracker.groups].join(", ")})`,
      );
      const supDeps = {
        table,
        kill: (pid, sig) => {
          try {
            signalProcess.kill(pid, sig);
          } catch {
            /* gone */
          }
          return true;
        },
        nowMs: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      };
      // "unknown" (ps failed) is not clean, and neither is "alive": retry,
      // bounded, with the same tracker.
      let left = await stopTracked(tracker, supDeps, leftover.waitMs);
      for (let i = 0; i < leftover.retries && left.state !== "gone"; i++) {
        await new Promise((r) => setTimeout(r, leftover.retryMs));
        left = await stopTracked(tracker, supDeps, leftover.waitMs);
      }
      if (left.state !== "gone" && !unverifiedNow) cleanup = "leftover";
      if (left.state !== "gone" && !fs.existsSync(path.join(runDir, "leftover.json"))) {
        // Hand the cleanup on: status keeps the run alive while these are,
        // and kill / finish stop them before anything is unlocked.
        writeJsonAtomic(fs, path.join(runDir, "leftover.json"), {
          formatVersion: FORMAT_VERSION,
          runId: meta.runId,
          state: left.state,
          at: new Date().toISOString(),
          ...trackerIdentities(tracker),
        });
        appendLog(fs, logFile, `left running (${left.state}); identities in leftover.json`);
      }
    }
    exitCode = exitCodeOf(result.code, result.signal);
    signal = result.signal ?? null;
    error = result.error;
  } catch (e) {
    error = error ?? e.message;
  } finally {
    clearInterval(following);
    clearTimeout(followSoon);
    clearInterval(heartbeat);
    clearTimeout(backstopTimer);
    clearTimeout(killTimer);
    try {
      writeJsonAtomic(fs, path.join(runDir, "exit.json"), {
        formatVersion: FORMAT_VERSION,
        runId: meta?.runId ?? null,
        exitCode,
        signal,
        timedOut: exitCode === 124 || backstop,
        terminated,
        backstop,
        cleanup,
        error,
        startedAt,
        endedAt: new Date().toISOString(),
      });
    } catch (e) {
      appendLog(fs, logFile, `could not write exit.json: ${e.message}`);
    }
    appendLog(
      fs,
      logFile,
      `run ended (exit=${exitCode}, signal=${signal ?? "none"}, terminated=${terminated}, backstop=${backstop}, error=${error ?? "none"})`,
    );
    for (const sig of Object.keys(handlers)) signalProcess.removeListener(sig, handlers[sig]);
  }
  return { exitCode, terminated, backstop, error };
}

// ── finish and kill (in the tick) ───────────────────────────────────────────

// Drop <issue>'s run <runId> from the ledger, unlock its worktree and write
// collected.json. Refused (ok:false, nothing changed) when:
//   - the ledger holds another run, or none (run-id-mismatch);
//   - <expectPid> is given (a number, or null for "never attached") and the
//     run's pid isn't it: attached, or re-attached, since the caller decided
//     (pid-changed);
//   - anything of the run is alive now, or ps can't tell (still-alive /
//     unverifiable): finishing would free a worktree something still works in.
// The same ledger load that is saved checks run id and pid again. Unlock comes
// before that save: a tick that dies between the two leaves a run the next
// tick finishes again, never a locked worktree nothing unlocks. If the save is
// refused after the unlock, the worktree is locked again.
export async function runFinish(
  { stateFile, issue, runId, outcome, repoRoot, expectPid = undefined },
  deps,
) {
  if (!/^[1-9][0-9]*$/.test(String(issue ?? ""))) throw new Error(`invalid --issue: ${issue}`);
  if (!runId) throw new Error("finish requires --run-id");
  if (!outcome || !/^[a-z-]+$/.test(outcome)) throw new Error(`invalid --outcome: ${outcome}`);
  const refuse = (reason) => ({ ok: false, reason, issue: String(issue), runId });
  const before = getImplementRun(await loadFactoryState(stateFile), issue);
  if (!before || before.runId !== String(runId)) return refuse("run-id-mismatch");
  if (expectPid !== undefined && before.pid !== expectPid) return refuse("pid-changed");
  // Including whatever the supervisor recorded it couldn't clean up.
  const leftover = leftoverOf(deps.fs, before.runDir);
  const files = readRunFiles(deps.fs, before);
  if (leftover.problem && !files.cleared) return refuse("leftover-unreadable");
  if (files.unverified) return refuse(UNVERIFIED);
  const rows = deps.table();
  if (!rows) return refuse("unverifiable");
  const tracked = trackRun(before, rows, { selfPids: deps.selfPids, seed: files.leftover });
  if (tracked.alive.length > 0) return refuse("still-alive");
  await unlockWorktree(deps, repoRoot, before.worktree);
  const result = await mutateState(stateFile, (s) => {
    const now = getImplementRun(s, issue);
    if (!now || now.runId !== String(runId) || now.pid !== before.pid) return false;
    return finishImplementRun(s, issue, runId);
  });
  if (!result) {
    if (repoRoot && before.worktree) {
      await deps.git(["worktree", "lock", "--reason", `implement run ${runId}`, before.worktree], {
        cwd: repoRoot,
      });
    }
    return refuse("changed-during-finish");
  }
  if (before.runDir && deps.fs.existsSync(before.runDir)) {
    try {
      writeJsonAtomic(deps.fs, path.join(before.runDir, "collected.json"), {
        formatVersion: FORMAT_VERSION,
        runId,
        outcome,
        at: new Date(deps.nowMs()).toISOString(),
      });
    } catch {
      /* the ledger is the record; this file is for the operator */
    }
  }
  return { ok: true, issue: String(issue), runId, outcome };
}

// ── stopping a run: a tracker kept across polls ─────────────────────────────
// A cancellation remembers every process group it found when it began, and
// every process it has seen in them (pid and start time), and keeps polling
// and signalling those groups until each is gone. Membership is never
// re-derived from a fresh snapshot alone: once the supervisor and claude have
// exited, a group they started (a test runner that called setsid, ignoring
// SIGTERM) has launchd for a parent and nothing in a new snapshot ties it to
// the run any more. A fresh look still ADDS what it finds (an orphaned claude).
//   - A tracked group is dropped for good the first time it has no live
//     member, so a later group that happens to get the same id (its new
//     leader reusing the old pid) is never signalled.
//   - A row whose pid is the group's id but whose start time differs from
//     the leader first seen is that reuse, and drops the group.
//   - Children the run's processes start meanwhile join (known parent pid
//     and start time), groups of their own included.
export function trackRun(run, rows, { selfPids = [], seed = null } = {}) {
  const tracker = {
    run,
    selfPids,
    groups: new Set(),
    // pgid → {present, lstart}: the group's leader as first seen (present:
    // false when it had already exited). A leader pid can't come back while
    // its group exists, so a leader row appearing later, or one with another
    // start time, is a new group that reused the id.
    leaders: new Map(),
    known: new Map(),
    dropped: new Set(),
    alive: [],
  };
  if (seed) seedTracker(tracker, seed);
  tracker.alive = observeRun(tracker, rows);
  return tracker;
}

// Load identities a supervisor wrote to leftover.json (leftoverOf below).
function seedTracker(tracker, seed) {
  for (const g of seed.groups ?? []) {
    if (!Number.isInteger(g.pgid) || g.pgid <= 1) continue;
    tracker.groups.add(g.pgid);
    tracker.leaders.set(g.pgid, {
      present: g.leaderPresent === true,
      lstart: typeof g.leaderLstart === "string" ? g.leaderLstart : null,
    });
  }
  for (const m of seed.members ?? []) {
    if (Number.isInteger(m.pid))
      tracker.known.set(m.pid, typeof m.lstart === "string" ? m.lstart : null);
  }
}

// What a tracker holds, for leftover.json.
export function trackerIdentities(tracker) {
  return {
    groups: [...tracker.groups].map((pgid) => ({
      pgid,
      leaderPresent: tracker.leaders.get(pgid)?.present === true,
      leaderLstart: tracker.leaders.get(pgid)?.lstart ?? null,
    })),
    members: [...tracker.known].map(([pid, lstart]) => ({ pid, lstart })),
  };
}

// Fold a snapshot into <tracker>; returns the tracked groups still alive.
// Identity first, on every poll: a tracked group still counts only while its
// leader is the one first seen (same pid and start time), or, its leader
// gone, while one of its live members is a process already known (same pid
// and start time). A group that fails is a reused id and is dropped for good,
// before its rows can admit anyone: neither its new members nor their
// children are ever tracked. Then, to a fixpoint, members of the groups that
// still match, and children of known processes (alive, same start time) with
// their own groups, join.
export function observeRun(tracker, rows) {
  const live = rows.filter(isLiveRow);
  const own = new Set(rows.filter((r) => tracker.selfPids.includes(r.pid)).map((r) => r.pgid));
  const byPid = new Map(live.map((r) => [r.pid, r]));
  const sameStart = (a, b) => a == null || b == null || a === b;
  const knownRow = (r) => tracker.known.has(r.pid) && sameStart(tracker.known.get(r.pid), r.lstart);
  const knownLive = (pid) => {
    const row = byPid.get(pid);
    return Boolean(row) && knownRow(row);
  };
  const leaderRow = (g) => live.find((r) => r.pid === g && r.pgid === g) ?? null;
  const drop = (g) => {
    tracker.groups.delete(g);
    tracker.dropped.add(g);
  };
  const track = (g) => {
    if (g <= 1 || own.has(g) || tracker.dropped.has(g) || tracker.groups.has(g)) return false;
    tracker.groups.add(g);
    const leader = leaderRow(g);
    tracker.leaders.set(g, { present: Boolean(leader), lstart: leader?.lstart ?? null });
    return true;
  };

  // 1. The groups tracked before this snapshot: still the same groups?
  for (const g of [...tracker.groups]) {
    const first = tracker.leaders.get(g) ?? { present: false, lstart: null };
    const leader = leaderRow(g);
    const matches = leader
      ? first.present && sameStart(first.lstart, leader.lstart)
      : live.some((r) => r.pgid === g && knownRow(r));
    if (!matches) drop(g);
  }
  // 2. The run as a fresh look identifies it (run id, session id, its tree).
  for (const g of runGroups(tracker.run, rows, { selfPids: tracker.selfPids })) track(g);
  // 3. Members of matching groups, and children of known live processes.
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of live) {
      if (knownRow(r)) {
        // A known process now in another group (it called setsid, or its
        // group was changed): that group is the run's too. Not our own, and
        // never a dropped (rejected) id.
        if (!tracker.groups.has(r.pgid) && track(r.pgid)) grew = true;
        continue;
      }
      const member = tracker.groups.has(r.pgid);
      const child = r.ppid > 1 && knownLive(r.ppid);
      if (!member && !child) continue;
      if (!member && !track(r.pgid)) continue;
      tracker.known.set(r.pid, r.lstart ?? null);
      grew = true;
    }
  }
  // 4. Alive: a tracked group with a live member. Empty: dropped for good.
  const alive = [];
  for (const g of [...tracker.groups]) {
    if (live.some((r) => r.pgid === g)) alive.push(g);
    else drop(g);
  }
  return alive;
}

// Poll <tracker> until none of its groups is alive, for at most <ms>.
// Returns {state: "gone"|"alive"|"unknown" (ps failed), groups}.
async function waitTracked(tracker, deps, ms) {
  const until = deps.nowMs() + ms;
  for (;;) {
    const rows = deps.table();
    if (!rows) return { state: "unknown", groups: [...tracker.groups] };
    const groups = observeRun(tracker, rows);
    if (groups.length === 0) return { state: "gone", groups };
    if (deps.nowMs() >= until) return { state: "alive", groups };
    await deps.sleep(POLL_MS);
  }
}

// Stop <run>: SIGTERM every group it has, wait up to <waitMs>, then SIGKILL
// whatever of them is left and wait up to KILL_SETTLE_MS more. Each signal
// goes to the groups the tracker still holds alive at that moment.
export async function stopRun(run, deps, waitMs, { seed = null } = {}) {
  const first = deps.table();
  if (!first) return { state: "unknown", signalled: false, killed: false };
  return stopTracked(trackRun(run, first, { selfPids: deps.selfPids, seed }), deps, waitMs);
}

export async function stopTracked(tracker, deps, waitMs) {
  let w = await waitTracked(tracker, deps, 0);
  let signalled = false;
  let killed = false;
  if (w.state === "alive") {
    signalled = true;
    for (const g of w.groups) deps.kill(-g, "SIGTERM");
    w = await waitTracked(tracker, deps, waitMs);
  }
  if (w.state === "alive") {
    killed = true;
    for (const g of w.groups) deps.kill(-g, "SIGKILL");
    w = await waitTracked(tracker, deps, KILL_SETTLE_MS);
  }
  return { state: w.state, signalled, killed, groups: w.groups };
}

export async function runKill(
  { stateFile, issue, finish = false, outcome = "killed", waitMs = DEFAULT_STOP_WAIT_MS, repoRoot },
  deps,
) {
  if (!/^[1-9][0-9]*$/.test(String(issue ?? ""))) throw new Error(`invalid --issue: ${issue}`);
  const run = getImplementRun(await loadFactoryState(stateFile), issue);
  if (!run) return { ok: true, issue: String(issue), state: "none" };
  const leftover = leftoverOf(deps.fs, run.runDir);
  const files = readRunFiles(deps.fs, run);
  if (leftover.problem && !files.cleared) {
    return {
      ok: false,
      issue: String(issue),
      runId: run.runId,
      state: "unknown",
      reason: leftover.problem,
    };
  }
  const stop = await stopRun(run, deps, waitMs, { seed: files.leftover });
  if (files.unverified) {
    // Whatever it could see is stopped; what it couldn't is still unknown.
    return {
      ok: false,
      issue: String(issue),
      runId: run.runId,
      state: "unknown",
      reason: UNVERIFIED,
      signalled: stop.signalled,
      killed: stop.killed,
    };
  }
  const out = {
    issue: String(issue),
    runId: run.runId,
    state: stop.state,
    signalled: stop.signalled,
    killed: stop.killed,
  };
  if (stop.state !== "gone") return { ok: false, ...out };
  if (!finish) return { ok: true, ...out };
  // Finish only the run this stop was about: same run id, same pid (an attach
  // since then is another supervisor, which runFinish refuses).
  const fin = await runFinish(
    { stateFile, issue, runId: run.runId, outcome, repoRoot, expectPid: run.pid },
    deps,
  );
  return { ok: fin.ok, ...out, finished: fin.ok, ...(fin.ok ? {} : { reason: fin.reason }) };
}

// ── clear (an operator, by hand) ────────────────────────────────────────────
// After checking by hand that nothing of <issue>'s run is running (ps, the
// run's process groups), an operator records it: cleared.json in the run
// dir. Lifts what the factory can't verify on its own (an unverified cleanup,
// an unreadable leftover.json, a supervisor that died without exit.json);
// anything a fresh look still finds alive keeps counting. Refused without
// --confirm 1, and while anything of the run is found alive.
export async function runClear({ stateFile, issue, confirm, note }, deps) {
  if (!/^[1-9][0-9]*$/.test(String(issue ?? ""))) throw new Error(`invalid --issue: ${issue}`);
  const run = getImplementRun(await loadFactoryState(stateFile), issue);
  if (!run) return { ok: false, reason: "no-run", issue: String(issue) };
  if (!confirm) return { ok: false, reason: "confirm-required", issue: String(issue) };
  if (!run.runDir || !deps.fs.existsSync(run.runDir)) return { ok: false, reason: "no-run-dir" };
  const rows = deps.table();
  if (!rows) return { ok: false, reason: "unverifiable", issue: String(issue) };
  const leftover = leftoverOf(deps.fs, run.runDir);
  if (trackRun(run, rows, { selfPids: deps.selfPids, seed: leftover.seed }).alive.length > 0) {
    return { ok: false, reason: "still-alive", issue: String(issue) };
  }
  writeJsonAtomic(deps.fs, path.join(run.runDir, "cleared.json"), {
    formatVersion: FORMAT_VERSION,
    runId: run.runId,
    at: new Date(deps.nowMs()).toISOString(),
    note: String(note),
  });
  return { ok: true, issue: String(issue), runId: run.runId };
}

// ── housekeeping ────────────────────────────────────────────────────────────

export async function runHousekeeping({ stateFile, runRoot, maxAgeDays = 30 }, deps) {
  if (!runRoot || !path.isAbsolute(runRoot)) throw new Error("--run-root must be absolute");
  const days = positiveInt(maxAgeDays, "--max-age-days");
  const fs = deps.fs;
  if (!fs.existsSync(runRoot)) return { ok: true, reaped: [] };
  const state = await loadFactoryState(stateFile);
  const held = new Set(
    Object.values(getImplement(state).runs).flatMap((r) => [r.runDir, r.runId].filter(Boolean)),
  );
  const cutoff = deps.nowMs() - days * 24 * 60 * MINUTE_MS;
  const reaped = [];
  for (const name of fs.readdirSync(runRoot)) {
    if (!RUN_DIR_NAME_RE.test(name)) continue;
    const dir = path.join(runRoot, name);
    const runId = name.slice(name.indexOf("-") + 1);
    if (held.has(dir) || held.has(runId)) continue;
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.mtimeMs > cutoff) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    reaped.push(name);
  }
  return { ok: true, reaped };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

// --pid <n> or --pid none (never attached); absent: not checked.
function parseExpectPid(raw) {
  if (raw == null) return undefined;
  if (raw === "none" || raw === "null") return null;
  if (!/^[1-9][0-9]*$/.test(String(raw))) throw new Error(`invalid --pid: ${raw}`);
  return Number(raw);
}

export async function main(argv, deps = createDeps()) {
  const [sub, ...rest] = argv;
  const { flags } = parseFlags(rest);
  const stateFile = flags["state-file"] ?? DEFAULT_FACTORY_STATE_PATH;
  switch (sub) {
    case "precheck":
      return runPrecheck({ stateFile, maxRunning: flags["max-running"] }, deps);
    case "start":
      if (!flags["spec-file"]) throw new Error("start requires --spec-file");
      return runStart(
        {
          specFile: flags["spec-file"],
          stateFile,
          runRoot: flags["run-root"],
          repoRoot: flags["repo-root"],
        },
        deps,
      );
    case "_supervise":
      if (!flags["run-dir"]) throw new Error("_supervise requires --run-dir");
      return runSupervise({ runDir: flags["run-dir"] }, { env: deps.env, fs: deps.fs });
    case "status":
      return runStatus({ stateFile, issue: flags.issue ?? null }, deps);
    case "kill": {
      const waitMs = flags["wait-ms"] == null ? DEFAULT_STOP_WAIT_MS : Number(flags["wait-ms"]);
      if (!Number.isInteger(waitMs) || waitMs < 0) {
        throw new Error(`invalid --wait-ms: ${flags["wait-ms"]}`);
      }
      return runKill(
        {
          stateFile,
          issue: flags.issue,
          finish: flags.finish === "1",
          outcome: flags.outcome ?? "killed",
          waitMs,
          repoRoot: flags["repo-root"],
        },
        deps,
      );
    }
    case "finish":
      return runFinish(
        {
          stateFile,
          issue: flags.issue,
          runId: flags["run-id"],
          outcome: flags.outcome,
          repoRoot: flags["repo-root"],
          expectPid: parseExpectPid(flags.pid),
        },
        deps,
      );
    case "clear":
      return runClear(
        { stateFile, issue: flags.issue, confirm: flags.confirm === "1", note: flags.note ?? "" },
        deps,
      );
    case "housekeeping":
      return runHousekeeping(
        { stateFile, runRoot: flags["run-root"], maxAgeDays: flags["max-age-days"] ?? 30 },
        deps,
      );
    default:
      throw new Error(
        `unknown subcommand: ${sub ?? "(none)"} (precheck|start|status|kill|finish|clear|housekeeping)`,
      );
  }
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  main(argv)
    .then((out) => {
      // The supervisor's stdout is its log file: it prints nothing.
      if (argv[0] !== "_supervise") process.stdout.write(JSON.stringify(out) + "\n");
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    });
}
