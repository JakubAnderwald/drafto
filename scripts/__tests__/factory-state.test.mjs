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
  emptyBrowser,
  resetBrowser,
  emptyVerify,
  VERIFY_ISSUE_FIELDS,
  shaKeyedCount,
  getVerify,
  isVerifyPaused,
  clearExpiredVerifyPause,
  pauseVerify,
  resumeVerify,
  reserveVerifyRun,
  attachVerifyRun,
  finishVerifyRun,
  verifyIssueRecords,
  resetIssueVerify,
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

  it("tracks ciRerun (cancelled-check re-run budget) and clears it on reset", () => {
    // A rejected write fails silently in bash (`|| true`), which would re-run CI
    // every tick and never tell the operator — so the field must be writable.
    const s = emptyFactoryState();
    assert.equal(getIssue(s, 9).ciRerun, null);
    setIssueField(s, 9, "ciRerun", "5a5201f119ea5c7020b17bc5f098ceed4841c80f:1");
    assert.equal(s.issues["9"].ciRerun, "5a5201f119ea5c7020b17bc5f098ceed4841c80f:1");
    setIssueField(s, 9, "ciRerun", "");
    assert.equal(s.issues["9"].ciRerun, null);
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

describe("browser runner record", () => {
  it("emptyFactoryState carries an empty browser record", () => {
    assert.deepEqual(emptyFactoryState().browser, emptyBrowser());
    assert.deepEqual(emptyBrowser(), {
      consecutiveBad: 0,
      lastResult: null,
      lastResultAt: null,
      unavailableSince: null,
      reason: null,
      alertedAt: null,
      disabled: false,
      disabledReason: null,
    });
  });

  it("a legacy file without browser loads the empty record", async () => {
    writeFileSync(stateFile, JSON.stringify({ paused: false, issues: {} }));
    assert.deepEqual((await loadFactoryState(stateFile)).browser, emptyBrowser());
  });

  it("round-trips a populated record through save/load", async () => {
    const s = emptyFactoryState();
    s.browser = {
      ...emptyBrowser(),
      consecutiveBad: 2,
      lastResult: "unavailable",
      lastResultAt: "2026-10-17T10:05:00.000Z",
      unavailableSince: "2026-10-17T10:00:00.000Z",
      reason: "unavailable",
      alertedAt: "2026-10-17T10:05:00.000Z",
    };
    await saveFactoryState(s, stateFile);
    assert.deepEqual((await loadFactoryState(stateFile)).browser, s.browser);
  });

  it("normalises garbage fields, fails safe on the latch, and passes unknown keys through", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        browser: {
          consecutiveBad: "3",
          reason: 7,
          alertedAt: "",
          disabled: "yes",
          disabledReason: "guard-not-loaded",
          newerField: { kept: true },
        },
      }),
    );
    const { browser } = await loadFactoryState(stateFile);
    assert.equal(browser.consecutiveBad, 0);
    assert.equal(browser.reason, null);
    assert.equal(browser.alertedAt, null);
    assert.equal(browser.disabled, true, "truthy garbage keeps the browser off");
    assert.equal(browser.disabledReason, "guard-not-loaded");
    assert.deepEqual(browser.newerField, { kept: true });
  });

  it("a non-object browser (array / string / negative streak) loads as the empty record", async () => {
    writeFileSync(stateFile, JSON.stringify({ browser: ["nope"] }));
    assert.deepEqual((await loadFactoryState(stateFile)).browser, emptyBrowser());
    writeFileSync(stateFile, JSON.stringify({ browser: "nope" }));
    assert.deepEqual((await loadFactoryState(stateFile)).browser, emptyBrowser());
    writeFileSync(stateFile, JSON.stringify({ browser: { consecutiveBad: -2 } }));
    assert.equal((await loadFactoryState(stateFile)).browser.consecutiveBad, 0);
  });

  it("resetBrowser replaces the record with an empty one", () => {
    const s = emptyFactoryState();
    s.browser = { ...emptyBrowser(), disabled: true, disabledReason: "guard-not-loaded" };
    assert.deepEqual(resetBrowser(s), emptyBrowser());
    assert.deepEqual(s.browser, emptyBrowser());
  });

  it("tracks browserRunSha / browserRunAttempts per issue (writable, cleared on empty)", () => {
    // A rejected write fails silently in bash (`|| true`): the browser would
    // re-run and re-post its report every tick.
    const s = emptyFactoryState();
    assert.equal(getIssue(s, 9).browserRunSha, null);
    assert.equal(getIssue(s, 9).browserRunAttempts, null);
    const sha = "5a5201f119ea5c7020b17bc5f098ceed4841c80f";
    setIssueField(s, 9, "browserRunSha", sha);
    setIssueField(s, 9, "browserRunAttempts", `${sha}:2`);
    assert.equal(s.issues["9"].browserRunSha, sha);
    assert.equal(s.issues["9"].browserRunAttempts, `${sha}:2`);
    setIssueField(s, 9, "browserRunAttempts", "");
    assert.equal(s.issues["9"].browserRunAttempts, null);
  });
});

describe("verification stage (ADR-0053): verify ledger", () => {
  const T0 = "2026-10-20T20:00:00.000Z";
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const minutesAfter = (iso, m) => new Date(Date.parse(iso) + m * 60_000).toISOString();
  const reserve = (state, overrides = {}) =>
    reserveVerifyRun(state, {
      issue: "42",
      sha: SHA_A,
      pr: "700",
      runId: "verify-1",
      maxAttempts: 2,
      now: T0,
      ...overrides,
    });

  it("emptyFactoryState carries an idle, unpaused ledger", () => {
    assert.deepEqual(emptyVerify(), { inFlight: null, pausedUntil: null, pausedReason: null });
    assert.deepEqual(emptyFactoryState().verify, emptyVerify());
  });

  it("a legacy file without verify loads the empty ledger (older factories never wrote one)", async () => {
    writeFileSync(stateFile, JSON.stringify({ paused: false, slots: {}, issues: { 7: {} } }));
    assert.deepEqual((await loadFactoryState(stateFile)).verify, emptyVerify());
  });

  it("a non-object verify (array / string / number) loads as the empty ledger", async () => {
    for (const bad of [["nope"], "nope", 7]) {
      writeFileSync(stateFile, JSON.stringify({ verify: bad }));
      assert.deepEqual((await loadFactoryState(stateFile)).verify, emptyVerify());
    }
  });

  it("normalises garbage and passes unknown keys through (a newer factory's fields survive)", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        verify: {
          inFlight: { runId: "r1", issue: 42, pid: "123", sha: SHA_A, qaTag: "qa-1" },
          pausedUntil: 5,
          pausedReason: ["x"],
          newerLedgerField: { kept: true },
        },
      }),
    );
    const { verify } = await loadFactoryState(stateFile);
    assert.equal(verify.inFlight.runId, "r1");
    assert.equal(verify.inFlight.issue, "42");
    assert.equal(verify.inFlight.pid, null, "a non-integer pid can't be signalled");
    assert.equal(verify.inFlight.deadlineAt, null);
    assert.equal(verify.inFlight.qaTag, "qa-1");
    assert.equal(verify.pausedUntil, null);
    assert.equal(verify.pausedReason, null);
    assert.deepEqual(verify.newerLedgerField, { kept: true });
  });

  it("drops an in-flight record without a runId (it could never be finished)", async () => {
    for (const inFlight of [{ pid: 1 }, { runId: "" }, ["r1"], "r1"]) {
      writeFileSync(stateFile, JSON.stringify({ verify: { inFlight } }));
      assert.equal((await loadFactoryState(stateFile)).verify.inFlight, null);
    }
  });

  it("an attached run survives save → load with its pid kept as an integer", async () => {
    const s = emptyFactoryState();
    reserve(s);
    attachVerifyRun(s, "verify-1", {
      pid: 4242,
      deadlineAt: minutesAfter(T0, 30),
      runDir: "/tmp/verify-1",
      worktree: "/tmp/wt",
    });
    await saveFactoryState(s, stateFile);
    const loaded = await loadFactoryState(stateFile);
    assert.deepEqual(loaded.verify, s.verify);
    assert.equal(loaded.verify.inFlight.pid, 4242);
    assert.equal(loaded.issues["42"].verifyShellAttempts, `${SHA_A}:1`);
  });

  it("getVerify creates a missing ledger and normalises in place", () => {
    const bare = {};
    assert.deepEqual(getVerify(bare), emptyVerify());
    const s = { verify: { inFlight: { pid: 3 }, pausedUntil: 1 } };
    const held = getVerify(s);
    assert.equal(held, s.verify, "same object: a held reference stays live");
    assert.equal(held.inFlight, null);
    assert.equal(held.pausedUntil, null);
  });

  describe("lane pause", () => {
    it("pauseVerify canonicalises <until> and never touches the factory pause", () => {
      const s = emptyFactoryState();
      pauseVerify(s, { until: "2026-10-20T22:30:00+02:00", reason: "bypass-missing" });
      assert.equal(s.verify.pausedUntil, "2026-10-20T20:30:00.000Z");
      assert.equal(s.verify.pausedReason, "bypass-missing");
      assert.equal(s.paused, false);
    });

    it("rejects a missing or unparseable <until>", () => {
      assert.throws(() => pauseVerify(emptyFactoryState(), {}), /valid <until>/);
      assert.throws(() => pauseVerify(emptyFactoryState(), { until: "later" }), /valid <until>/);
    });

    it("is paused until the deadline, then clearExpiredVerifyPause clears it", () => {
      const s = emptyFactoryState();
      pauseVerify(s, { until: minutesAfter(T0, 10) });
      assert.equal(isVerifyPaused(s, T0), true);
      assert.equal(clearExpiredVerifyPause(s, T0), false);
      assert.equal(isVerifyPaused(s, minutesAfter(T0, 10)), false);
      assert.equal(clearExpiredVerifyPause(s, minutesAfter(T0, 10)), true);
      assert.equal(s.verify.pausedUntil, null);
      assert.equal(clearExpiredVerifyPause(s, T0), false, "nothing left to clear");
    });

    it("an unparseable pausedUntil is cleared rather than stalling the lane forever", () => {
      const s = { verify: { inFlight: null, pausedUntil: "someday", pausedReason: "x" } };
      assert.equal(isVerifyPaused(s, T0), false);
      assert.equal(clearExpiredVerifyPause(s, T0), true);
      assert.equal(s.verify.pausedReason, null);
    });

    it("resumeVerify clears the lane pause", () => {
      const s = emptyFactoryState();
      pauseVerify(s, { until: minutesAfter(T0, 10), reason: "x" });
      resumeVerify(s);
      assert.deepEqual(s.verify, emptyVerify());
    });
  });

  describe("shaKeyedCount", () => {
    it("reads the count for its own SHA only", () => {
      assert.equal(shaKeyedCount(`${SHA_A}:3`, SHA_A), 3);
      assert.equal(shaKeyedCount(`${SHA_A}:3`, SHA_B), 0);
    });

    it("reads empty, malformed or missing values as 0", () => {
      for (const v of [
        null,
        undefined,
        "",
        SHA_A,
        `${SHA_A}:`,
        `${SHA_A}:x`,
        `${SHA_A}:-1`,
        `${SHA_A}:1:2`,
        ":2",
      ]) {
        assert.equal(shaKeyedCount(v, SHA_A), 0, String(v));
      }
      assert.equal(shaKeyedCount(`${SHA_A}:1`, ""), 0);
    });

    it("takes the SHA up to the first colon, as factory-agent.sh does", () => {
      assert.equal(shaKeyedCount(`${SHA_A}:1:2`, `${SHA_A}:1`), 0);
      assert.equal(shaKeyedCount(`${SHA_A}:07`, SHA_A), 7);
    });
  });

  describe("reserveVerifyRun", () => {
    it("ok: an unattached in-flight run, and the card's attempt for that SHA", () => {
      const s = emptyFactoryState();
      assert.deepEqual(reserve(s), { ok: true, runId: "verify-1", attempt: 1 });
      assert.deepEqual(s.verify.inFlight, {
        runId: "verify-1",
        issue: "42",
        pr: "700",
        sha: SHA_A,
        pid: null,
        startedAt: T0,
        deadlineAt: null,
        runDir: null,
        worktree: null,
      });
      assert.equal(s.issues["42"].verifyShellAttempts, `${SHA_A}:1`);
    });

    it("busy: one run in flight blocks every card, not just its own", () => {
      const s = emptyFactoryState();
      reserve(s);
      const r = reserve(s, { issue: "43", sha: SHA_B, runId: "verify-2" });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "busy");
      assert.equal(r.inFlight.runId, "verify-1");
      assert.equal(getIssue(s, 43).verifyShellAttempts, null, "a refusal spends nothing");
    });

    it("attempts: refuses once <maxAttempts> runs started for the SHA; a new SHA starts over", () => {
      const s = emptyFactoryState();
      setIssueField(s, 42, "verifyShellAttempts", `${SHA_A}:2`);
      assert.deepEqual(reserve(s), { ok: false, reason: "attempts", attempts: 2 });
      assert.equal(s.verify.inFlight, null);
      assert.deepEqual(reserve(s, { sha: SHA_B }), { ok: true, runId: "verify-1", attempt: 1 });
      assert.equal(s.issues["42"].verifyShellAttempts, `${SHA_B}:1`);
    });

    it("paused: an active lane pause refuses before busy or attempts are considered", () => {
      const s = emptyFactoryState();
      reserve(s);
      pauseVerify(s, { until: minutesAfter(T0, 5), reason: "memory" });
      const r = reserve(s, { runId: "verify-2" });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "paused");
      assert.equal(r.pausedReason, "memory");
    });

    it("an expired pause is cleared and the run is reserved", () => {
      const s = emptyFactoryState();
      pauseVerify(s, { until: minutesAfter(T0, -1) });
      assert.equal(reserve(s).ok, true);
      assert.equal(s.verify.pausedUntil, null);
    });

    it("stores an empty pr as null", () => {
      const s = emptyFactoryState();
      reserve(s, { pr: "" });
      assert.equal(s.verify.inFlight.pr, null);
    });

    it("rejects missing identity, an invalid maxAttempts or an invalid now", () => {
      assert.throws(() => reserve(emptyFactoryState(), { issue: "" }), /requires <issue>/);
      assert.throws(() => reserve(emptyFactoryState(), { sha: null }), /requires <sha>/);
      assert.throws(() => reserve(emptyFactoryState(), { runId: "" }), /requires <runId>/);
      assert.throws(() => reserve(emptyFactoryState(), { maxAttempts: 0 }), /maxAttempts/);
      assert.throws(() => reserve(emptyFactoryState(), { maxAttempts: "x" }), /maxAttempts/);
      assert.throws(() => reserve(emptyFactoryState(), { now: "nope" }), /invalid <now>/);
    });
  });

  describe("attachVerifyRun", () => {
    it("fills in the spawn details for the matching run", () => {
      const s = emptyFactoryState();
      reserve(s);
      const ok = attachVerifyRun(s, "verify-1", {
        pid: 99,
        deadlineAt: minutesAfter(T0, 30),
        runDir: "/tmp/r",
        worktree: "/tmp/w",
      });
      assert.equal(ok, true);
      assert.equal(s.verify.inFlight.pid, 99);
      assert.equal(s.verify.inFlight.deadlineAt, minutesAfter(T0, 30));
      assert.equal(s.verify.inFlight.runDir, "/tmp/r");
      assert.equal(s.verify.inFlight.worktree, "/tmp/w");
      assert.equal(s.verify.inFlight.startedAt, T0, "reservation fields untouched");
    });

    it("refuses a runId mismatch, or nothing in flight, without writing", () => {
      const s = emptyFactoryState();
      assert.equal(attachVerifyRun(s, "verify-1", { pid: 5 }), false);
      reserve(s);
      const before = structuredClone(s.verify.inFlight);
      assert.equal(attachVerifyRun(s, "verify-OTHER", { pid: 5 }), false);
      assert.deepEqual(s.verify.inFlight, before);
    });

    it("stores a non-integer pid as null", () => {
      const s = emptyFactoryState();
      reserve(s);
      attachVerifyRun(s, "verify-1", { pid: "123" });
      assert.equal(s.verify.inFlight.pid, null);
    });
  });

  describe("finishVerifyRun", () => {
    const reserved = () => {
      const s = emptyFactoryState();
      reserve(s);
      return s;
    };

    it("a runId mismatch is a no-op", () => {
      const s = reserved();
      const r = finishVerifyRun(s, "verify-OTHER");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "run-id-mismatch");
      assert.equal(s.verify.inFlight.runId, "verify-1");
      assert.equal(s.issues["42"].verifyShellAttempts, `${SHA_A}:1`);
    });

    it("refund none (default): frees the lane, the attempt stays spent", () => {
      const s = reserved();
      assert.deepEqual(finishVerifyRun(s, "verify-1"), {
        ok: true,
        runId: "verify-1",
        refund: "none",
        issue: "42",
        sha: SHA_A,
      });
      assert.equal(s.verify.inFlight, null);
      assert.equal(s.issues["42"].verifyShellAttempts, `${SHA_A}:1`);
    });

    it("refund attempt: frees the lane and gives the attempt back", () => {
      const s = reserved();
      assert.equal(finishVerifyRun(s, "verify-1", { refund: "attempt" }).ok, true);
      assert.equal(s.verify.inFlight, null);
      assert.equal(s.issues["42"].verifyShellAttempts, `${SHA_A}:0`);
      assert.equal(reserve(s).attempt, 1, "the next run is the first again");
    });

    it("never refunds another SHA's counter, nor goes below zero", () => {
      const s = reserved();
      setIssueField(s, 42, "verifyShellAttempts", `${SHA_B}:1`); // the card moved on
      finishVerifyRun(s, "verify-1", { refund: "attempt" });
      assert.equal(s.issues["42"].verifyShellAttempts, `${SHA_B}:1`);

      const t = reserved();
      setIssueField(t, 42, "verifyShellAttempts", ""); // reset by hand meanwhile
      finishVerifyRun(t, "verify-1", { refund: "attempt" });
      assert.equal(t.issues["42"].verifyShellAttempts, null);
    });

    it("rejects an unknown refund kind", () => {
      assert.throws(() => finishVerifyRun(reserved(), "verify-1", { refund: "spawn" }), /refund/);
    });
  });

  describe("per-issue keys", () => {
    it("are the eleven documented fields", () => {
      assert.deepEqual(
        [...VERIFY_ISSUE_FIELDS],
        [
          "verifySha",
          "verifyStartedAt",
          "verifyShell",
          "verifyShellRunDir",
          "verifyShellAttempts",
          "verifyBrowser",
          "verifyBrowserRunDir",
          "verifyReportSha",
          "verifyBounces",
          "verifyCrNote",
          "verifyReportPosts",
        ],
      );
      assert.throws(() => VERIFY_ISSUE_FIELDS.push("x"), TypeError);
    });

    it("default to null on a fresh issue record", () => {
      const issue = getIssue(emptyFactoryState(), 7);
      for (const f of VERIFY_ISSUE_FIELDS) assert.equal(issue[f], null, f);
    });

    // bash writes these with `|| true`: a field missing from the allowlist
    // fails silently, and the stage would re-initialise, re-post or loop.
    it("are all accepted by setIssueField (and cleared by the empty sentinel)", () => {
      const s = emptyFactoryState();
      for (const f of VERIFY_ISSUE_FIELDS) {
        assert.equal(setIssueField(s, 7, f, `${SHA_A}:1`), `${SHA_A}:1`, f);
        assert.equal(setIssueField(s, 7, f, ""), null, f);
      }
    });

    it("verifyIssueRecords lists only issues that carry a verify key, with all of them", () => {
      const s = emptyFactoryState();
      setIssueField(s, 7, "verifySha", SHA_A);
      setIssueField(s, 8, "lastPlanAt", T0);
      s.issues["9"] = { verifyBounces: "" };
      s.issues["10"] = null;
      const out = verifyIssueRecords(s);
      assert.deepEqual(Object.keys(out), ["7"]);
      assert.equal(out["7"].verifySha, SHA_A);
      assert.deepEqual(Object.keys(out["7"]), [...VERIFY_ISSUE_FIELDS]);
      assert.equal(out["7"].verifyBounces, null);
      assert.deepEqual(verifyIssueRecords({}), {});
    });
  });

  describe("resetIssueVerify", () => {
    // The browser runner skips a head that browserRunSha already names, so a
    // reset that kept it would leave the new round without a browser verdict.
    it("clears every verify key and the shared browser-run keys, nothing else", () => {
      const s = emptyFactoryState();
      for (const f of VERIFY_ISSUE_FIELDS) setIssueField(s, 7, f, `${SHA_A}:1`);
      setIssueField(s, 7, "browserRunSha", SHA_A);
      setIssueField(s, 7, "browserRunAttempts", `${SHA_A}:1`);
      setIssueField(s, 7, "intestCommentSha", SHA_A);
      bumpIssueAttempts(s, 7);
      const r = resetIssueVerify(s, 7);
      assert.deepEqual(r, {
        ok: true,
        cleared: [...VERIFY_ISSUE_FIELDS, "browserRunSha", "browserRunAttempts"],
      });
      for (const f of VERIFY_ISSUE_FIELDS) assert.equal(s.issues["7"][f], null, f);
      assert.equal(s.issues["7"].browserRunSha, null);
      assert.equal(s.issues["7"].browserRunAttempts, null);
      assert.equal(s.issues["7"].intestCommentSha, SHA_A);
      assert.equal(s.issues["7"].attempts, 1);
    });

    it("reports only the keys that held a value", () => {
      const s = emptyFactoryState();
      setIssueField(s, 7, "verifySha", SHA_A);
      assert.deepEqual(resetIssueVerify(s, 7).cleared, ["verifySha"]);
    });

    it("refuses while the lane runs for that card, but not for another card's run", () => {
      const s = emptyFactoryState();
      reserve(s); // issue 42
      setIssueField(s, 43, "verifySha", SHA_B);
      const refused = resetIssueVerify(s, 42);
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, "run-in-flight");
      assert.equal(refused.inFlight.runId, "verify-1");
      assert.equal(s.issues["42"].verifyShellAttempts, `${SHA_A}:1`, "nothing cleared");
      assert.deepEqual(resetIssueVerify(s, 43), { ok: true, cleared: ["verifySha"] });
    });

    it("does not create a record for an unknown issue", () => {
      const s = emptyFactoryState();
      assert.deepEqual(resetIssueVerify(s, 999), { ok: true, cleared: [] });
      assert.equal(s.issues["999"], undefined);
    });
  });
});

describe("DEFAULT_FACTORY_STATE_PATH", () => {
  it("points at <repo>/logs/factory-state.json", () => {
    assert.match(DEFAULT_FACTORY_STATE_PATH, /[\/\\]logs[\/\\]factory-state\.json$/);
  });
});
