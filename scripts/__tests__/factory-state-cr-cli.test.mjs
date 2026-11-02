// CodeRabbit CLI lane ledger in factory-state.mjs (ADR-0036).
//
// The ledger is budget bookkeeping for a vendor allowance of 3 CLI reviews per
// rolling hour, one at a time. The tests pin the three properties the lane
// relies on: the ledger survives unrelated writes, the budget window is exact,
// and refunds give back precisely what a failed run did not consume.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  emptyFactoryState,
  emptyCrCli,
  loadFactoryState,
  saveFactoryState,
  getIssue,
  setIssueField,
  getCrCli,
  pruneCrCliRuns,
  crCliUsage,
  isCrCliPaused,
  clearExpiredCrCliPause,
  pauseCrCli,
  resumeCrCli,
  reserveCrCliRun,
  reserveManualCrCliRun,
  attachCrCliRun,
  finishCrCliRun,
} from "../lib/factory-state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "state-cli.mjs");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const T0 = "2026-09-12T20:00:00.000Z";

function minutesAfter(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60 * 1000).toISOString();
}

function reserve(state, overrides = {}) {
  return reserveCrCliRun(state, {
    issue: "42",
    sha: SHA_A,
    pr: "600",
    runId: "run-1",
    maxPerHour: 3,
    now: T0,
    ...overrides,
  });
}

let workdir;
let stateFile;

before(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "factory-state-cr-cli-test-"));
  stateFile = path.join(workdir, "factory-state.json");
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(stateFile)) rmSync(stateFile);
});

describe("crCli ledger: load / save round-trip", () => {
  it("emptyFactoryState carries an empty ledger", () => {
    assert.deepEqual(emptyFactoryState().crCli, emptyCrCli());
    assert.deepEqual(emptyCrCli(), {
      runs: [],
      inFlight: null,
      pausedUntil: null,
      pausedReason: null,
    });
  });

  it("a legacy file without crCli loads the empty ledger", async () => {
    writeFileSync(stateFile, JSON.stringify({ paused: false, slots: {}, issues: {} }));
    const state = await loadFactoryState(stateFile);
    assert.deepEqual(state.crCli, emptyCrCli());
  });

  it("garbage crCli is normalised instead of crashing or leaking through", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        crCli: {
          runs: [
            { runId: "ok", issue: 42, sha: SHA_A, startedAt: T0 },
            { issue: "no-run-id", startedAt: T0 },
            "not-an-object",
            { runId: "no-start" },
          ],
          inFlight: { pid: 123 }, // no runId → can never be finished → dropped
          pausedUntil: 12345,
          pausedReason: ["x"],
          extra: "dropped",
        },
      }),
    );
    const state = await loadFactoryState(stateFile);
    assert.deepEqual(state.crCli, {
      runs: [{ runId: "ok", issue: "42", sha: SHA_A, startedAt: T0 }],
      inFlight: null,
      pausedUntil: null,
      pausedReason: null,
    });
  });

  it("a non-object crCli (array / string) loads as the empty ledger", async () => {
    writeFileSync(stateFile, JSON.stringify({ crCli: ["nope"] }));
    assert.deepEqual((await loadFactoryState(stateFile)).crCli, emptyCrCli());
    writeFileSync(stateFile, JSON.stringify({ crCli: "nope" }));
    assert.deepEqual((await loadFactoryState(stateFile)).crCli, emptyCrCli());
  });

  it("an in-flight run survives save → load with its pid kept as an integer", async () => {
    const state = emptyFactoryState();
    reserve(state);
    attachCrCliRun(state, "run-1", {
      pid: 4242,
      baseSha: SHA_B,
      mode: "incremental",
      deadlineAt: minutesAfter(T0, 45),
      runDir: "/tmp/run-1",
      worktree: "/tmp/wt",
    });
    await saveFactoryState(state, stateFile);
    const loaded = await loadFactoryState(stateFile);
    assert.equal(loaded.crCli.inFlight.pid, 4242);
    assert.equal(loaded.crCli.inFlight.mode, "incremental");
    assert.equal(loaded.crCli.runs.length, 1);
  });

  // Regression: mergeWithDefaults used to return only paused*/slots/issues, so
  // ANY unrelated write erased a new top-level key. For the lane that would
  // mean an in-flight review forgotten mid-run: orphaned worktree, lost budget.
  it("an unrelated state-cli write (factory:bump-attempts) keeps crCli intact", () => {
    const crCli = {
      runs: [{ runId: "run-1", issue: "42", sha: SHA_A, startedAt: T0 }],
      inFlight: {
        runId: "run-1",
        issue: "42",
        pr: "600",
        sha: SHA_A,
        baseSha: SHA_B,
        mode: "full",
        pid: 777,
        startedAt: T0,
        deadlineAt: minutesAfter(T0, 45),
        runDir: "/tmp/run-1",
        worktree: "/tmp/wt",
      },
      pausedUntil: minutesAfter(T0, 30),
      pausedReason: "rate_limited",
    };
    writeFileSync(stateFile, JSON.stringify({ issues: {}, crCli }));
    const r = spawnSync("node", [CLI, "factory:bump-attempts", "42", "--state-file", stateFile], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(after.issues["42"].attempts, 1);
    assert.deepEqual(after.crCli, crCli);
  });

  it("an unknown top-level key (a newer factory's data) survives a load → save cycle", () => {
    // factory-agent-loop.sh self-updates with `git reset --hard`, so an older
    // factory-state.mjs can read a file written by a newer one.
    const future = { schema: 2, entries: [{ id: "x", at: T0 }] };
    writeFileSync(stateFile, JSON.stringify({ issues: {}, futureLedger: future, paused: false }));
    const r = spawnSync("node", [CLI, "factory:bump-attempts", "42", "--state-file", stateFile], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(after.issues["42"].attempts, 1);
    assert.deepEqual(after.futureLedger, future);
    // Known keys are still normalised, never taken verbatim from the file.
    assert.deepEqual(after.crCli, emptyCrCli());
  });

  it("known top-level keys override garbage values from the file", async () => {
    writeFileSync(stateFile, JSON.stringify({ paused: "yes", slots: "nope", crCli: 7 }));
    const state = await loadFactoryState(stateFile);
    assert.equal(state.paused, true);
    assert.equal(state.slots["0"].pid, null);
    assert.deepEqual(state.crCli, emptyCrCli());
  });
});

describe("getCrCli", () => {
  it("creates the ledger on a state that has none", () => {
    const state = {};
    assert.deepEqual(getCrCli(state), emptyCrCli());
    assert.ok(state.crCli);
  });

  it("normalises in place, so a held reference stays live across helper calls", () => {
    const state = emptyFactoryState();
    const held = getCrCli(state);
    pauseCrCli(state, { until: minutesAfter(T0, 5), reason: "x" });
    clearExpiredCrCliPause(state, minutesAfter(T0, 10));
    assert.equal(getCrCli(state), held);
    assert.equal(held.pausedUntil, null);
  });
});

describe("crCliUsage / pruneCrCliRuns", () => {
  it("counts runs started less than an hour ago and reports when the oldest frees", () => {
    const state = emptyFactoryState();
    getCrCli(state).runs = [
      { runId: "r1", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -50) },
      { runId: "r2", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -20) },
      { runId: "old", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -61) },
    ];
    assert.deepEqual(crCliUsage(state, { now: T0 }), {
      usedLastHour: 2,
      nextSlotAt: minutesAfter(T0, 10),
    });
  });

  it("an empty window has no next slot", () => {
    assert.deepEqual(crCliUsage(emptyFactoryState(), { now: T0 }), {
      usedLastHour: 0,
      nextSlotAt: null,
    });
  });

  it("a run exactly one window old no longer counts", () => {
    const state = emptyFactoryState();
    getCrCli(state).runs = [
      { runId: "r", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -60) },
    ];
    assert.equal(crCliUsage(state, { now: T0 }).usedLastHour, 0);
  });

  it("compares numerically, so second- and millisecond-precision stamps mix safely", () => {
    const state = emptyFactoryState();
    getCrCli(state).runs = [
      { runId: "r", issue: "1", sha: SHA_A, startedAt: "2026-09-12T19:30:00Z" },
    ];
    assert.equal(crCliUsage(state, { now: "2026-09-12T20:29:59.999Z" }).usedLastHour, 1);
    assert.equal(crCliUsage(state, { now: "2026-09-12T20:30:00.000Z" }).usedLastHour, 0);
  });

  it("prunes entries older than 24 h (and unparseable ones), keeps the rest", () => {
    const state = emptyFactoryState();
    getCrCli(state).runs = [
      { runId: "keep", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -23 * 60) },
      { runId: "drop", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -25 * 60) },
      { runId: "junk", issue: "1", sha: SHA_A, startedAt: "not-a-date" },
    ];
    const runs = pruneCrCliRuns(state, T0);
    assert.deepEqual(
      runs.map((r) => r.runId),
      ["keep"],
    );
  });
});

describe("lane pause", () => {
  it("pauseCrCli canonicalises <until> and never touches the factory pause", () => {
    const state = emptyFactoryState();
    pauseCrCli(state, { until: "2026-09-12T22:50:00+02:00", reason: "rate_limited" });
    assert.equal(state.crCli.pausedUntil, "2026-09-12T20:50:00.000Z");
    assert.equal(state.crCli.pausedReason, "rate_limited");
    assert.equal(state.paused, false);
    assert.equal(state.pausedUntil, null);
  });

  it("rejects a missing or unparseable <until>", () => {
    assert.throws(() => pauseCrCli(emptyFactoryState(), { until: "" }), /valid <until>/);
    assert.throws(() => pauseCrCli(emptyFactoryState(), { until: "soon" }), /valid <until>/);
  });

  it("isCrCliPaused is true until the deadline, then clearExpiredCrCliPause clears it", () => {
    const state = emptyFactoryState();
    pauseCrCli(state, { until: minutesAfter(T0, 30), reason: "auth" });
    assert.equal(isCrCliPaused(state, minutesAfter(T0, 29)), true);
    assert.equal(clearExpiredCrCliPause(state, minutesAfter(T0, 29)), false);
    assert.equal(isCrCliPaused(state, minutesAfter(T0, 30)), false);
    assert.equal(clearExpiredCrCliPause(state, minutesAfter(T0, 30)), true);
    assert.equal(state.crCli.pausedUntil, null);
    assert.equal(state.crCli.pausedReason, null);
  });

  it("clearExpiredCrCliPause is false when there is no pause", () => {
    assert.equal(clearExpiredCrCliPause(emptyFactoryState(), T0), false);
  });

  it("resumeCrCli clears the lane pause", () => {
    const state = emptyFactoryState();
    pauseCrCli(state, { until: minutesAfter(T0, 30) });
    resumeCrCli(state);
    assert.equal(isCrCliPaused(state, T0), false);
  });
});

describe("reserveCrCliRun", () => {
  it("ok: records the ledger entry, an in-flight run with pid null, and bumps the card", () => {
    const state = emptyFactoryState();
    assert.deepEqual(reserve(state), { ok: true, runId: "run-1" });
    assert.deepEqual(state.crCli.runs, [
      { runId: "run-1", issue: "42", sha: SHA_A, startedAt: T0 },
    ]);
    assert.deepEqual(state.crCli.inFlight, {
      runId: "run-1",
      issue: "42",
      pr: "600",
      sha: SHA_A,
      baseSha: null,
      mode: null,
      pid: null,
      startedAt: T0,
      deadlineAt: null,
      runDir: null,
      worktree: null,
    });
    assert.equal(getIssue(state, 42).crCliRuns, "1");
  });

  it("busy: a run already in flight blocks a second one (the vendor fails concurrent runs)", () => {
    const state = emptyFactoryState();
    reserve(state);
    const r = reserve(state, { issue: "43", sha: SHA_B, runId: "run-2" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "busy");
    assert.equal(r.inFlight.runId, "run-1");
    assert.equal(state.crCli.runs.length, 1);
    assert.equal(getIssue(state, 43).crCliRuns, null);
  });

  it("budget: three runs in the last 60 min refuse a fourth, reporting when a slot frees", () => {
    const state = emptyFactoryState();
    getCrCli(state).runs = [
      { runId: "r1", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -59) },
      { runId: "r2", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -30) },
      { runId: "r3", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -5) },
    ];
    assert.deepEqual(reserve(state), {
      ok: false,
      reason: "budget",
      nextSlotAt: minutesAfter(T0, 1),
    });
    assert.equal(state.crCli.inFlight, null);
    assert.equal(getIssue(state, 42).crCliRuns, null);
  });

  it("budget: the same three runs with the oldest at 61 min leave room → ok", () => {
    const state = emptyFactoryState();
    getCrCli(state).runs = [
      { runId: "r1", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -61) },
      { runId: "r2", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -30) },
      { runId: "r3", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -5) },
    ];
    assert.equal(reserve(state).ok, true);
    assert.equal(state.crCli.runs.length, 4);
  });

  it("honours a lower maxPerHour", () => {
    const state = emptyFactoryState();
    getCrCli(state).runs = [
      { runId: "r1", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -10) },
    ];
    assert.equal(reserve(state, { maxPerHour: 1 }).reason, "budget");
  });

  it("paused: an active lane pause refuses before busy/budget are considered", () => {
    const state = emptyFactoryState();
    pauseCrCli(state, { until: minutesAfter(T0, 30), reason: "rate_limited" });
    assert.deepEqual(reserve(state), {
      ok: false,
      reason: "paused",
      pausedUntil: minutesAfter(T0, 30),
      pausedReason: "rate_limited",
    });
  });

  it("an expired pause is cleared and the run is reserved", () => {
    const state = emptyFactoryState();
    pauseCrCli(state, { until: minutesAfter(T0, -1), reason: "rate_limited" });
    assert.equal(reserve(state).ok, true);
    assert.equal(state.crCli.pausedUntil, null);
    assert.equal(state.crCli.pausedReason, null);
  });

  it("prunes ledger entries older than 24 h on reserve", () => {
    const state = emptyFactoryState();
    getCrCli(state).runs = [
      { runId: "ancient", issue: "1", sha: SHA_A, startedAt: minutesAfter(T0, -48 * 60) },
    ];
    reserve(state);
    assert.deepEqual(
      state.crCli.runs.map((r) => r.runId),
      ["run-1"],
    );
  });

  it("bumps crCliRuns from an existing string count", () => {
    const state = emptyFactoryState();
    setIssueField(state, 42, "crCliRuns", "1");
    reserve(state);
    assert.equal(getIssue(state, 42).crCliRuns, "2");
  });

  it("rejects missing identity or an invalid maxPerHour", () => {
    assert.throws(() => reserve(emptyFactoryState(), { issue: "" }), /<issue>/);
    assert.throws(() => reserve(emptyFactoryState(), { sha: "" }), /<sha>/);
    assert.throws(() => reserve(emptyFactoryState(), { runId: "" }), /<runId>/);
    assert.throws(() => reserve(emptyFactoryState(), { maxPerHour: 0 }), /maxPerHour/);
    assert.throws(() => reserve(emptyFactoryState(), { maxPerHour: "x" }), /maxPerHour/);
    assert.throws(() => reserve(emptyFactoryState(), { now: "nope" }), /invalid <now>/);
  });
});

describe("attachCrCliRun", () => {
  it("fills in the spawn details for the matching run", () => {
    const state = emptyFactoryState();
    reserve(state);
    const ok = attachCrCliRun(state, "run-1", {
      pid: 99,
      baseSha: SHA_B,
      mode: "full",
      deadlineAt: minutesAfter(T0, 45),
      runDir: "/tmp/r",
      worktree: "/tmp/w",
    });
    assert.equal(ok, true);
    assert.equal(state.crCli.inFlight.pid, 99);
    assert.equal(state.crCli.inFlight.baseSha, SHA_B);
    assert.equal(state.crCli.inFlight.worktree, "/tmp/w");
    assert.equal(state.crCli.inFlight.runId, "run-1");
    assert.equal(state.crCli.inFlight.startedAt, T0);
  });

  it("refuses a runId mismatch without touching the in-flight record", () => {
    const state = emptyFactoryState();
    reserve(state);
    const before = structuredClone(state.crCli.inFlight);
    assert.equal(attachCrCliRun(state, "run-OTHER", { pid: 5 }), false);
    assert.deepEqual(state.crCli.inFlight, before);
  });

  it("refuses when nothing is in flight", () => {
    assert.equal(attachCrCliRun(emptyFactoryState(), "run-1", { pid: 5 }), false);
  });

  it("stores a non-integer pid as null", () => {
    const state = emptyFactoryState();
    reserve(state);
    attachCrCliRun(state, "run-1", { pid: "123" });
    assert.equal(state.crCli.inFlight.pid, null);
  });
});

describe("finishCrCliRun", () => {
  function reserved() {
    const state = emptyFactoryState();
    reserve(state);
    return state;
  }

  it("a runId mismatch is a no-op", () => {
    const state = reserved();
    const r = finishCrCliRun(state, "run-OTHER", { now: T0 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "run-id-mismatch");
    assert.equal(state.crCli.inFlight.runId, "run-1");
    assert.equal(getIssue(state, 42).crCliRuns, "1");
  });

  it("refund none: clears in-flight, keeps the budget entry and the card run", () => {
    const state = reserved();
    assert.deepEqual(finishCrCliRun(state, "run-1", { now: T0 }), {
      ok: true,
      runId: "run-1",
      refund: "none",
      issue: "42",
    });
    assert.equal(state.crCli.inFlight, null);
    assert.equal(state.crCli.runs.length, 1);
    assert.equal(getIssue(state, 42).crCliRuns, "1");
  });

  it("refund spawn: the run never started — both the hourly slot and the card run come back", () => {
    const state = reserved();
    assert.equal(finishCrCliRun(state, "run-1", { refund: "spawn", now: T0 }).ok, true);
    assert.equal(state.crCli.inFlight, null);
    assert.deepEqual(state.crCli.runs, []);
    assert.equal(getIssue(state, 42).crCliRuns, "0");
  });

  it("refund card: vendor refusal keeps the hourly slot but returns the card run", () => {
    const state = reserved();
    assert.equal(finishCrCliRun(state, "run-1", { refund: "card", now: T0 }).ok, true);
    assert.equal(state.crCli.inFlight, null);
    assert.equal(state.crCli.runs.length, 1);
    assert.equal(getIssue(state, 42).crCliRuns, "0");
  });

  it("never decrements the card counter below zero", () => {
    const state = reserved();
    setIssueField(state, 42, "crCliRuns", "");
    finishCrCliRun(state, "run-1", { refund: "spawn", now: T0 });
    assert.equal(getIssue(state, 42).crCliRuns, "0");
  });

  it("rejects an unknown refund kind", () => {
    assert.throws(() => finishCrCliRun(reserved(), "run-1", { refund: "all" }), /invalid refund/);
  });

  it("prunes ledger entries older than 24 h on finish", () => {
    const state = reserved();
    state.crCli.runs.unshift({
      runId: "ancient",
      issue: "1",
      sha: SHA_A,
      startedAt: minutesAfter(T0, -30 * 60),
    });
    finishCrCliRun(state, "run-1", { now: T0 });
    assert.deepEqual(
      state.crCli.runs.map((r) => r.runId),
      ["run-1"],
    );
  });
});

describe("issue fields for the lane", () => {
  const FIELDS = [
    "crConvergedSha",
    "crConvergedAt",
    "crCoverageSha",
    "crCoverage",
    "crLastCoveredSha",
    "crCliRuns",
    "crCliFreePassSha",
  ];

  it("default to null on a fresh issue record", () => {
    const issue = getIssue(emptyFactoryState(), 7);
    for (const f of FIELDS) assert.equal(issue[f], null, f);
  });

  // bash writes these with `|| true`, so a field missing from the allow-list
  // would fail silently and the lane would re-decide the same SHA every tick.
  it("are all accepted by setIssueField (and cleared by the empty sentinel)", () => {
    const state = emptyFactoryState();
    for (const f of FIELDS) {
      assert.equal(setIssueField(state, 7, f, "v"), "v", f);
      assert.equal(setIssueField(state, 7, f, ""), null, f);
    }
  });
});

describe("reserveManualCrCliRun (a review started by hand, no card)", () => {
  const manual = (extra = {}) => ({
    pr: "637",
    sha: SHA_A,
    runId: "m1",
    pid: 99,
    maxPerHour: 3,
    now: T0,
    deadlineAt: "2026-09-12T20:30:00.000Z",
    ...extra,
  });

  it("holds the lane with a complete, manual record and spends an hourly slot", () => {
    const state = emptyFactoryState();
    assert.deepEqual(reserveManualCrCliRun(state, manual()), { ok: true, runId: "m1" });
    const { inFlight, runs } = getCrCli(state);
    assert.equal(inFlight.manual, true);
    assert.equal(inFlight.pid, 99);
    assert.equal(inFlight.pr, "637");
    assert.equal(inFlight.issue, null);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].issue, "pr-637");
    assert.deepEqual(state.issues, {});
  });

  it("refuses exactly like the factory's reservation: paused, busy, budget", () => {
    const paused = emptyFactoryState();
    pauseCrCli(paused, { until: "2026-09-12T21:00:00.000Z", reason: "auth" });
    assert.equal(reserveManualCrCliRun(paused, manual()).reason, "paused");

    const busy = emptyFactoryState();
    reserveCrCliRun(busy, { issue: 1, sha: SHA_B, runId: "f1", maxPerHour: 3, now: T0 });
    assert.equal(reserveManualCrCliRun(busy, manual()).reason, "busy");

    const spent = emptyFactoryState();
    for (const id of ["a", "b", "c"]) {
      reserveCrCliRun(spent, { issue: 1, sha: SHA_B, runId: id, maxPerHour: 3, now: T0 });
      finishCrCliRun(spent, id, { now: T0 });
    }
    assert.equal(reserveManualCrCliRun(spent, manual()).reason, "budget");
  });

  it("blocks the factory's reservation while held, and finishing it touches no card", () => {
    const state = emptyFactoryState();
    reserveManualCrCliRun(state, manual());
    assert.equal(
      reserveCrCliRun(state, { issue: 5, sha: SHA_B, runId: "f", maxPerHour: 3, now: T0 }).reason,
      "busy",
    );
    assert.equal(finishCrCliRun(state, "m1", { refund: "card", now: T0 }).ok, true);
    assert.equal(getCrCli(state).inFlight, null);
    assert.deepEqual(state.issues, {});
  });

  it("survives a save/load round trip with its manual flag; factory records stay unflagged", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cr-cli-manual-"));
    try {
      const file = path.join(dir, "state.json");
      const state = emptyFactoryState();
      reserveManualCrCliRun(state, manual());
      await saveFactoryState(state, file);
      assert.equal((await loadFactoryState(file)).crCli.inFlight.manual, true);

      const factory = emptyFactoryState();
      reserveCrCliRun(factory, { issue: 1, sha: SHA_B, runId: "f", maxPerHour: 3, now: T0 });
      await saveFactoryState(factory, file);
      assert.equal("manual" in (await loadFactoryState(file)).crCli.inFlight, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a missing pr, sha, runId or pid", () => {
    for (const bad of [{ pr: "" }, { sha: "" }, { runId: "" }, { pid: 0 }]) {
      assert.throws(() => reserveManualCrCliRun(emptyFactoryState(), manual(bad)));
    }
  });
});
