// Persistent state for the dark factory agent.
//
// File: <repo-root>/logs/factory-state.json — gitignored, perms 0600. Separate
// from logs/support-state.json (used by support-agent.sh) so a wedged support
// run can't corrupt factory state and vice-versa.
//
// Schema:
//   {
//     paused:        boolean,            // global kill switch
//     pausedAt:      ISO-8601 | null,
//     pausedUntil:   ISO-8601 | null,    // timed auto-resume (session-limit
//                                        // backoff). null = manual pause that
//                                        // never expires. See isFactoryPaused.
//     pausedReason:  string | null,
//     slots: {
//       "0": { pid: number|null, issueNumber: string|null, acquiredAt: ISO|null },
//       "1": { pid: number|null, issueNumber: string|null, acquiredAt: ISO|null }
//     },
//     issues: {
//       "<n>": {
//         attempts:        number,        // /push-style retry counter
//         lastPlanAt:      ISO|null,
//         lastImplementAt: ISO|null,
//         lastWatchAt:     ISO|null,
//         lastReleaseAt:   ISO|null,
//         lastBeta:        ISO|null,      // last beta build dispatch (Phase D)
//         lastProd:        ISO|null,      // last prod merge
//         lastStatus:      string|null,   // last Status value the factory set
//         lastError:       string|null    // most recent failure message (for ops)
//         …plus the In Test, code-review and CodeRabbit-lane keys documented
//         in emptyIssue() below.
//       }
//     },
//     crCli: {                             // CodeRabbit CLI gap-fill lane (ADR-0036)
//       runs:     [ { runId, issue, sha, startedAt } ],   // rolling budget ledger, 24 h
//       inFlight: null | { runId, issue, pr, sha, baseSha, mode, pid,
//                          startedAt, deadlineAt, runDir, worktree },
//       pausedUntil:  ISO|null,           // lane-only pause (vendor rate limit,
//       pausedReason: string|null         // auth). Never pauses the factory.
//     }
//   }
//
// Atomic writes use the same temp-file + rename pattern as state.mjs. **Callers
// must serialize** loadFactoryState → mutate → saveFactoryState; the only
// process writing this file in production is the factory-agent (which holds a
// PID-file lock), so today that holds.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const DEFAULT_FACTORY_STATE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "logs",
  "factory-state.json",
);

export const SLOT_COUNT = 2;

export function emptyFactoryState() {
  return {
    paused: false,
    pausedAt: null,
    pausedUntil: null,
    pausedReason: null,
    slots: {
      0: emptySlot(),
      1: emptySlot(),
    },
    issues: {},
    crCli: emptyCrCli(),
  };
}

export function emptyCrCli() {
  return { runs: [], inFlight: null, pausedUntil: null, pausedReason: null };
}

function emptySlot() {
  return { pid: null, issueNumber: null, acquiredAt: null };
}

function emptyIssue() {
  return {
    attempts: 0,
    lastPlanAt: null,
    lastImplementAt: null,
    lastWatchAt: null,
    lastReleaseAt: null,
    lastBeta: null,
    lastProd: null,
    lastStatus: null,
    lastError: null,
    // High-water mark: the createdAt of the newest reporter feedback comment
    // the factory has already consumed. The In Test feedback sweep only treats
    // comments newer than this as new change requests, so a handled comment
    // never re-triggers a revision.
    lastFeedbackAt: null,
    // In Test hand-off idempotency, keyed on the PR head SHA rather than a
    // monotonic marker: silent while the SHA is unchanged, re-armed by new
    // commits, so an In Test → feedback → In Test round trip gets a fresh
    // scenario and a fresh beta build. See ADR-0030.
    intestCommentSha: null, // head SHA the last In Test comment was written for
    intestBetaSha: null, // head SHA beta lanes were last dispatched for
    intestBetaAt: null,
    intestBetaLanes: null,
    // Per-lane attempt counters, "mobile:2,desktop:1". Drives both the retry
    // cap and the per-ATTEMPT artefact path — keying the log/.exit on the
    // commit alone let a retry share files with the attempt it replaced.
    intestBetaAttempts: null,
    // Head SHA the code-review stage last ran against, so --watch reviews each
    // commit exactly once. Re-armed by every new push, which is what makes a
    // fix-then-re-review cycle converge instead of repeating. See ADR-0035.
    lastReviewSha: null,
    // CodeRabbit CLI gap-fill lane (ADR-0036). All head-SHA keyed, like the
    // keys above, so a new push re-arms the lane rather than inheriting a
    // decision made about code that no longer exists.
    crConvergedSha: null, // head SHA first seen fully converged (green, reviewed, no threads)
    crConvergedAt: null, // …and when: the anchor for the bot grace period and the hold cap
    crCoverageSha: null, // head SHA the lane last reached a final decision for
    crCoverage: null, // bot|cli|cli-empty|cli-partial|cli-failed|budget|hold-expired|cap-reached|cli-unavailable
    crLastCoveredSha: null, // last SHA CodeRabbit (bot or CLI) reviewed: the incremental base
    crCliRuns: null, // decimal string: CLI runs spent on this card since its last In Test
    crCliFreePassSha: null, // crLastCoveredSha whose findings already got an attempt-free fix pass
  };
}

export async function loadFactoryState(filePath = DEFAULT_FACTORY_STATE_PATH) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return emptyFactoryState();
    const parsed = JSON.parse(raw);
    return mergeWithDefaults(parsed);
  } catch (err) {
    if (err.code === "ENOENT") return emptyFactoryState();
    throw err;
  }
}

export async function saveFactoryState(state, filePath = DEFAULT_FACTORY_STATE_PATH) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const suffix = randomBytes(6).toString("hex");
  const tmp = `${filePath}.${suffix}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function mergeWithDefaults(parsed) {
  const base = emptyFactoryState();
  if (!parsed || typeof parsed !== "object") return base;
  const slotsIn = parsed.slots && typeof parsed.slots === "object" ? parsed.slots : {};
  return {
    paused: Boolean(parsed.paused),
    pausedAt: typeof parsed.pausedAt === "string" ? parsed.pausedAt : null,
    // Absent in legacy files → null, i.e. a plain never-expiring pause. This is
    // the whole back-compat story: old state loads as a manual pause, and old
    // code reading a new file simply drops the field (also a plain pause).
    pausedUntil: typeof parsed.pausedUntil === "string" ? parsed.pausedUntil : null,
    pausedReason: typeof parsed.pausedReason === "string" ? parsed.pausedReason : null,
    slots: {
      0: mergeSlot(slotsIn["0"]),
      1: mergeSlot(slotsIn["1"]),
    },
    issues: parsed.issues && typeof parsed.issues === "object" ? parsed.issues : base.issues,
    // Every top-level key must be listed here: anything this function doesn't
    // return is silently erased by the next save. The crCli ledger was nearly
    // lost that way — an unrelated `factory:bump-attempts` would have wiped an
    // in-flight run's record, orphaning its worktree and refunding nothing.
    crCli: mergeCrCli(parsed.crCli),
  };
}

function strOrNull(v) {
  return typeof v === "string" && v !== "" ? v : v == null || v === "" ? null : String(v);
}

function mergeCrCli(raw) {
  const base = emptyCrCli();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const runs = Array.isArray(raw.runs)
    ? raw.runs
        .filter(
          (r) =>
            r &&
            typeof r === "object" &&
            typeof r.runId === "string" &&
            r.runId !== "" &&
            typeof r.startedAt === "string",
        )
        .map((r) => ({
          runId: r.runId,
          issue: strOrNull(r.issue),
          sha: strOrNull(r.sha),
          startedAt: r.startedAt,
        }))
    : [];
  return {
    runs,
    inFlight: mergeInFlight(raw.inFlight),
    pausedUntil: typeof raw.pausedUntil === "string" ? raw.pausedUntil : null,
    pausedReason: typeof raw.pausedReason === "string" ? raw.pausedReason : null,
  };
}

function mergeInFlight(f) {
  // An in-flight record without a runId can't be finished (finish matches on
  // runId), so it would block the lane forever: treat it as absent.
  if (!f || typeof f !== "object" || typeof f.runId !== "string" || f.runId === "") return null;
  return {
    runId: f.runId,
    issue: strOrNull(f.issue),
    pr: strOrNull(f.pr),
    sha: strOrNull(f.sha),
    baseSha: strOrNull(f.baseSha),
    mode: strOrNull(f.mode),
    pid: Number.isInteger(f.pid) ? f.pid : null,
    startedAt: strOrNull(f.startedAt),
    deadlineAt: strOrNull(f.deadlineAt),
    runDir: strOrNull(f.runDir),
    worktree: strOrNull(f.worktree),
  };
}

function mergeSlot(slot) {
  const base = emptySlot();
  if (!slot || typeof slot !== "object") return base;
  const pid = Number.isInteger(slot.pid) ? slot.pid : null;
  return {
    pid,
    issueNumber:
      slot.issueNumber == null || slot.issueNumber === "" ? null : String(slot.issueNumber),
    acquiredAt: typeof slot.acquiredAt === "string" ? slot.acquiredAt : null,
  };
}

// ── pause flag ──────────────────────────────────────────────────────────────

export function pauseFactory(state, { reason = null, now = new Date().toISOString() } = {}) {
  state.paused = true;
  state.pausedAt = now;
  // Manual pause overrides any timed pause and never auto-expires.
  state.pausedUntil = null;
  state.pausedReason = reason == null || reason === "" ? null : String(reason);
  return state;
}

// Time-bounded pause: `paused?` reports not-paused once now >= <until> and the
// next tick auto-resumes. Used for session-limit backoff — the factory parks
// itself until the limit resets instead of burning per-issue retry attempts.
export function pauseFactoryUntil(
  state,
  { until, reason = null, now = new Date().toISOString() } = {},
) {
  if (until == null || until === "") {
    throw new Error("pauseFactoryUntil requires <until>");
  }
  state.paused = true;
  state.pausedAt = now;
  state.pausedUntil = String(until);
  state.pausedReason = reason == null || reason === "" ? null : String(reason);
  return state;
}

export function resumeFactory(state) {
  state.paused = false;
  state.pausedAt = null;
  state.pausedUntil = null;
  state.pausedReason = null;
  return state;
}

export function isFactoryPaused(state, now = new Date().toISOString()) {
  if (!state?.paused) return false;
  // A timed pause (pausedUntil set) is over once now has reached it; a manual
  // pause (pausedUntil null) stays paused indefinitely.
  if (state.pausedUntil == null) return true;
  return now < state.pausedUntil;
}

// Auto-resume a timed pause whose deadline has passed. Returns true (and clears
// the pause in place) only when an expired timed pause was cleared; a manual
// pause or a still-pending timed pause is left untouched.
export function clearExpiredPause(state, now = new Date().toISOString()) {
  if (!state?.paused || state.pausedUntil == null) return false;
  if (now < state.pausedUntil) return false;
  resumeFactory(state);
  return true;
}

// ── slot management ─────────────────────────────────────────────────────────

function normaliseSlotIndex(slotIndex) {
  const n = Number(slotIndex);
  if (!Number.isInteger(n) || n < 0 || n >= SLOT_COUNT) {
    throw new Error(`slot index out of range (0..${SLOT_COUNT - 1}): ${slotIndex}`);
  }
  return String(n);
}

export function getSlot(state, slotIndex) {
  const key = normaliseSlotIndex(slotIndex);
  state.slots ??= { 0: emptySlot(), 1: emptySlot() };
  state.slots[key] ??= emptySlot();
  return state.slots[key];
}

// Returns true if slot is unoccupied OR its recorded pid is no longer alive.
// The caller is responsible for whatever real mutual-exclusion lock it needs
// (factory-agent.sh holds an flock on logs/factory.slot{0,1}.pid). This is
// just the bookkeeping check; callers should still flock before mutating.
export function isSlotFree(state, slotIndex, { isPidAlive } = {}) {
  const slot = getSlot(state, slotIndex);
  // Explicit null checks (vs `!slot.pid`) so a hypothetical pid 0 — the kernel
  // scheduler, never a user process — wouldn't be misread as "no pid recorded".
  if (slot.pid == null && slot.issueNumber == null) return true;
  // If a pid is recorded but the process is gone, treat the slot as free —
  // the prior run crashed without releasing. Same liveness check the agent
  // uses for the support-agent lockfile.
  if (slot.pid != null && typeof isPidAlive === "function") {
    return !isPidAlive(slot.pid);
  }
  return false;
}

export function acquireSlot(
  state,
  slotIndex,
  { issueNumber, pid = null, now = new Date().toISOString() } = {},
) {
  if (issueNumber == null || issueNumber === "") {
    throw new Error("acquireSlot requires <issueNumber>");
  }
  const key = normaliseSlotIndex(slotIndex);
  state.slots ??= { 0: emptySlot(), 1: emptySlot() };
  state.slots[key] = {
    pid: Number.isInteger(pid) ? pid : null,
    issueNumber: String(issueNumber),
    acquiredAt: now,
  };
  return state.slots[key];
}

export function releaseSlot(state, slotIndex) {
  const key = normaliseSlotIndex(slotIndex);
  state.slots ??= { 0: emptySlot(), 1: emptySlot() };
  state.slots[key] = emptySlot();
  return state.slots[key];
}

// Returns the slot index (0 or 1) currently assigned to <issueNumber>, or
// null if not assigned. Used by --watch to find which worktree to resume in.
export function findSlotForIssue(state, issueNumber) {
  const target = String(issueNumber);
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slot = state?.slots?.[String(i)];
    if (slot && String(slot.issueNumber ?? "") === target) return i;
  }
  return null;
}

// ── per-issue counters ──────────────────────────────────────────────────────

export function getIssue(state, issueNumber) {
  const key = String(issueNumber);
  state.issues ??= {};
  state.issues[key] ??= emptyIssue();
  return state.issues[key];
}

export function bumpIssueAttempts(state, issueNumber) {
  const issue = getIssue(state, issueNumber);
  issue.attempts = (Number.isInteger(issue.attempts) ? issue.attempts : 0) + 1;
  return issue.attempts;
}

export function resetIssueAttempts(state, issueNumber) {
  const issue = getIssue(state, issueNumber);
  issue.attempts = 0;
  return issue.attempts;
}

// Allowed issue fields a CLI caller may mutate. Restricting the set keeps
// bash callers from accidentally polluting the schema with typo'd field
// names (e.g. `lastPanAt`).
const MUTABLE_ISSUE_FIELDS = new Set([
  "lastPlanAt",
  "lastImplementAt",
  "lastWatchAt",
  "lastReleaseAt",
  "lastBeta",
  "lastProd",
  "lastStatus",
  "lastError",
  "lastFeedbackAt",
  // In Test hand-off idempotency keys (ADR-0030). These MUST be writable: every
  // bash write is `|| true`, so a rejected field fails silently and the factory
  // would re-post the scenario comment and re-dispatch beta builds every tick.
  "intestCommentSha",
  "intestBetaSha",
  "intestBetaAt",
  "intestBetaLanes",
  "intestBetaAttempts",
  // Code-review stage idempotency key (ADR-0035): the head SHA the review stage
  // last ran against. Same silent-failure hazard as the In Test keys above — a
  // rejected field would make --watch re-review (and re-comment on) every tick.
  "lastReviewSha",
  // CodeRabbit CLI lane keys (ADR-0036). Same hazard again, with a worse
  // failure: a rejected crConvergedAt resets the grace clock every tick (the
  // card holds forever), and a rejected crCoverageSha re-decides — and can
  // re-spend CLI budget on — a SHA that was already settled.
  "crConvergedSha",
  "crConvergedAt",
  "crCoverageSha",
  "crCoverage",
  "crLastCoveredSha",
  "crCliRuns",
  "crCliFreePassSha",
]);

export function setIssueField(state, issueNumber, field, value) {
  if (!MUTABLE_ISSUE_FIELDS.has(field)) {
    throw new Error(`setIssueField: unknown field ${field}`);
  }
  const issue = getIssue(state, issueNumber);
  // Empty string / "null" → null; everything else → trimmed string.
  if (value == null || value === "" || value === "null") {
    issue[field] = null;
  } else {
    issue[field] = String(value);
  }
  return issue[field];
}

// ── CodeRabbit CLI lane ledger (ADR-0036) ───────────────────────────────────
//
// The vendor allows 3 CLI reviews per developer per rolling hour, and concurrent
// runs from one account fail ("WebSocket subscription completed unexpectedly").
// So the ledger enforces both: at most one run in flight, and at most
// <maxPerHour> starts in any trailing hour. It undercounts (interactive CLI use
// by the same developer isn't recorded here), so the vendor's own rate-limit
// error — which pauses the lane via pauseCrCli — stays the authoritative signal.
//
// Only in-tick callers (under the factory loop's mutex) mutate this. The
// detached review supervisor never writes state — see coderabbit-cli.mjs.
//
// Times are compared numerically (Date.parse), not lexicographically like the
// factory pause above: bash writes second-precision stamps (…:00Z) and node
// writes millisecond ones (…:00.000Z), and "Z" sorts after "." — a string
// compare between the two would misorder by up to a second either way.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CR_CLI_REFUNDS = new Set(["none", "spawn", "card"]);

function ms(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function nowMs(now) {
  const t = ms(now);
  if (t == null) throw new Error(`invalid <now>: ${now}`);
  return t;
}

// Shallow, IN-PLACE normalisation: callers hold the returned object across
// several helper calls, so replacing it here would leave them mutating a copy
// that never reaches the save. Deep normalisation of a hand-edited or legacy
// file happens once, at load (mergeCrCli).
export function getCrCli(state) {
  const cur = state.crCli;
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) {
    state.crCli = emptyCrCli();
    return state.crCli;
  }
  if (!Array.isArray(cur.runs)) cur.runs = [];
  if (!cur.inFlight || typeof cur.inFlight !== "object" || typeof cur.inFlight.runId !== "string") {
    cur.inFlight = null;
  }
  if (typeof cur.pausedUntil !== "string") cur.pausedUntil = null;
  if (typeof cur.pausedReason !== "string") cur.pausedReason = null;
  return cur;
}

// Drop ledger entries older than <keepMs> (and any with an unparseable start).
// The budget only looks back one hour; the extra day keeps a readable history
// in `factory:cr-cli-status` without letting the file grow without bound.
export function pruneCrCliRuns(state, now, keepMs = DAY_MS) {
  const crCli = getCrCli(state);
  const floor = nowMs(now) - keepMs;
  crCli.runs = crCli.runs.filter((r) => {
    const t = ms(r.startedAt);
    return t != null && t >= floor;
  });
  return crCli.runs;
}

// A run counts against the window while it started less than <windowMs> ago;
// the slot it holds frees at startedAt + windowMs.
export function crCliUsage(state, { now, windowMs = HOUR_MS } = {}) {
  const crCli = getCrCli(state);
  const current = nowMs(now);
  const inWindow = crCli.runs
    .map((r) => ms(r.startedAt))
    .filter((t) => t != null && current - t < windowMs)
    .sort((a, b) => a - b);
  return {
    usedLastHour: inWindow.length,
    nextSlotAt: inWindow.length > 0 ? new Date(inWindow[0] + windowMs).toISOString() : null,
  };
}

export function isCrCliPaused(state, now) {
  const crCli = getCrCli(state);
  const until = ms(crCli.pausedUntil);
  if (until == null) return false;
  return nowMs(now) < until;
}

// Returns true (and clears the pause in place) only when an expired pause was
// cleared. An unparseable pausedUntil is cleared too: the lane pause is always
// timed, and a value no comparison can ever expire would stall it for good.
export function clearExpiredCrCliPause(state, now) {
  const crCli = getCrCli(state);
  if (crCli.pausedUntil == null) return false;
  const until = ms(crCli.pausedUntil);
  if (until != null && nowMs(now) < until) return false;
  resumeCrCli(state);
  return true;
}

// Lane-only pause. Deliberately separate from pauseFactoryUntil: a vendor rate
// limit on a free review tier must never stop planning, implementing or shipping.
export function pauseCrCli(state, { until, reason = null } = {}) {
  const t = ms(until);
  if (until == null || until === "" || t == null) {
    throw new Error(`pauseCrCli requires a valid <until>: ${until}`);
  }
  const crCli = getCrCli(state);
  crCli.pausedUntil = new Date(t).toISOString();
  crCli.pausedReason = reason == null || reason === "" ? null : String(reason);
  return crCli;
}

export function resumeCrCli(state) {
  const crCli = getCrCli(state);
  crCli.pausedUntil = null;
  crCli.pausedReason = null;
  return crCli;
}

function adjustCardRuns(state, issueNumber, delta) {
  const issue = getIssue(state, issueNumber);
  const next = Math.max(0, (Number(issue.crCliRuns) || 0) + delta);
  // Stored as a string like every other bash-writable issue field, so a bash
  // `factory:set-issue-field <n> crCliRuns ""` reset reads back as 0.
  issue.crCliRuns = String(next);
  return next;
}

// Claim the lane for one run. The budget entry and the per-card counter are
// written in the SAME save as the in-flight record, so a tick that dies between
// "reserve" and "spawn" leaves a run that housekeeping can find (pid null) and
// finish with a refund — never a silently spent slot.
export function reserveCrCliRun(state, { issue, sha, pr = null, runId, maxPerHour, now } = {}) {
  if (issue == null || issue === "") throw new Error("reserveCrCliRun requires <issue>");
  if (sha == null || sha === "") throw new Error("reserveCrCliRun requires <sha>");
  if (runId == null || runId === "") throw new Error("reserveCrCliRun requires <runId>");
  const max = Number(maxPerHour);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`reserveCrCliRun: invalid <maxPerHour>: ${maxPerHour}`);
  }
  nowMs(now);
  const crCli = getCrCli(state);
  clearExpiredCrCliPause(state, now);
  if (isCrCliPaused(state, now)) {
    return {
      ok: false,
      reason: "paused",
      pausedUntil: crCli.pausedUntil,
      pausedReason: crCli.pausedReason,
    };
  }
  if (crCli.inFlight) {
    return { ok: false, reason: "busy", inFlight: crCli.inFlight };
  }
  pruneCrCliRuns(state, now);
  const usage = crCliUsage(state, { now });
  if (usage.usedLastHour >= max) {
    return { ok: false, reason: "budget", nextSlotAt: usage.nextSlotAt };
  }
  const entry = { runId: String(runId), issue: String(issue), sha: String(sha), startedAt: now };
  crCli.runs.push(entry);
  crCli.inFlight = {
    runId: entry.runId,
    issue: entry.issue,
    pr: pr == null || pr === "" ? null : String(pr),
    sha: entry.sha,
    baseSha: null,
    mode: null,
    pid: null,
    startedAt: now,
    deadlineAt: null,
    runDir: null,
    worktree: null,
  };
  adjustCardRuns(state, issue, +1);
  return { ok: true, runId: entry.runId };
}

// Fill in what is only known once the supervisor has actually started. Matches
// on runId so a late attach from a superseded run can't overwrite a newer one.
export function attachCrCliRun(
  state,
  runId,
  {
    pid = null,
    baseSha = null,
    mode = null,
    deadlineAt = null,
    runDir = null,
    worktree = null,
  } = {},
) {
  const crCli = getCrCli(state);
  if (!crCli.inFlight || crCli.inFlight.runId !== String(runId)) return false;
  Object.assign(crCli.inFlight, {
    pid: Number.isInteger(pid) ? pid : null,
    baseSha: strOrNull(baseSha),
    mode: strOrNull(mode),
    deadlineAt: strOrNull(deadlineAt),
    runDir: strOrNull(runDir),
    worktree: strOrNull(worktree),
  });
  return true;
}

// Release the lane. refund:
//   none  — the review ran (or failed after starting): budget and card cap spent.
//   spawn — it never started: give back both the hourly slot and the card run.
//   card  — the vendor refused it (rate limit), or housekeeping terminated it
//           because the PR head moved on or the PR closed: the hourly slot WAS
//           consumed on the vendor's side, so keep the ledger entry, but don't
//           let a refusal or a superseded run use up the card's per-card cap.
export function finishCrCliRun(
  state,
  runId,
  { refund = "none", now = new Date().toISOString() } = {},
) {
  if (!CR_CLI_REFUNDS.has(refund)) {
    throw new Error(`finishCrCliRun: invalid refund ${refund} (none|spawn|card)`);
  }
  const crCli = getCrCli(state);
  if (!crCli.inFlight || crCli.inFlight.runId !== String(runId)) {
    return { ok: false, reason: "run-id-mismatch", inFlight: crCli.inFlight };
  }
  const { issue } = crCli.inFlight;
  crCli.inFlight = null;
  if (refund === "spawn") {
    crCli.runs = crCli.runs.filter((r) => r.runId !== String(runId));
  }
  if (refund !== "none" && issue != null) {
    adjustCardRuns(state, issue, -1);
  }
  pruneCrCliRuns(state, now);
  return { ok: true, runId: String(runId), refund, issue };
}
