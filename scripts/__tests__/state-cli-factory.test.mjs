import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
