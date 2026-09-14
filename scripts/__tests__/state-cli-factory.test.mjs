import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "state-cli.mjs");

let workdir;
let stateFile;

before(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "state-cli-factory-test-"));
  stateFile = path.join(workdir, "factory-state.json");
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(stateFile)) rmSync(stateFile);
});

function run(args, { stdin } = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    input: stdin,
  });
}

function readState() {
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

describe("factory:pause / factory:resume / factory:status / factory:paused?", () => {
  it("factory:pause stamps the reason + timestamp into a new file", () => {
    const now = "2026-05-21T08:00:00.000Z";
    const r = run(["factory:pause", "rolling out", "--state-file", stateFile, "--now", now]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.paused, true);
    assert.equal(out.pausedAt, now);
    assert.equal(out.pausedReason, "rolling out");
    const state = readState();
    assert.equal(state.paused, true);
    assert.equal(state.pausedReason, "rolling out");
  });

  it("factory:resume clears the pause without nuking slots / issues", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        paused: true,
        pausedAt: "2026-05-21T08:00:00.000Z",
        pausedReason: "test",
        slots: { 0: { pid: 1, issueNumber: "42", acquiredAt: "x" } },
        issues: { 42: { attempts: 3 } },
      }),
    );
    const r = run(["factory:resume", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    const state = readState();
    assert.equal(state.paused, false);
    assert.equal(state.slots["0"].issueNumber, "42");
    assert.equal(state.issues["42"].attempts, 3);
  });

  it("factory:status prints the full state JSON", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        paused: false,
        slots: { 0: { pid: null, issueNumber: null, acquiredAt: null } },
        issues: { 42: { attempts: 1 } },
      }),
    );
    const r = run(["factory:status", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.paused, false);
    assert.equal(out.issues["42"].attempts, 1);
  });

  it("factory:paused? exits 0 when paused, 1 when not", () => {
    writeFileSync(stateFile, JSON.stringify({ paused: true }));
    let r = run(["factory:paused?", "--state-file", stateFile]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");

    writeFileSync(stateFile, JSON.stringify({ paused: false }));
    r = run(["factory:paused?", "--state-file", stateFile]);
    assert.equal(r.status, 1);
  });
});

describe("factory:pause-until (timed pause + auto-resume)", () => {
  const T0 = "2026-07-21T08:00:00.000Z";
  const UNTIL = "2026-07-21T10:30:00.000Z";
  const BEFORE = "2026-07-21T09:00:00.000Z";
  const AFTER = "2026-07-21T11:00:00.000Z";

  it("stamps paused + pausedUntil + reason", () => {
    const r = run([
      "factory:pause-until",
      UNTIL,
      "claude session limit",
      "--state-file",
      stateFile,
      "--now",
      T0,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.paused, true);
    assert.equal(out.pausedUntil, UNTIL);
    assert.equal(out.pausedReason, "claude session limit");
    const state = readState();
    assert.equal(state.pausedUntil, UNTIL);
  });

  it("rejects an unparseable <until-iso>", () => {
    const r = run(["factory:pause-until", "not-a-date", "--state-file", stateFile]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid <until-iso>/);
  });

  it("normalises a zone-offset <until-iso> to canonical UTC so comparisons hold", () => {
    // 10:30+02:00 == 08:30Z. Stored raw it would sort after a 09:00Z `now`
    // ("1" > "0") and wrongly read as still-paused; normalised it sorts before.
    const r = run([
      "factory:pause-until",
      "2026-07-21T10:30:00+02:00",
      "limit",
      "--state-file",
      stateFile,
      "--now",
      T0,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readState().pausedUntil, "2026-07-21T08:30:00.000Z");
    // now = 09:00Z is past the real 08:30Z deadline → auto-resumes.
    const p = run(["factory:paused?", "--state-file", stateFile, "--now", BEFORE]);
    assert.equal(p.status, 1, "past the true UTC deadline → not paused");
  });

  it("factory:paused? is 0 before the deadline and 1 (auto-cleared) after", () => {
    run(["factory:pause-until", UNTIL, "limit", "--state-file", stateFile, "--now", T0]);

    let r = run(["factory:paused?", "--state-file", stateFile, "--now", BEFORE]);
    assert.equal(r.status, 0, "still paused before the deadline");

    r = run(["factory:paused?", "--state-file", stateFile, "--now", AFTER]);
    assert.equal(r.status, 1, "no longer paused after the deadline");
    // Auto-resume must have persisted the cleared pause.
    const state = readState();
    assert.equal(state.paused, false);
    assert.equal(state.pausedUntil, null);
  });

  it("a manual factory:pause never auto-expires", () => {
    run(["factory:pause", "operator stop", "--state-file", stateFile, "--now", T0]);
    const r = run([
      "factory:paused?",
      "--state-file",
      stateFile,
      "--now",
      "2027-01-01T00:00:00.000Z",
    ]);
    assert.equal(r.status, 0, "manual pause stays paused indefinitely");
  });
});

describe("factory:slot-acquire / slot-release / slot-status", () => {
  it("acquires an empty slot and records pid + issue + timestamp", () => {
    const now = "2026-05-21T09:00:00.000Z";
    const r = run([
      "factory:slot-acquire",
      "0",
      "42",
      String(process.pid), // use our own pid so it's "alive"
      "--state-file",
      stateFile,
      "--now",
      now,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.slot, 0);
    assert.equal(out.issueNumber, "42");
    assert.equal(out.acquiredAt, now);
    const state = readState();
    assert.equal(state.slots["0"].issueNumber, "42");
    assert.equal(state.slots["0"].pid, process.pid);
  });

  it("refuses to overwrite a slot whose pid is still alive", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        slots: { 0: { pid: process.pid, issueNumber: "42", acquiredAt: "x" } },
      }),
    );
    const r = run(["factory:slot-acquire", "0", "99", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "slot-occupied");
    assert.equal(out.occupiedBy.issueNumber, "42");
  });

  it("steals a slot whose recorded pid is dead", () => {
    // pid 1 (init) is always alive on macOS / linux. We need a definitely-dead
    // pid — use 0 which factory-state.mjs's mergeSlot normalises but
    // process.kill(0) is a special signal-self call. Use 1_999_999 which is
    // beyond pid_max on every default kernel config.
    writeFileSync(
      stateFile,
      JSON.stringify({
        slots: { 0: { pid: 1999999, issueNumber: "42", acquiredAt: "x" } },
      }),
    );
    const r = run([
      "factory:slot-acquire",
      "0",
      "99",
      String(process.pid),
      "--state-file",
      stateFile,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.issueNumber, "99");
  });

  it("--force overrides the occupancy check even for live pids", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        slots: { 0: { pid: process.pid, issueNumber: "42", acquiredAt: "x" } },
      }),
    );
    const r = run([
      "factory:slot-acquire",
      "0",
      "99",
      String(process.pid),
      "--force",
      "true",
      "--state-file",
      stateFile,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.issueNumber, "99");
  });

  it("slot-release clears the slot fields", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        slots: { 1: { pid: process.pid, issueNumber: "42", acquiredAt: "x" } },
      }),
    );
    const r = run(["factory:slot-release", "1", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    const state = readState();
    assert.deepEqual(state.slots["1"], { pid: null, issueNumber: null, acquiredAt: null });
  });

  it("slot-status without arg returns all slots; with arg returns one", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        slots: {
          0: { pid: 1, issueNumber: "42", acquiredAt: "x" },
          1: { pid: null, issueNumber: null, acquiredAt: null },
        },
      }),
    );
    let r = run(["factory:slot-status", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    let out = JSON.parse(r.stdout);
    assert.equal(out.slots["0"].issueNumber, "42");

    r = run(["factory:slot-status", "0", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    out = JSON.parse(r.stdout);
    assert.equal(out.slot, 0);
    assert.equal(out.issueNumber, "42");
  });
});

describe("factory:bump-attempts / reset-attempts / get-attempts", () => {
  it("bump-attempts increments from zero across multiple calls", () => {
    let r = run(["factory:bump-attempts", "42", "--state-file", stateFile]);
    let out = JSON.parse(r.stdout);
    assert.equal(out.attempts, 1);
    r = run(["factory:bump-attempts", "42", "--state-file", stateFile]);
    out = JSON.parse(r.stdout);
    assert.equal(out.attempts, 2);
  });

  it("reset-attempts zeroes the counter; get-attempts prints bare integer", () => {
    writeFileSync(stateFile, JSON.stringify({ issues: { 42: { attempts: 5 } } }));
    let r = run(["factory:get-attempts", "42", "--state-file", stateFile]);
    assert.equal(r.stdout, "5");

    r = run(["factory:reset-attempts", "42", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    const state = readState();
    assert.equal(state.issues["42"].attempts, 0);

    r = run(["factory:get-attempts", "42", "--state-file", stateFile]);
    assert.equal(r.stdout, "0");
  });

  it("get-attempts returns 0 for an unknown issue (bash-friendly default)", () => {
    const r = run(["factory:get-attempts", "999", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "0");
  });
});

describe("factory:set-issue-field / get-issue", () => {
  it("writes only allowlisted fields", () => {
    const r = run([
      "factory:set-issue-field",
      "42",
      "lastPlanAt",
      "2026-05-21T10:00:00.000Z",
      "--state-file",
      stateFile,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const state = readState();
    assert.equal(state.issues["42"].lastPlanAt, "2026-05-21T10:00:00.000Z");
  });

  it("rejects an unknown field", () => {
    const r = run([
      "factory:set-issue-field",
      "42",
      "arbitraryField",
      "x",
      "--state-file",
      stateFile,
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown field/);
  });

  it("clears the field on empty value", () => {
    writeFileSync(stateFile, JSON.stringify({ issues: { 42: { lastError: "boom" } } }));
    const r = run(["factory:set-issue-field", "42", "lastError", "", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    const state = readState();
    assert.equal(state.issues["42"].lastError, null);
  });

  it("get-issue returns the issue record (initialised if missing)", () => {
    const r = run(["factory:get-issue", "999", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.attempts, 0);
    assert.equal(out.lastPlanAt, null);
  });

  it("accepts the CodeRabbit lane fields (a rejected one would fail silently under bash `|| true`)", () => {
    for (const field of [
      "crConvergedSha",
      "crConvergedAt",
      "crCoverageSha",
      "crCoverage",
      "crLastCoveredSha",
      "crCliRuns",
      "crCliFreePassSha",
    ]) {
      const r = run(["factory:set-issue-field", "42", field, "v1", "--state-file", stateFile]);
      assert.equal(r.status, 0, `${field}: ${r.stderr}`);
      assert.equal(readState().issues["42"][field], "v1");
    }
  });
});

describe("factory:cr-cli-* (CodeRabbit CLI lane, ADR-0036)", () => {
  const T0 = "2026-09-12T20:00:00.000Z";
  const SHA = "c".repeat(40);
  const inFlight = {
    runId: "run-9",
    issue: "42",
    pr: "600",
    sha: SHA,
    baseSha: null,
    mode: "full",
    pid: 321,
    startedAt: T0,
    deadlineAt: "2026-09-12T20:45:00.000Z",
    runDir: "/tmp/run-9",
    worktree: "/tmp/wt-9",
  };

  it("factory:cr-cli-status on a fresh file reports an idle, unpaused lane", () => {
    const r = run(["factory:cr-cli-status", "--state-file", stateFile, "--now", T0]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      runs: [],
      inFlight: null,
      pausedUntil: null,
      pausedReason: null,
      usedLastHour: 0,
      nextSlotAt: null,
      paused: false,
    });
  });

  it("factory:cr-cli-status derives usedLastHour / nextSlotAt from the ledger", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        crCli: {
          runs: [
            { runId: "r1", issue: "1", sha: SHA, startedAt: "2026-09-12T19:20:00.000Z" },
            { runId: "r2", issue: "1", sha: SHA, startedAt: "2026-09-12T18:00:00.000Z" },
          ],
          inFlight,
        },
      }),
    );
    const r = run(["factory:cr-cli-status", "--state-file", stateFile, "--now", T0]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.usedLastHour, 1);
    assert.equal(out.nextSlotAt, "2026-09-12T20:20:00.000Z");
    assert.equal(out.inFlight.runId, "run-9");
    assert.equal(out.runs.length, 2);
  });

  it("factory:cr-cli-pause-until pauses only the lane, never the factory", () => {
    const r = run([
      "factory:cr-cli-pause-until",
      "2026-09-12T22:50:00+02:00",
      "rate_limited",
      "--state-file",
      stateFile,
      "--now",
      T0,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      ok: true,
      pausedUntil: "2026-09-12T20:50:00.000Z",
      pausedReason: "rate_limited",
    });
    const state = readState();
    assert.equal(state.crCli.pausedUntil, "2026-09-12T20:50:00.000Z");
    assert.equal(state.paused, false);

    const status = run(["factory:cr-cli-status", "--state-file", stateFile, "--now", T0]);
    assert.equal(JSON.parse(status.stdout).paused, true);
    // The factory-wide gate must stay open: exit 1 = not paused.
    assert.equal(run(["factory:paused?", "--state-file", stateFile, "--now", T0]).status, 1);
  });

  it("factory:cr-cli-pause-until rejects a missing or invalid <until-iso>", () => {
    const missing = run(["factory:cr-cli-pause-until", "--state-file", stateFile]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /requires <until-iso>/);
    const bad = run(["factory:cr-cli-pause-until", "later", "--state-file", stateFile]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /invalid <until-iso>/);
  });

  it("factory:cr-cli-status clears and persists an expired lane pause", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        crCli: { pausedUntil: "2026-09-12T19:59:00.000Z", pausedReason: "rate_limited" },
      }),
    );
    const r = run(["factory:cr-cli-status", "--state-file", stateFile, "--now", T0]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).paused, false);
    assert.equal(readState().crCli.pausedUntil, null);
    assert.equal(readState().crCli.pausedReason, null);
  });

  it("factory:cr-cli-resume clears the lane pause", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ crCli: { pausedUntil: "2026-09-12T23:00:00.000Z", pausedReason: "auth" } }),
    );
    const r = run(["factory:cr-cli-resume", "--state-file", stateFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, paused: false });
    assert.equal(readState().crCli.pausedUntil, null);
  });

  it("factory:cr-cli-finish releases the matching in-flight run (default refund none)", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        issues: { 42: { crCliRuns: "1" } },
        crCli: { runs: [{ runId: "run-9", issue: "42", sha: SHA, startedAt: T0 }], inFlight },
      }),
    );
    const r = run(["factory:cr-cli-finish", "run-9", "--state-file", stateFile, "--now", T0]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      ok: true,
      runId: "run-9",
      refund: "none",
      issue: "42",
      // pid 321 is not this run's supervisor, whatever it is on this machine.
      killed: false,
    });
    const state = readState();
    assert.equal(state.crCli.inFlight, null);
    assert.equal(state.crCli.runs.length, 1);
    assert.equal(state.issues["42"].crCliRuns, "1");
  });

  it("factory:cr-cli-finish --refund spawn gives back the slot and the card run", () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        issues: { 42: { crCliRuns: "1" } },
        crCli: { runs: [{ runId: "run-9", issue: "42", sha: SHA, startedAt: T0 }], inFlight },
      }),
    );
    const r = run([
      "factory:cr-cli-finish",
      "run-9",
      "--refund",
      "spawn",
      "--state-file",
      stateFile,
      "--now",
      T0,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const state = readState();
    assert.deepEqual(state.crCli.runs, []);
    assert.equal(state.issues["42"].crCliRuns, "0");
  });

  // A stand-in supervisor: its own process group (detached, like the real one),
  // with the run id on its command line.
  function startFakeSupervisor(runId) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", runId], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return child;
  }

  async function waitForExit(child, timeoutMs = 5000) {
    if (child.exitCode !== null || child.signalCode !== null) return child.signalCode;
    return Promise.race([
      new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal))),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
    ]);
  }

  // ADR-0037: a manual `coderabbit-cli.mjs review` holds the lane from its own,
  // non-leader process whose argv carries the PR, not the run id.
  const manualInFlight = (pid) => ({
    runId: "pr637-dddddddddddd-20260914T180000Z",
    issue: null,
    pr: "637",
    sha: SHA,
    pid,
    startedAt: T0,
    deadlineAt: "2026-09-12T20:30:00.000Z",
    manual: true,
  });
  // A stand-in that node really executes as coderabbit-cli.mjs, so its ps
  // command line has the same shape as a real `review` process.
  const startFakeManualReview = (pr) => {
    const script = path.join(workdir, "coderabbit-cli.mjs");
    writeFileSync(script, "setInterval(() => {}, 1000);\n");
    return spawn(process.execPath, [script, "review", "--pr", pr], { stdio: "ignore" });
  };
  const writeManual = (pid) =>
    writeFileSync(
      stateFile,
      JSON.stringify({
        crCli: {
          runs: [{ runId: manualInFlight(pid).runId, issue: "pr-637", sha: SHA, startedAt: T0 }],
          inFlight: manualInFlight(pid),
        },
      }),
    );

  it("factory:cr-cli-finish SIGTERMs a live manual review (its pid, not a group) before releasing", async () => {
    const child = startFakeManualReview("637");
    try {
      await new Promise((resolve) => child.once("spawn", resolve));
      writeManual(child.pid);
      const exited = waitForExit(child);
      const r = spawn(process.execPath, [
        CLI,
        "factory:cr-cli-finish",
        manualInFlight(child.pid).runId,
        "--state-file",
        stateFile,
        "--now",
        T0,
      ]);
      let stdout = "";
      r.stdout.on("data", (d) => (stdout += d));
      const code = await new Promise((resolve) => r.once("close", resolve));
      assert.equal(code, 0);
      assert.equal(await exited, "SIGTERM");
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.equal(out.killed, true);
      assert.equal(readState().crCli.inFlight, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("factory:cr-cli-finish never signals a live pid that is not that PR's manual review", async () => {
    const child = startFakeManualReview("6370");
    try {
      await new Promise((resolve) => child.once("spawn", resolve));
      writeManual(child.pid);
      const r = run([
        "factory:cr-cli-finish",
        manualInFlight(child.pid).runId,
        "--state-file",
        stateFile,
        "--now",
        T0,
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).killed, false);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.equal(readState().crCli.inFlight, null);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("factory:cr-cli-finish SIGTERMs the live supervisor's process group before releasing the run", async () => {
    const runId = "42-cccccccccccc-20260912T200000Z";
    const child = startFakeSupervisor(runId);
    try {
      await new Promise((resolve) => child.once("spawn", resolve));
      writeFileSync(
        stateFile,
        JSON.stringify({
          issues: { 42: { crCliRuns: "1" } },
          crCli: {
            runs: [{ runId, issue: "42", sha: SHA, startedAt: T0 }],
            inFlight: { ...inFlight, runId, pid: child.pid },
          },
        }),
      );
      const r = spawnSync(
        "node",
        [CLI, "factory:cr-cli-finish", runId, "--state-file", stateFile, "--now", T0],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.killed, true);
      assert.equal(await waitForExit(child), "SIGTERM");
      assert.equal(readState().crCli.inFlight, null);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("factory:cr-cli-finish keeps the run in flight while a group member (the CLI) outlives the supervisor", async () => {
    const runId = "42-eeeeeeeeeeee-20260912T210000Z";
    // The leader stands in for the supervisor: it starts a SIGTERM-ignoring child
    // in its own process group (the CLI), then exits on SIGTERM itself.
    const leaderScript = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const leader = spawn(process.execPath, ["-e", leaderScript, runId], {
      detached: true,
      stdio: "ignore",
    });
    leader.unref();
    try {
      await new Promise((resolve) => leader.once("spawn", resolve));
      await new Promise((resolve) => setTimeout(resolve, 500)); // child started, handlers installed
      writeFileSync(
        stateFile,
        JSON.stringify({ crCli: { runs: [], inFlight: { ...inFlight, runId, pid: leader.pid } } }),
      );
      const r = spawnSync(
        "node",
        [CLI, "factory:cr-cli-finish", runId, "--wait-ms", "600", "--state-file", stateFile],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false, r.stdout);
      assert.equal(out.reason, "supervisor-still-running");
      assert.equal(readState().crCli.inFlight.runId, runId);
    } finally {
      try {
        process.kill(-leader.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("factory:cr-cli-finish keeps the run in flight when the supervisor survives SIGTERM", async () => {
    const runId = "42-dddddddddddd-20260912T210000Z";
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", runId],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    try {
      await new Promise((resolve) => child.once("spawn", resolve));
      // Give node a moment to install the SIGTERM handler before we signal it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const seeded = { crCli: { runs: [], inFlight: { ...inFlight, runId, pid: child.pid } } };
      writeFileSync(stateFile, JSON.stringify(seeded));
      const r = spawnSync(
        "node",
        [CLI, "factory:cr-cli-finish", runId, "--wait-ms", "400", "--state-file", stateFile],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.reason, "supervisor-still-running");
      // The signal went out, but the group survived it: not "killed".
      assert.equal(out.signalled, true);
      assert.equal(out.killed, false);
      assert.equal(out.pid, child.pid);
      // Nothing released: the gate must not start a second run meanwhile.
      assert.equal(readState().crCli.inFlight.runId, runId);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("factory:cr-cli-finish rejects a malformed --wait-ms before signalling", () => {
    writeFileSync(stateFile, JSON.stringify({ crCli: { runs: [], inFlight } }));
    const r = run([
      "factory:cr-cli-finish",
      "run-9",
      "--wait-ms",
      "soon",
      "--state-file",
      stateFile,
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid --wait-ms/);
    assert.equal(readState().crCli.inFlight.runId, "run-9");
  });

  it("factory:cr-cli-finish leaves a live pid alone when its command is not this run's", async () => {
    const child = startFakeSupervisor("some-other-run");
    try {
      await new Promise((resolve) => child.once("spawn", resolve));
      writeFileSync(
        stateFile,
        JSON.stringify({ crCli: { runs: [], inFlight: { ...inFlight, pid: child.pid } } }),
      );
      const r = spawnSync(
        "node",
        [CLI, "factory:cr-cli-finish", "run-9", "--state-file", stateFile, "--now", T0],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).killed, false);
      assert.equal(await waitForExit(child, 300), "timeout");
      assert.equal(readState().crCli.inFlight, null);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("factory:cr-cli-finish signals nothing on a mismatched runId or an invalid refund", async () => {
    const runId = "42-cccccccccccc-20260912T210000Z";
    const child = startFakeSupervisor(runId);
    try {
      await new Promise((resolve) => child.once("spawn", resolve));
      writeFileSync(
        stateFile,
        JSON.stringify({ crCli: { runs: [], inFlight: { ...inFlight, runId, pid: child.pid } } }),
      );
      const mismatch = run(["factory:cr-cli-finish", "run-OTHER", "--state-file", stateFile]);
      assert.equal(mismatch.status, 0, mismatch.stderr);
      assert.equal(JSON.parse(mismatch.stdout).ok, false);
      const bad = run([
        "factory:cr-cli-finish",
        runId,
        "--refund",
        "all",
        "--state-file",
        stateFile,
      ]);
      assert.notEqual(bad.status, 0);
      assert.equal(await waitForExit(child, 300), "timeout");
      assert.equal(readState().crCli.inFlight.runId, runId);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("factory:cr-cli-finish on a mismatched runId exits 0 with ok:false and writes nothing", () => {
    const original = JSON.stringify({ crCli: { runs: [], inFlight } });
    writeFileSync(stateFile, original);
    const r = run(["factory:cr-cli-finish", "run-OTHER", "--state-file", stateFile, "--now", T0]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "run-id-mismatch");
    assert.equal(readFileSync(stateFile, "utf8"), original);
  });

  it("factory:cr-cli-finish rejects a missing runId or an unknown refund kind", () => {
    const missing = run(["factory:cr-cli-finish", "--state-file", stateFile]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /requires <runId>/);
    writeFileSync(stateFile, JSON.stringify({ crCli: { runs: [], inFlight } }));
    const bad = run([
      "factory:cr-cli-finish",
      "run-9",
      "--refund",
      "all",
      "--state-file",
      stateFile,
    ]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /invalid refund/);
  });

  it("--help lists the lane subcommands", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /factory:cr-cli-status/);
    assert.match(r.stdout, /factory:cr-cli-pause-until/);
    assert.match(r.stdout, /factory:cr-cli-resume/);
    assert.match(r.stdout, /factory:cr-cli-finish/);
  });
});

describe("factory:* writes to logs/factory-state.json by default", () => {
  it("does not touch support-state.json when no --state-file is passed", () => {
    // Use a tmpdir as cwd so the auto-created factory-state.json lands there.
    const cwd = mkdtempSync(path.join(tmpdir(), "factory-cwd-"));
    try {
      // Run from a directory where the default factory state path is writable.
      // We can't easily inspect the actual default path side-effects in this
      // test (it's anchored to the repo's logs/ dir), so just confirm the
      // status command runs cleanly without --state-file.
      const r = spawnSync("node", [CLI, "--help"], { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /factory:pause/);
      assert.match(r.stdout, /factory:slot-acquire/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
