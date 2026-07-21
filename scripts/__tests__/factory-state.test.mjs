import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_FACTORY_STATE_PATH,
  SLOT_COUNT,
  emptyFactoryState,
  loadFactoryState,
  saveFactoryState,
  pauseFactory,
  pauseFactoryUntil,
  resumeFactory,
  isFactoryPaused,
  clearExpiredPause,
  acquireSlot,
  releaseSlot,
  getSlot,
  isSlotFree,
  findSlotForIssue,
  bumpIssueAttempts,
  resetIssueAttempts,
  getIssue,
  setIssueField,
} from "../lib/factory-state.mjs";

let workdir;
let stateFile;

before(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "factory-state-test-"));
  stateFile = path.join(workdir, "factory-state.json");
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(stateFile)) rmSync(stateFile);
});

describe("emptyFactoryState", () => {
  it("returns the documented shape", () => {
    const s = emptyFactoryState();
    assert.equal(s.paused, false);
    assert.equal(s.pausedAt, null);
    assert.equal(s.pausedUntil, null);
    assert.equal(s.pausedReason, null);
    assert.deepEqual(Object.keys(s.slots).sort(), ["0", "1"]);
    assert.deepEqual(s.issues, {});
  });

  it("exposes SLOT_COUNT === 2 (proposal says two parallel worktrees)", () => {
    assert.equal(SLOT_COUNT, 2);
  });
});

describe("load/save round-trip", () => {
  it("returns an empty state when the file is absent", async () => {
    const s = await loadFactoryState(stateFile);
    assert.deepEqual(s, emptyFactoryState());
  });

  it("returns an empty state when the file is whitespace-only (crash mid-write)", async () => {
    writeFileSync(stateFile, "   \n");
    const s = await loadFactoryState(stateFile);
    assert.deepEqual(s, emptyFactoryState());
  });

  it("merges arbitrary parsed shapes against the schema defaults", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        paused: true,
        pausedAt: "2026-05-21T08:00:00.000Z",
        pausedReason: "ops drill",
        // Missing slots — should default to empty slot objects.
        issues: {
          42: { attempts: 3 },
        },
      }),
    );
    const s = await loadFactoryState(stateFile);
    assert.equal(s.paused, true);
    assert.equal(s.pausedReason, "ops drill");
    assert.deepEqual(s.slots["0"], { pid: null, issueNumber: null, acquiredAt: null });
    assert.deepEqual(s.slots["1"], { pid: null, issueNumber: null, acquiredAt: null });
    assert.equal(s.issues["42"].attempts, 3);
  });

  it("coerces slot.pid back to null when persisted value isn't an integer", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        slots: { 0: { pid: "not-a-number", issueNumber: "42", acquiredAt: "x" } },
      }),
    );
    const s = await loadFactoryState(stateFile);
    assert.equal(s.slots["0"].pid, null);
    assert.equal(s.slots["0"].issueNumber, "42");
  });

  it("writes atomically (file appears with final contents only)", async () => {
    const state = emptyFactoryState();
    pauseFactory(state, { reason: "atomic test", now: "2026-05-21T09:00:00.000Z" });
    await saveFactoryState(state, stateFile);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(persisted.paused, true);
    assert.equal(persisted.pausedReason, "atomic test");
  });
});

describe("pause / resume", () => {
  it("pauseFactory stamps reason + timestamp", () => {
    const s = emptyFactoryState();
    pauseFactory(s, { reason: "rolling out", now: "2026-05-21T10:00:00.000Z" });
    assert.equal(isFactoryPaused(s), true);
    assert.equal(s.pausedAt, "2026-05-21T10:00:00.000Z");
    assert.equal(s.pausedReason, "rolling out");
  });

  it("pauseFactory normalises empty reason to null", () => {
    const s = emptyFactoryState();
    pauseFactory(s, { reason: "", now: "2026-05-21T10:00:00.000Z" });
    assert.equal(s.pausedReason, null);
  });

  it("resumeFactory clears all three pause fields", () => {
    const s = emptyFactoryState();
    pauseFactory(s, { reason: "stop", now: "2026-05-21T10:00:00.000Z" });
    resumeFactory(s);
    assert.equal(s.paused, false);
    assert.equal(s.pausedAt, null);
    assert.equal(s.pausedReason, null);
  });

  it("isFactoryPaused tolerates missing state shape", () => {
    assert.equal(isFactoryPaused(null), false);
    assert.equal(isFactoryPaused({}), false);
    assert.equal(isFactoryPaused({ paused: true }), true);
  });
});

describe("timed pause (pause-until / auto-resume)", () => {
  const T0 = "2026-07-21T08:00:00.000Z";
  const T_UNTIL = "2026-07-21T10:30:00.000Z";
  const BEFORE = "2026-07-21T09:00:00.000Z";
  const AFTER = "2026-07-21T11:00:00.000Z";

  it("pauseFactoryUntil sets paused + pausedUntil + reason", () => {
    const s = emptyFactoryState();
    pauseFactoryUntil(s, { until: T_UNTIL, reason: "claude session limit", now: T0 });
    assert.equal(s.paused, true);
    assert.equal(s.pausedAt, T0);
    assert.equal(s.pausedUntil, T_UNTIL);
    assert.equal(s.pausedReason, "claude session limit");
  });

  it("pauseFactoryUntil requires <until>", () => {
    assert.throws(() => pauseFactoryUntil(emptyFactoryState(), {}), /requires <until>/);
  });

  it("isFactoryPaused honours the deadline: paused before, free at/after", () => {
    const s = emptyFactoryState();
    pauseFactoryUntil(s, { until: T_UNTIL, now: T0 });
    assert.equal(isFactoryPaused(s, BEFORE), true);
    assert.equal(isFactoryPaused(s, AFTER), false);
    assert.equal(isFactoryPaused(s, T_UNTIL), false, "exactly at the deadline is no longer paused");
  });

  it("clearExpiredPause resumes only once the deadline has passed", () => {
    const s = emptyFactoryState();
    pauseFactoryUntil(s, { until: T_UNTIL, now: T0 });
    assert.equal(clearExpiredPause(s, BEFORE), false, "not yet expired → untouched");
    assert.equal(s.paused, true);
    assert.equal(clearExpiredPause(s, AFTER), true, "expired → cleared");
    assert.equal(s.paused, false);
    assert.equal(s.pausedUntil, null);
    assert.equal(s.pausedReason, null);
  });

  it("clearExpiredPause never clears a manual (never-expiring) pause", () => {
    const s = emptyFactoryState();
    pauseFactory(s, { reason: "manual", now: T0 });
    assert.equal(clearExpiredPause(s, AFTER), false);
    assert.equal(s.paused, true);
    assert.equal(isFactoryPaused(s, AFTER), true, "manual pause stays paused indefinitely");
  });

  it("a manual pause clears any prior pausedUntil (cannot auto-expire)", () => {
    const s = emptyFactoryState();
    pauseFactoryUntil(s, { until: T_UNTIL, now: T0 });
    pauseFactory(s, { reason: "operator stop", now: T0 });
    assert.equal(s.pausedUntil, null);
    assert.equal(isFactoryPaused(s, AFTER), true);
  });

  it("resumeFactory clears pausedUntil alongside the other pause fields", () => {
    const s = emptyFactoryState();
    pauseFactoryUntil(s, { until: T_UNTIL, now: T0 });
    resumeFactory(s);
    assert.equal(s.paused, false);
    assert.equal(s.pausedUntil, null);
  });

  it("back-compat: a legacy state file without pausedUntil loads as null", async () => {
    writeFileSync(stateFile, JSON.stringify({ paused: true, pausedAt: T0, pausedReason: "old" }));
    const s = await loadFactoryState(stateFile);
    assert.equal(s.pausedUntil, null);
    // With pausedUntil null it behaves as a plain never-expiring pause.
    assert.equal(isFactoryPaused(s, AFTER), true);
    await saveFactoryState(s, stateFile);
    const round = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(round.pausedUntil, null);
  });
});

describe("slot management", () => {
  it("acquireSlot records issueNumber + pid + acquiredAt", () => {
    const s = emptyFactoryState();
    const r = acquireSlot(s, 0, {
      issueNumber: 42,
      pid: 12345,
      now: "2026-05-21T11:00:00.000Z",
    });
    assert.equal(r.issueNumber, "42");
    assert.equal(r.pid, 12345);
    assert.equal(r.acquiredAt, "2026-05-21T11:00:00.000Z");
  });

  it("acquireSlot rejects out-of-range slot indices", () => {
    const s = emptyFactoryState();
    assert.throws(() => acquireSlot(s, 2, { issueNumber: 1 }), /out of range/);
    assert.throws(() => acquireSlot(s, -1, { issueNumber: 1 }), /out of range/);
    assert.throws(() => acquireSlot(s, "foo", { issueNumber: 1 }), /out of range/);
  });

  it("acquireSlot requires <issueNumber>", () => {
    const s = emptyFactoryState();
    assert.throws(() => acquireSlot(s, 0, {}), /requires <issueNumber>/);
  });

  it("releaseSlot clears every field", () => {
    const s = emptyFactoryState();
    acquireSlot(s, 1, { issueNumber: 99, pid: 7, now: "x" });
    releaseSlot(s, 1);
    assert.deepEqual(s.slots["1"], { pid: null, issueNumber: null, acquiredAt: null });
  });

  it("isSlotFree returns true for a fresh slot", () => {
    const s = emptyFactoryState();
    assert.equal(isSlotFree(s, 0), true);
  });

  it("isSlotFree returns false when slot is held by a live pid", () => {
    const s = emptyFactoryState();
    acquireSlot(s, 0, { issueNumber: 1, pid: 999 });
    assert.equal(isSlotFree(s, 0, { isPidAlive: () => true }), false);
  });

  it("isSlotFree returns true when the recorded pid has died (slot can be reclaimed)", () => {
    const s = emptyFactoryState();
    acquireSlot(s, 0, { issueNumber: 1, pid: 999 });
    assert.equal(isSlotFree(s, 0, { isPidAlive: () => false }), true);
  });

  it("findSlotForIssue locates the slot index", () => {
    const s = emptyFactoryState();
    acquireSlot(s, 0, { issueNumber: 42 });
    acquireSlot(s, 1, { issueNumber: 100 });
    assert.equal(findSlotForIssue(s, 42), 0);
    assert.equal(findSlotForIssue(s, 100), 1);
    assert.equal(findSlotForIssue(s, 999), null);
  });

  it("getSlot lazily initialises a missing slot record", () => {
    const s = { slots: {} };
    const slot = getSlot(s, 0);
    assert.deepEqual(slot, { pid: null, issueNumber: null, acquiredAt: null });
  });
});

describe("per-issue counters", () => {
  it("bumpIssueAttempts increments from zero", () => {
    const s = emptyFactoryState();
    assert.equal(bumpIssueAttempts(s, 42), 1);
    assert.equal(bumpIssueAttempts(s, 42), 2);
    assert.equal(bumpIssueAttempts(s, 42), 3);
    assert.equal(s.issues["42"].attempts, 3);
  });

  it("bumpIssueAttempts recovers from a non-integer prior value", () => {
    const s = { issues: { 42: { attempts: "broken" } } };
    assert.equal(bumpIssueAttempts(s, 42), 1);
  });

  it("resetIssueAttempts zeroes the counter without nuking other fields", () => {
    const s = emptyFactoryState();
    bumpIssueAttempts(s, 42);
    setIssueField(s, 42, "lastPlanAt", "2026-05-21T12:00:00.000Z");
    resetIssueAttempts(s, 42);
    assert.equal(s.issues["42"].attempts, 0);
    assert.equal(s.issues["42"].lastPlanAt, "2026-05-21T12:00:00.000Z");
  });

  it("getIssue lazily initialises a missing record with the default shape", () => {
    const s = emptyFactoryState();
    const issue = getIssue(s, 100);
    assert.equal(issue.attempts, 0);
    assert.equal(issue.lastPlanAt, null);
    assert.equal(issue.lastError, null);
  });

  it("setIssueField writes only allowlisted fields", () => {
    const s = emptyFactoryState();
    setIssueField(s, 1, "lastPlanAt", "2026-05-21T12:00:00.000Z");
    assert.equal(s.issues["1"].lastPlanAt, "2026-05-21T12:00:00.000Z");
    assert.throws(() => setIssueField(s, 1, "arbitraryField", "x"), /unknown field/);
  });

  it("tracks lastFeedbackAt (In Test iteration high-water mark)", () => {
    const s = emptyFactoryState();
    assert.equal(s.issues["1"] === undefined || s.issues["1"].lastFeedbackAt == null, true);
    setIssueField(s, 7, "lastFeedbackAt", "2026-05-24T13:00:00.000Z");
    assert.equal(s.issues["7"].lastFeedbackAt, "2026-05-24T13:00:00.000Z");
  });

  it("setIssueField clears the field on empty/null/'null' sentinels", () => {
    const s = emptyFactoryState();
    setIssueField(s, 1, "lastError", "boom");
    setIssueField(s, 1, "lastError", "");
    assert.equal(s.issues["1"].lastError, null);
    setIssueField(s, 1, "lastError", "boom again");
    setIssueField(s, 1, "lastError", "null");
    assert.equal(s.issues["1"].lastError, null);
    setIssueField(s, 1, "lastError", "boom yet again");
    setIssueField(s, 1, "lastError", null);
    assert.equal(s.issues["1"].lastError, null);
  });
});

describe("DEFAULT_FACTORY_STATE_PATH", () => {
  it("points at <repo>/logs/factory-state.json", () => {
    assert.match(DEFAULT_FACTORY_STATE_PATH, /[\/\\]logs[\/\\]factory-state\.json$/);
  });
});
