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
//       }
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
    pausedReason: null,
    slots: {
      0: emptySlot(),
      1: emptySlot(),
    },
    issues: {},
  };
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
    pausedReason: typeof parsed.pausedReason === "string" ? parsed.pausedReason : null,
    slots: {
      0: mergeSlot(slotsIn["0"]),
      1: mergeSlot(slotsIn["1"]),
    },
    issues: parsed.issues && typeof parsed.issues === "object" ? parsed.issues : base.issues,
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
  state.pausedReason = reason == null || reason === "" ? null : String(reason);
  return state;
}

export function resumeFactory(state) {
  state.paused = false;
  state.pausedAt = null;
  state.pausedReason = null;
  return state;
}

export function isFactoryPaused(state) {
  return Boolean(state?.paused);
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
  if (!slot.pid && !slot.issueNumber) return true;
  // If a pid is recorded but the process is gone, treat the slot as free —
  // the prior run crashed without releasing. Same liveness check the agent
  // uses for the support-agent lockfile.
  if (slot.pid && typeof isPidAlive === "function") {
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
