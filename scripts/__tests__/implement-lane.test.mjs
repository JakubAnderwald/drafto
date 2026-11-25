// Unit tests for detached --implement runs (ADR-0085): the ledger in
// factory-state.mjs, and implement-lane.mjs's decisions (run states, what a
// collected run means, which process groups are the run's) and subcommands with
// their processes, git and spawning faked. The real detached spawn is in
// implement-lane-supervisor.test.mjs.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachImplementRun,
  emptyFactoryState,
  finishImplementRun,
  getImplement,
  loadFactoryState,
  reserveImplementRun,
  saveFactoryState,
} from "../lib/factory-state.mjs";
import {
  DRAINING_AFTER_MS,
  FORMAT_VERSION,
  OVERDUE_AFTER_MS,
  UNATTACHED_LOST_MS,
  buildImplementArgv,
  buildImplementEnv,
  classifyRun,
  collectOutcome,
  main,
  makeRunId,
  observeRun,
  runGroups,
  runSupervise,
  trackRun,
} from "../lib/implement-lane.mjs";
import {
  descendants,
  groupRunState,
  parseProcessTable,
  processTable,
} from "../lib/supervisor-proc.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_CLI = resolve(HERE, "..", "lib", "state-cli.mjs");
const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SID2 = "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NOW = Date.parse("2026-11-17T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

const dirs = [];
function tempDir() {
  const d = fs.mkdtempSync(join(tmpdir(), "implement-lane-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// <a> and <b> both occur in <calls>, <a> first. Never vacuous: a missing call
// fails the check instead of reading as -1.
function before(calls, a, b) {
  const i = calls.indexOf(a);
  const j = calls.indexOf(b);
  return i >= 0 && j >= 0 && i < j;
}

const reserve = (state, over = {}) =>
  reserveImplementRun(state, {
    issue: "7",
    runId: "20261117T100000Z-abc123",
    slot: 1,
    mode: "fresh",
    sessionId: SID,
    maxRunning: 1,
    now: iso(NOW),
    ...over,
  });

describe("ledger: reserve, attach, finish (factory-state.mjs)", () => {
  it("reserves with pid null, attaches by runId, finishes by runId", () => {
    const s = emptyFactoryState();
    assert.deepEqual(reserve(s), { ok: true, runId: "20261117T100000Z-abc123" });
    const run = getImplement(s).runs["7"];
    assert.equal(run.pid, null);
    assert.equal(run.slot, 1);
    assert.equal(run.mode, "fresh");
    assert.equal(attachImplementRun(s, "7", "other-run", { pid: 42 }), false, "a stale attach");
    assert.equal(
      attachImplementRun(s, "7", "20261117T100000Z-abc123", {
        pid: 42,
        deadlineAt: "d",
        hardKillAt: "h",
        runDir: "/r",
        worktree: "/w",
      }),
      true,
    );
    assert.equal(getImplement(s).runs["7"].pid, 42);
    assert.equal(finishImplementRun(s, "7", "other-run").reason, "run-id-mismatch");
    assert.equal(finishImplementRun(s, "7", "20261117T100000Z-abc123").ok, true);
    assert.deepEqual(getImplement(s).runs, {});
  });

  it("records the worktree and run dir at reserve, before anything is spawned", () => {
    const s = emptyFactoryState();
    reserve(s, { worktree: "/wt/7", runDir: "/runs/7-x" });
    assert.deepEqual(
      [getImplement(s).runs["7"].worktree, getImplement(s).runs["7"].runDir],
      ["/wt/7", "/runs/7-x"],
    );
  });

  it("refuses a second run of the same card, and more than maxRunning runs", () => {
    const s = emptyFactoryState();
    reserve(s, { maxRunning: 2 });
    assert.equal(reserve(s, { maxRunning: 2, runId: "x" }).reason, "running");
    assert.equal(
      reserve(s, { issue: "8", slot: 0, runId: "y", maxRunning: 1 }).reason,
      "max-running",
    );
    assert.equal(reserve(s, { issue: "8", slot: 0, runId: "y", maxRunning: 2 }).ok, true);
    assert.equal(
      reserve(s, { issue: "9", slot: 0, runId: "z", maxRunning: 2 }).reason,
      "max-running",
    );
  });

  it("validates its inputs", () => {
    const s = emptyFactoryState();
    assert.throws(() => reserve(s, { issue: "0" }), /issue/);
    assert.throws(() => reserve(s, { slot: 2 }), /slot/);
    assert.throws(() => reserve(s, { mode: "other" }), /mode/);
    assert.throws(() => reserve(s, { sessionId: "nope" }), /sessionId/);
    assert.throws(() => reserve(s, { maxRunning: 0 }), /maxRunning/);
    assert.throws(() => reserve(s, { now: "garbage" }), /now/);
  });

  it("survives a save and load, and an older file without it loads empty", async () => {
    const dir = tempDir();
    const file = join(dir, "state.json");
    const s = emptyFactoryState();
    reserve(s);
    await saveFactoryState(s, file);
    const back = await loadFactoryState(file);
    assert.equal(back.implement.runs["7"].runId, "20261117T100000Z-abc123");
    fs.writeFileSync(file, JSON.stringify({ paused: false, slots: {} }));
    assert.deepEqual((await loadFactoryState(file)).implement, { runs: {} });
    // A run with no runId could never be finished: dropped. A bad key too.
    fs.writeFileSync(
      file,
      JSON.stringify({ implement: { runs: { 7: { pid: 3 }, x: { runId: "r" } }, extra: 1 } }),
    );
    assert.deepEqual((await loadFactoryState(file)).implement, { runs: {}, extra: 1 });
  });

  it("state-cli factory:implement-status prints the ledger", async () => {
    const dir = tempDir();
    const file = join(dir, "state.json");
    const s = emptyFactoryState();
    reserve(s);
    await saveFactoryState(s, file);
    const r = spawnSync("node", [STATE_CLI, "factory:implement-status", "--state-file", file], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).runs["7"].sessionId, SID);
  });
});

describe("buildImplementArgv / buildImplementEnv", () => {
  it("builds the synchronous call's flags, fresh and resumed", () => {
    assert.deepEqual(buildImplementArgv({ effort: "ultracode", mode: "fresh", sessionId: SID }), [
      "--dangerously-skip-permissions",
      "--effort",
      "ultracode",
      "--no-chrome",
      "--strict-mcp-config",
      "--session-id",
      SID,
    ]);
    assert.equal(
      buildImplementArgv({ effort: "high", mode: "resume", sessionId: SID }).at(-2),
      "--resume",
    );
  });

  it("puts --model right before the session flag when given, nothing when absent (ADR-0099)", () => {
    assert.deepEqual(
      buildImplementArgv({ effort: "xhigh", model: "opus[1m]", mode: "fresh", sessionId: SID }),
      [
        "--dangerously-skip-permissions",
        "--effort",
        "xhigh",
        "--no-chrome",
        "--strict-mcp-config",
        "--model",
        "opus[1m]",
        "--session-id",
        SID,
      ],
    );
    assert.deepEqual(
      buildImplementArgv({
        effort: "high",
        model: "claude-sonnet-5-5",
        mode: "resume",
        sessionId: SID,
      }).slice(-4),
      ["--model", "claude-sonnet-5-5", "--resume", SID],
    );
    for (const model of [undefined, null, ""]) {
      assert.ok(
        !buildImplementArgv({ effort: "high", model, mode: "fresh", sessionId: SID }).includes(
          "--model",
        ),
        JSON.stringify(model),
      );
    }
  });

  it("refuses a model the bash side would never pass", () => {
    for (const model of ["--chrome", "sonnet --chrome", "Sonnet", "gpt-5", "opus[2m]", 7]) {
      assert.throws(
        () => buildImplementArgv({ effort: "high", model, mode: "fresh", sessionId: SID }),
        /invalid model/,
        JSON.stringify(model),
      );
    }
  });

  it("refuses an effort, mode or session id the bash side would never pass", () => {
    assert.throws(() => buildImplementArgv({ effort: "$(id)", mode: "fresh", sessionId: SID }));
    assert.throws(() => buildImplementArgv({ effort: "high", mode: "fork", sessionId: SID }));
    assert.throws(() => buildImplementArgv({ effort: "high", mode: "fresh", sessionId: "--help" }));
  });

  it("keeps the tick's env and sets the three per-call variables", () => {
    const env = buildImplementEnv(
      { PATH: "/p", HOME: "/h" },
      { timeoutSec: 2700, termGraceSec: 30 },
    );
    assert.deepEqual(env, {
      PATH: "/p",
      HOME: "/h",
      CLAUDE_CALL_TIMEOUT_SEC: "2700",
      CLAUDE_CALL_KILL_GRACE_SEC: "30",
      CLAUDE_CALL_KILL_GROUP: "1",
    });
  });

  it("makes sortable run ids", () => {
    assert.equal(
      makeRunId(NOW, () => "abc123"),
      "20261117T100000Z-abc123",
    );
  });
});

describe("classifyRun: the status table", () => {
  const base = {
    runId: "r",
    pid: 100,
    startedAt: iso(NOW - 10 * 60_000),
    deadlineAt: iso(NOW + 30 * 60_000),
    hardKillAt: iso(NOW + 35 * 60_000),
  };
  // reboot: the machine booted after the run's last heartbeat.
  const c = (run, { reboot = false, ...files }, alive, nowMs = NOW) =>
    classifyRun({
      run: { ...base, ...run },
      metaProblem: null,
      exitProblem: null,
      heartbeatMs: NOW - 600_000,
      bootMs: reboot ? NOW - 60_000 : NOW - 86_400_000,
      ...files,
      alive,
      nowMs,
    });
  const exit = (endedMs) => ({ exitCode: 0, endedAt: iso(endedMs) });

  const table = [
    [
      "starting: no pid, fresh, nothing alive",
      { pid: null, startedAt: iso(NOW - 10_000) },
      {},
      false,
      "starting",
    ],
    [
      "unattached: no pid, older than the window",
      { pid: null, startedAt: iso(NOW - UNATTACHED_LOST_MS) },
      {},
      false,
      "unattached",
    ],
    ["unattached and alive: a supervisor nothing attached", { pid: null }, {}, true, "unattached"],
    ["running", {}, {}, true, "running"],
    [
      "running past the deadline, before the hard kill",
      { deadlineAt: iso(NOW - 1000) },
      {},
      true,
      "running",
    ],
    ["overdue", { hardKillAt: iso(NOW - OVERDUE_AFTER_MS) }, {}, true, "overdue"],
    ["lost, after a reboot since its last heartbeat", {}, { reboot: true }, false, "lost"],
    ["lost, cleared by an operator", {}, { cleared: true }, false, "lost"],
    ["dead without exit.json and no reboot: cleanup unverified", {}, {}, false, "unverified"],
    ["exit.json says the cleanup wasn't clean", {}, { unverified: true }, false, "unverified"],
    ["done", {}, { exit: exit(NOW - 1000) }, false, "done"],
    [
      "finishing: exit.json fresh, group still exiting",
      {},
      { exit: exit(NOW - 1000) },
      true,
      "running",
    ],
    ["draining", {}, { exit: exit(NOW - DRAINING_AFTER_MS) }, true, "draining"],
    ["unreadable meta", {}, { metaProblem: "meta.json formatVersion 2" }, false, "unreadable"],
    ["unreadable exit", {}, { exitProblem: "exit.json corrupt" }, true, "unreadable"],
  ];
  for (const [name, run, files, alive, want] of table) {
    it(name, () => assert.equal(c(run, files, alive).state, want));
  }

  it("reports pastDeadline", () => {
    assert.equal(c({}, {}, true).pastDeadline, false);
    assert.equal(c({ deadlineAt: iso(NOW) }, {}, true).pastDeadline, true);
  });
});

describe("collectOutcome: what an ended run hands the handler", () => {
  const table = [
    ["lost before the deadline → interrupted", null, false, { interrupted: true }],
    ["lost past the deadline → 124", null, true, { exitCode: 124 }],
    [
      "the supervisor's backstop → 124",
      { backstop: true, exitCode: 143, terminated: false },
      false,
      { exitCode: 124 },
    ],
    [
      "stopped from outside before the deadline → interrupted",
      { terminated: true, exitCode: 143 },
      false,
      { interrupted: true },
    ],
    [
      "stopped from outside past the deadline → 124",
      { terminated: true, exitCode: 143 },
      true,
      { exitCode: 124 },
    ],
    [
      "stopped, but claude had already ended 0 → 0",
      { terminated: true, exitCode: 0 },
      false,
      { exitCode: 0 },
    ],
    ["run-claude's own cap → 124", { exitCode: 124 }, true, { exitCode: 124 }],
    ["a failure → its code", { exitCode: 1 }, false, { exitCode: 1 }],
    ["success → 0", { exitCode: 0 }, false, { exitCode: 0 }],
    [
      "no exit code at all (supervisor error) → 1",
      { exitCode: null, error: "meta.json corrupt" },
      false,
      { exitCode: 1 },
    ],
  ];
  for (const [name, exit, pastDeadline, want] of table) {
    it(name, () => {
      const got = collectOutcome({ exit, pastDeadline });
      for (const [k, v] of Object.entries(want))
        assert.equal(got[k], v, `${k} in ${JSON.stringify(got)}`);
      if (!want.interrupted) assert.equal(got.interrupted, false);
    });
  }
});

describe("process groups: runGroups and the supervisor-proc helpers", () => {
  const RUN = { runId: "20261117T100000Z-abc123", pid: 100, sessionId: SID };
  const sup = `node /x/implement-lane.mjs _supervise --run-dir /logs/implement/7-${RUN.runId}`;
  const ps = (lines) => parseProcessTable(lines.join("\n"));

  it("parses ps rows with the parent pid", () => {
    assert.deepEqual(ps(["  100     1   100 Ss   node a b"])[0], {
      pid: 100,
      ppid: 1,
      pgid: 100,
      lstart: null,
      stat: "Ss",
      command: "node a b",
    });
    // With the start time (ps -o lstart=, C locale), which tells a reused pid.
    assert.deepEqual(ps(["  100     1   100 Tue Nov  7 10:00:00 2026     Ss   node a b"])[0], {
      pid: 100,
      ppid: 1,
      pgid: 100,
      lstart: "Tue Nov 7 10:00:00 2026",
      stat: "Ss",
      command: "node a b",
    });
  });

  it("finds the supervisor's group and claude's own group below it", () => {
    const rows = ps([
      `100 1 100 Ss ${sup}`,
      `101 100 100 S node run-claude.mjs -p input --session-id ${SID}`,
      `102 101 102 S claude -p input --session-id ${SID}`,
      "103 102 102 S bash -c pnpm test",
      "104 103 104 S node vitest (setsid)",
      "200 1 200 S unrelated",
    ]);
    assert.deepEqual(
      runGroups(RUN, rows).sort((a, b) => a - b),
      [100, 102, 104],
    );
    assert.deepEqual(
      descendants(rows, 100).map((r) => r.pid),
      [101, 102, 103, 104],
    );
  });

  it("a reused pid without the run id is not ours", () => {
    const rows = ps(["100 1 100 Ss node something-else", "200 1 200 S other"]);
    assert.equal(groupRunState(rows, RUN), "gone");
    assert.deepEqual(runGroups(RUN, rows), []);
  });

  it("the leader gone, its group still alive (run-claude left), counts", () => {
    const rows = ps(["101 1 100 S node run-claude.mjs", "102 101 102 S claude"]);
    assert.deepEqual(runGroups({ ...RUN, sessionId: null }, rows).sort(), [100, 102]);
  });

  it("an orphaned claude session is found by its session id", () => {
    const rows = ps([`102 1 102 S claude -p input --resume ${SID}`]);
    assert.deepEqual(runGroups(RUN, rows), [102]);
    assert.deepEqual(runGroups({ ...RUN, sessionId: SID2 }, rows), []);
  });

  it("an operator's interactive `claude --resume <id>` (a shell's child) is never the run", () => {
    const rows = ps(["500 1 500 Ss -zsh", `501 500 501 S+ claude --resume ${SID}`]);
    assert.deepEqual(runGroups(RUN, rows), []);
    assert.deepEqual(runGroups({ ...RUN, pid: null }, rows), []);
  });

  it("a prompt that mentions implement-lane.mjs doesn't hide an orphaned claude", () => {
    const rows = ps([
      `102 1 102 S claude -p "fix implement-lane.mjs _supervise" --session-id ${SID}`,
    ]);
    assert.deepEqual(runGroups(RUN, rows), [102]);
  });

  it("only a claude call carrying the id as its session flag counts, nothing that merely mentions it", () => {
    const rows = ps([
      `300 1 300 S less /Users/x/.claude/projects/p/${SID}.jsonl`,
      `301 1 301 S node state-cli.mjs factory:implement-resume-clear 7 --session-id ${SID}`,
      `302 1 302 S grep ${SID}`,
      `303 1 303 S claude -p x --session-id ${SID}0`,
    ]);
    assert.deepEqual(runGroups(RUN, rows), []);
    assert.deepEqual(
      runGroups(RUN, ps([`304 1 304 S node /x/run-claude.mjs -p x --session-id ${SID}`])),
      [304],
    );
  });

  it("finds a supervisor the ledger never got the pid of", () => {
    const rows = ps([`300 1 300 Ss ${sup}`]);
    assert.deepEqual(runGroups({ ...RUN, pid: null, sessionId: null }, rows), [300]);
  });

  it("never names the caller's own group, nor a zombie's", () => {
    const rows = ps([
      `500 1 500 S bash factory-agent.sh --implement --session-id ${SID}`,
      `501 500 500 S node implement-lane.mjs status`,
      `102 1 102 Z claude ${SID}`,
    ]);
    assert.deepEqual(runGroups(RUN, rows, { selfPids: [501, 500] }), []);
  });
});

// ── the subcommands, with processes, git and spawning faked ─────────────────

function fakeDeps({
  rows = [],
  pressure = 1,
  spawnOk = true,
  spawnPid = 4242,
  gitCode = 0,
  lockedWorktrees = [],
} = {}) {
  const calls = [];
  const tables = Array.isArray(rows[0]) ? [...rows] : null;
  let clock = NOW;
  const deps = {
    calls,
    env: { PATH: "/usr/bin:/bin" },
    fs,
    nowMs: () => clock,
    table: () => (tables ? (tables.length > 1 ? tables.shift() : tables[0]) : rows),
    kill: (pid, sig) => {
      calls.push(`kill ${pid} ${sig}`);
      return true;
    },
    // `worktree list` names deps.worktrees (start() sets the test's own), with
    // the ones in <lockedWorktrees> locked; gitCode fails `worktree lock`.
    worktrees: [],
    git: async (args) => {
      calls.push(`git ${args.join(" ")}`);
      if (args[0] === "worktree" && args[1] === "list") {
        const list = deps.worktrees
          .map((w) => `worktree ${w}\nHEAD abc\n${lockedWorktrees.includes(w) ? "locked\n" : ""}`)
          .join("\n");
        return { code: 0, stdout: list + "\n", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "lock" && gitCode) {
        return { code: gitCode, stdout: "", stderr: "fatal: nope" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    spawnDetached: async (cmd, args, opts) => {
      calls.push(`spawn ${args.slice(1).join(" ")}`);
      calls.push(`spawn-env PATH=${opts.env.PATH}`);
      return spawnOk ? { ok: true, pid: spawnPid } : { ok: false, reason: "ENOENT" };
    },
    memoryPressure: async () => pressure,
    bootTimeMs: () => null,
    sleep: async (ms) => {
      clock += ms;
    },
    selfPids: [process.pid],
  };
  return deps;
}

async function setup({ slotIssue = "7", runs = null, paused = false } = {}) {
  const dir = tempDir();
  const stateFile = join(dir, "state.json");
  const wt = join(dir, "wt");
  fs.mkdirSync(wt);
  const s = emptyFactoryState();
  if (slotIssue) s.slots[1] = { pid: 99, issueNumber: slotIssue, acquiredAt: iso(NOW) };
  if (paused) s.paused = true;
  if (runs) s.implement.runs = runs;
  await saveFactoryState(s, stateFile);
  const inputFile = join(dir, "input");
  fs.writeFileSync(inputFile, "the prompt\n\n## Context bundle\n");
  const specFile = join(dir, "spec.json");
  const spec = {
    issue: "7",
    slot: 1,
    worktree: wt,
    inputFile,
    effort: "ultracode",
    mode: "fresh",
    sessionId: SID,
    timeoutSec: "2700",
    termGraceSec: "30",
    killGraceSec: "300",
    maxRunning: "1",
    ctx: { itemId: "item-7", priorPr: "null" },
  };
  fs.writeFileSync(specFile, JSON.stringify(spec));
  return { dir, stateFile, wt, specFile, runRoot: join(dir, "logs", "implement"), spec };
}

const start = (env, deps) => {
  if (deps.worktrees.length === 0) deps.worktrees.push(env.wt);
  return startCli(env, deps);
};
const startCli = (env, deps) =>
  main(
    [
      "start",
      "--spec-file",
      env.specFile,
      "--run-root",
      env.runRoot,
      "--repo-root",
      env.dir,
      "--state-file",
      env.stateFile,
    ],
    deps,
  );

describe("start", () => {
  it("reserves, writes the run dir, locks the worktree, spawns, attaches and hands over the slot", async () => {
    const env = await setup();
    const deps = fakeDeps();
    const out = await start(env, deps);
    assert.equal(out.started, true, JSON.stringify(out));
    assert.equal(out.pid, 4242);
    assert.match(out.runId, /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    assert.equal(out.runDir, join(env.runRoot, `7-${out.runId}`));
    assert.equal(fs.statSync(out.runDir).mode & 0o777, 0o700);
    assert.equal(
      fs.readFileSync(join(out.runDir, "input.md"), "utf8"),
      "the prompt\n\n## Context bundle\n",
    );
    const meta = JSON.parse(fs.readFileSync(join(out.runDir, "meta.json"), "utf8"));
    assert.equal(meta.formatVersion, FORMAT_VERSION);
    assert.deepEqual(
      meta.argv,
      buildImplementArgv({ effort: "ultracode", mode: "fresh", sessionId: SID }),
    );
    assert.deepEqual(meta.ctx, { itemId: "item-7", priorPr: "null" });
    assert.equal(Date.parse(meta.hardKillAt) - Date.parse(meta.deadlineAt), 300_000);
    assert.deepEqual(deps.calls.slice(0, 3), [
      "git worktree list --porcelain",
      `git worktree lock --reason implement run ${out.runId} ${env.wt}`,
      `spawn _supervise --run-dir ${out.runDir}`,
    ]);
    assert.equal(deps.calls[3], "spawn-env PATH=/usr/bin:/bin", "the tick's env, unchanged");
    const s = await loadFactoryState(env.stateFile);
    assert.equal(s.implement.runs["7"].pid, 4242);
    assert.equal(s.implement.runs["7"].runDir, out.runDir);
    assert.deepEqual([s.slots[1].issueNumber, s.slots[1].pid], ["7", 4242]);
  });

  for (const [name, opts, reason] of [
    ["a second run of the card", { runs: { 7: { runId: "old", slot: 1, pid: 5 } } }, "running"],
    ["over max-running", { runs: { 8: { runId: "old", slot: 0, pid: 5 } } }, "max-running"],
    ["a slot that isn't the card's", { slotIssue: "8" }, "slot-not-held"],
    ["a paused factory", { paused: true }, "factory-paused"],
  ]) {
    it(`refuses ${name}, before any side effect`, async () => {
      const env = await setup(opts);
      const deps = fakeDeps();
      const out = await start(env, deps);
      assert.deepEqual([out.started, out.reason], [false, reason]);
      assert.deepEqual(deps.calls, []);
      assert.equal(fs.existsSync(env.runRoot), false);
    });
  }

  it("a supervisor that won't spawn: the reservation goes, the worktree is unlocked, nothing else changes", async () => {
    const env = await setup();
    const deps = fakeDeps({ spawnOk: false });
    const out = await start(env, deps);
    assert.deepEqual([out.started, out.reason], [false, "start-failed"]);
    assert.match(out.error, /supervisor failed to start: ENOENT/);
    const s = await loadFactoryState(env.stateFile);
    assert.deepEqual(s.implement.runs, {});
    assert.deepEqual([s.slots[1].issueNumber, s.slots[1].pid], ["7", 99], "the slot is untouched");
    assert.equal(s.issues["7"], undefined, "no attempt is spent");
    // Unlocked, and the unlock confirmed by listing the worktrees again.
    assert.deepEqual(deps.calls.slice(-2), [
      `git worktree unlock ${env.wt}`,
      "git worktree list --porcelain",
    ]);
  });

  it("refuses a worktree that is already locked (owner unknown), before anything else", async () => {
    const env = await setup();
    const deps = fakeDeps({ lockedWorktrees: [] });
    deps.worktrees.push(env.wt);
    const locked = fakeDeps({ lockedWorktrees: [env.wt] });
    locked.worktrees.push(env.wt);
    const out = await start(env, locked);
    assert.deepEqual([out.started, out.reason], [false, "worktree-locked"]);
    assert.deepEqual(locked.calls, ["git worktree list --porcelain"], "no unlock, no spawn");
    assert.deepEqual((await loadFactoryState(env.stateFile)).implement.runs, {});
    void deps;
  });

  it("refuses a worktree another ledger run holds", async () => {
    const env = await setup();
    const st = JSON.parse(fs.readFileSync(env.stateFile, "utf8"));
    st.implement.runs["8"] = { runId: "other", slot: 0, pid: 5, worktree: env.wt };
    fs.writeFileSync(env.stateFile, JSON.stringify(st));
    const deps = fakeDeps();
    const spec = JSON.parse(fs.readFileSync(env.specFile, "utf8"));
    fs.writeFileSync(env.specFile, JSON.stringify({ ...spec, maxRunning: "2" }));
    const out = await start(env, deps);
    assert.deepEqual([out.started, out.reason], [false, "worktree-held"]);
    assert.deepEqual(deps.calls, []);
  });

  // The attach write fails after the supervisor has started (a corrupt state
  // file); the rollback must wait for the supervisor before letting go.
  function attachFails(env, { survives }) {
    const deps = fakeDeps();
    let runDir = null;
    let restored = false;
    deps.spawnDetached = async (cmd, args) => {
      runDir = args.at(-1);
      deps.calls.push("spawn");
      fs.writeFileSync(env.stateFile + ".good", fs.readFileSync(env.stateFile));
      fs.writeFileSync(env.stateFile, "{ not json");
      return { ok: true, pid: 4242 };
    };
    deps.kill = (pid, sig) => {
      deps.calls.push(`kill ${pid} ${sig}`);
      if (!restored) {
        fs.copyFileSync(env.stateFile + ".good", env.stateFile);
        restored = true;
      }
      return true;
    };
    deps.table = () => {
      const sup = `4242 1 4242 S node implement-lane.mjs _supervise --run-dir ${runDir}`;
      if (!runDir) return [];
      if (survives) return parseProcessTable(sup);
      return deps.calls.some((c) => c.startsWith("kill")) ? [] : parseProcessTable(sup);
    };
    return deps;
  }

  it("a rollback after the supervisor started waits for it, then unlocks and drops the reservation", async () => {
    const env = await setup();
    const deps = attachFails(env, { survives: false });
    const out = await start(env, deps);
    assert.deepEqual([out.started, out.reason, out.stillAlive], [false, "start-failed", undefined]);
    const killAt = deps.calls.indexOf("kill -4242 SIGTERM");
    const unlockAt = deps.calls.lastIndexOf(`git worktree unlock ${env.wt}`);
    assert.ok(killAt !== -1 && unlockAt > killAt, deps.calls.join("\n"));
    assert.deepEqual((await loadFactoryState(env.stateFile)).implement.runs, {});
  });

  it("a supervisor that won't die keeps the reservation and the lock", async () => {
    const env = await setup();
    const deps = attachFails(env, { survives: true });
    const fs0 = JSON.parse(fs.readFileSync(env.specFile, "utf8"));
    fs.writeFileSync(env.specFile, JSON.stringify({ ...fs0, termGraceSec: "1" }));
    const out = await start(env, deps);
    assert.deepEqual([out.started, out.stillAlive], [false, true]);
    assert.ok(deps.calls.includes("kill -4242 SIGKILL"));
    assert.ok(!deps.calls.includes(`git worktree unlock ${env.wt}`), "the lock stays");
    // The run stays in the ledger, pending its rollback, with the pid.
    const run = (await loadFactoryState(env.stateFile)).implement.runs["7"];
    assert.deepEqual([run.pid, run.rollbackPending], [4242, true]);
  });

  it("abandoned (finished during the spawn) and still alive: put back as rollback-pending", async () => {
    const env = await setup();
    const deps = fakeDeps();
    let runDir = null;
    deps.spawnDetached = async (cmd, args) => {
      runDir = args.at(-1);
      // An operator's kill --finish lands while the supervisor spawns.
      const st = JSON.parse(fs.readFileSync(env.stateFile, "utf8"));
      delete st.implement.runs["7"];
      fs.writeFileSync(env.stateFile, JSON.stringify(st));
      return { ok: true, pid: 4242 };
    };
    deps.table = () =>
      runDir
        ? parseProcessTable(`4242 1 4242 S node implement-lane.mjs _supervise --run-dir ${runDir}`)
        : [];
    const spec = JSON.parse(fs.readFileSync(env.specFile, "utf8"));
    fs.writeFileSync(env.specFile, JSON.stringify({ ...spec, termGraceSec: "1" }));
    const out = await start(env, deps);
    assert.deepEqual([out.started, out.reason, out.stillAlive], [false, "abandoned", true]);
    const run = (await loadFactoryState(env.stateFile)).implement.runs["7"];
    assert.deepEqual(
      [run.pid, run.rollbackPending, run.worktree, run.runDir],
      [4242, true, env.wt, runDir],
    );
    assert.ok(!deps.calls.includes(`git worktree unlock ${env.wt}`), "the lock stays");
    // While it is there, no new run starts for the card.
    const again = await start(env, fakeDeps());
    assert.deepEqual([again.started, again.reason], [false, "running"]);
    // Status names it, held; once its supervisor is gone the collector drops it.
    const st = await main(["status", "--state-file", env.stateFile], fakeDeps({ rows: [] }));
    assert.deepEqual(
      [st.runs[0].state, st.runs[0].rollbackPending, st.issues],
      ["rollback", true, ["7"]],
    );
    const fin = await main(
      [
        "finish",
        "--issue",
        "7",
        "--run-id",
        run.runId,
        "--outcome",
        "rolled-back",
        "--pid",
        "4242",
      ].concat(["--repo-root", "/repo", "--state-file", env.stateFile]),
      fakeDeps({ rows: [] }),
    );
    assert.equal(fin.ok, true);
  });

  it("a lock that fails refuses the start, and drops the reservation", async () => {
    const env = await setup();
    const out = await start(env, fakeDeps({ gitCode: 128 }));
    assert.deepEqual([out.started, out.reason], [false, "lock-failed"]);
    assert.match(out.error, /fatal: nope/);
    assert.deepEqual((await loadFactoryState(env.stateFile)).implement.runs, {});
  });

  it("refuses a missing worktree or empty input, and a bad spec", async () => {
    const env = await setup();
    fs.rmSync(env.wt, { recursive: true });
    assert.equal((await start(env, fakeDeps())).reason, "worktree-missing");
    const env2 = await setup();
    fs.writeFileSync(join(env2.dir, "input"), "");
    assert.equal((await start(env2, fakeDeps())).reason, "input-empty");
    const env3 = await setup();
    fs.writeFileSync(env3.specFile, JSON.stringify({ ...env3.spec, effort: "x" }));
    await assert.rejects(start(env3, fakeDeps()), /invalid effort/);
    fs.writeFileSync(env3.specFile, JSON.stringify({ ...env3.spec, maxRunning: "3" }));
    await assert.rejects(start(env3, fakeDeps()), /maxRunning above 2/);
    fs.writeFileSync(env3.specFile, JSON.stringify({ ...env3.spec, model: "--chrome" }));
    await assert.rejects(start(env3, fakeDeps()), /invalid model/);
  });

  it("carries the spec's model into meta.argv and meta.model (ADR-0099)", async () => {
    const env = await setup();
    fs.writeFileSync(
      env.specFile,
      JSON.stringify({ ...env.spec, effort: "xhigh", model: "opus[1m]" }),
    );
    const out = await start(env, fakeDeps());
    assert.equal(out.started, true, JSON.stringify(out));
    const meta = JSON.parse(fs.readFileSync(join(out.runDir, "meta.json"), "utf8"));
    assert.equal(meta.effort, "xhigh");
    assert.equal(meta.model, "opus[1m]");
    assert.deepEqual(
      meta.argv,
      buildImplementArgv({ effort: "xhigh", model: "opus[1m]", mode: "fresh", sessionId: SID }),
    );
    assert.deepEqual(meta.argv.slice(-4), ["--model", "opus[1m]", "--session-id", SID]);
  });
});

describe("precheck", () => {
  it("max-running, then memory pressure, else ok", async () => {
    const env = await setup({ runs: { 8: { runId: "a", slot: 0, pid: 5 } } });
    const pre = (max, deps) =>
      main(["precheck", "--max-running", String(max), "--state-file", env.stateFile], deps);
    assert.equal((await pre(1, fakeDeps())).reason, "max-running");
    assert.equal((await pre(2, fakeDeps({ pressure: 2 }))).reason, "memory");
    assert.equal(
      (await pre(2, fakeDeps({ pressure: null }))).ok,
      true,
      "unreadable pressure fails open",
    );
    await assert.rejects(pre(3, fakeDeps()), /above 2/);
  });
});

// A v1 run dir, as start writes it, with an exit.json as the supervisor does.
function v1RunDir(
  root,
  { runId = "20261117T100000Z-abc123", exit = null, metaVersion = 1, exitVersion = 1 } = {},
) {
  const runDir = join(root, `7-${runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({ formatVersion: metaVersion, runId, ctx: { itemId: "item-7" } }),
  );
  if (exit) {
    fs.writeFileSync(
      join(runDir, "exit.json"),
      JSON.stringify({ formatVersion: exitVersion, cleanup: "clean", ...exit }),
    );
  }
  return runDir;
}

describe("status", () => {
  const RUN_ID = "20261117T100000Z-abc123";
  const run = (runDir, over = {}) => ({
    runId: RUN_ID,
    slot: 1,
    pid: 100,
    sessionId: SID,
    mode: "fresh",
    startedAt: iso(NOW - 600_000),
    deadlineAt: iso(NOW + 600_000),
    hardKillAt: iso(NOW + 900_000),
    runDir,
    worktree: "/wt",
    ...over,
  });
  const sup = `100 1 100 Ss node implement-lane.mjs _supervise --run-dir /x/7-${RUN_ID}`;
  const status = (env, deps) => main(["status", "--state-file", env.stateFile], deps);

  it("an empty ledger answers without reading the process table", async () => {
    const env = await setup();
    const deps = fakeDeps();
    deps.table = () => {
      throw new Error("ps must not run");
    };
    assert.deepEqual(await status(env, deps), { ok: true, runs: [], issues: [], live: [] });
  });

  it("a running v1 run is live and held", async () => {
    const root = tempDir();
    const env = await setup({ runs: { 7: run(v1RunDir(root)) } });
    const out = await status(env, fakeDeps({ rows: parseProcessTable(sup) }));
    assert.equal(out.runs[0].state, "running");
    assert.deepEqual([out.live, out.issues], [["7"], ["7"]]);
    assert.equal(out.runs[0].collect, undefined);
  });

  it("a done v1 run carries what collection needs", async () => {
    const root = tempDir();
    const endedAt = "2026-11-17T09:59:30.123Z";
    const env = await setup({
      runs: { 7: run(v1RunDir(root, { exit: { exitCode: 0, endedAt, terminated: false } })) },
    });
    const out = await status(env, fakeDeps({ rows: [] }));
    const r = out.runs[0];
    assert.deepEqual([r.state, r.live, out.issues], ["done", false, ["7"]]);
    assert.deepEqual(r.collect, {
      exitCode: 0,
      interrupted: false,
      why: "claude exited",
      endedAt: "2026-11-17T09:59:30Z",
      endedEpoch: Math.floor(Date.parse(endedAt) / 1000),
    });
  });

  it("judges the deadline at the run's end, not at the collecting tick", async () => {
    // Stopped at minute 10, collected after the deadline: interrupted, not 124.
    const root = tempDir();
    const env = await setup({
      runs: {
        7: run(
          v1RunDir(root, {
            exit: { exitCode: 143, terminated: true, endedAt: iso(NOW - 3600_000) },
          }),
          { deadlineAt: iso(NOW - 600_000), startedAt: iso(NOW - 4200_000) },
        ),
      },
    });
    const out = await status(env, fakeDeps({ rows: [] }));
    assert.equal(out.runs[0].pastDeadline, true, "the tick is past it");
    assert.equal(out.runs[0].collect.interrupted, true, "the run wasn't");
  });

  it("places a run that died without exit.json by its last heartbeat", async () => {
    const root = tempDir();
    const before = v1RunDir(root);
    const hb = join(before, "heartbeat");
    fs.writeFileSync(hb, "x");
    const deadline = NOW - 600_000;
    fs.utimesSync(hb, new Date(deadline - 1800_000), new Date(deadline - 1800_000));
    const env = await setup({ runs: { 7: run(before, { deadlineAt: iso(deadline) }) } });
    // A reboot since then: everything of it is certainly gone.
    const rebooted = () => {
      const d = fakeDeps({ rows: [] });
      d.bootTimeMs = () => NOW - 1000;
      return d;
    };
    const lost = (await status(env, rebooted())).runs[0];
    assert.deepEqual([lost.state, lost.collect.interrupted], ["lost", true]);
    fs.utimesSync(hb, new Date(deadline + 5000), new Date(deadline + 5000));
    const late = (await status(env, rebooted())).runs[0];
    assert.equal(late.collect.exitCode, 124, "still beating at the deadline: killed at the cap");
    // No reboot (or boot time unknown): its supervisor died without cleaning
    // up, so the run isn't collectable until a person has checked.
    const held = (await status(env, fakeDeps({ rows: [] }))).runs[0];
    assert.deepEqual([held.state, held.live, held.collect], ["unverified", true, undefined]);
  });

  it("an exit.json whose cleanup wasn't clean, with no leftover.json, is unverified", async () => {
    const root = tempDir();
    const runDir = v1RunDir(root, { exit: { exitCode: 0, cleanup: "unverified" } });
    const env = await setup({ runs: { 7: run(runDir) } });
    const st = (await status(env, fakeDeps({ rows: [] }))).runs[0];
    assert.equal(st.state, "unverified");
  });

  it("clear: refused without --confirm 1 or while alive; then lifts unverified", async () => {
    const root = tempDir();
    const runDir = v1RunDir(root, { exit: { exitCode: 0, cleanup: "unverified" } });
    const env = await setup({ runs: { 7: run(runDir) } });
    const clear = (rows, extra = []) =>
      main(["clear", "--issue", "7", ...extra, "--state-file", env.stateFile], fakeDeps({ rows }));
    assert.equal((await clear([])).reason, "confirm-required");
    assert.equal((await clear(parseProcessTable(sup), ["--confirm", "1"])).reason, "still-alive");
    assert.equal((await clear([], ["--confirm", "1", "--note", "checked ps"])).ok, true);
    const st = (await status(env, fakeDeps({ rows: [] }))).runs[0];
    assert.equal(st.state, "done");
  });

  it("formatVersion 2 run files read as unreadable", async () => {
    const root = tempDir();
    const env = await setup({ runs: { 7: run(v1RunDir(root, { metaVersion: 2 })) } });
    const out = await status(env, fakeDeps({ rows: [] }));
    assert.equal(out.runs[0].state, "unreadable");
    assert.match(out.runs[0].problem, /formatVersion 2/);
    const root2 = tempDir();
    const env2 = await setup({
      runs: { 7: run(v1RunDir(root2, { exit: { exitCode: 0 }, exitVersion: 2 })) },
    });
    assert.equal((await status(env2, fakeDeps({ rows: [] }))).runs[0].state, "unreadable");
  });

  it("fails when ps does, rather than guess", async () => {
    const root = tempDir();
    const env = await setup({ runs: { 7: run(v1RunDir(root)) } });
    const deps = fakeDeps();
    deps.table = () => null;
    await assert.rejects(status(env, deps), /ps failed/);
  });

  it("--issue narrows it to one card", async () => {
    const root = tempDir();
    const env = await setup({
      runs: { 7: run(v1RunDir(root)), 8: { ...run(null), runId: "x", pid: null } },
    });
    const out = await main(
      ["status", "--issue", "8", "--state-file", env.stateFile],
      fakeDeps({ rows: [] }),
    );
    assert.deepEqual(out.issues, ["8"]);
  });
});

describe("processTable", () => {
  const ok = { status: 0, stdout: "1 0 1 S launchd\n" };
  it("reads a ps killed by a signal again (a stop signalled the caller's group)", () => {
    const answers = [{ status: null, signal: "SIGTERM", stdout: "" }, ok];
    const t = processTable({ run: () => answers.shift() });
    assert.equal(t[0].command, "launchd");
  });
  it("any other failure, or three signalled reads, is null", () => {
    assert.equal(processTable({ run: () => ({ status: 1, stdout: "" }) }), null);
    assert.equal(processTable({ run: () => ({ error: new Error("ENOENT") }) }), null);
    assert.equal(processTable({ run: () => ({ status: null, signal: "SIGTERM" }) }), null);
  });
});

describe("trackRun: a cancellation keeps the groups it found", () => {
  const RUN = { runId: "20261117T100000Z-abc123", pid: 100, sessionId: SID };
  const T1 = "Tue Nov 17 10:00:00 2026";
  const T2 = "Tue Nov 17 10:30:00 2026";
  const sup = `100 1 100 ${T1} Ss node implement-lane.mjs _supervise --run-dir /x/7-${RUN.runId}`;
  const ps = (lines) => parseProcessTable(lines.join("\n"));

  it("keeps a descendant group alive after its ancestors exit, until it is gone", () => {
    const start = ps([
      sup,
      `101 100 100 ${T1} S node run-claude.mjs`,
      `102 101 102 ${T1} S claude -p x --session-id ${SID}`,
      `103 102 102 ${T1} S bash -c pnpm test`,
      `104 103 104 ${T1} S node vitest`,
    ]);
    const t = trackRun(RUN, start);
    assert.deepEqual(observeRun(t, start).sort(), [100, 102, 104]);
    // The supervisor and claude are gone; vitest (its own group, now a child
    // of launchd) ignored SIGTERM. A fresh look alone would call this "gone".
    const later = ps([`104 1 104 ${T1} S node vitest`]);
    assert.deepEqual(runGroups(RUN, later), [], "nothing ties it to the run any more");
    assert.deepEqual(observeRun(t, later), [104]);
    assert.deepEqual(observeRun(t, []), []);
  });

  it("never takes back a group once it was seen empty, nor one whose id was reused", () => {
    const t = trackRun(RUN, ps([sup, `104 100 104 ${T1} S node vitest`]));
    assert.deepEqual(observeRun(t, ps([`104 1 104 ${T1} S node vitest`])), [104]);
    // 104 exits; later a new, unrelated process gets pid 104 and leads a group.
    assert.deepEqual(observeRun(t, []), []);
    assert.deepEqual(observeRun(t, ps([`104 1 104 ${T2} S unrelated`])), []);
    // A reuse seen without the empty snapshot in between: told by start time.
    const t2 = trackRun(RUN, ps([sup, `104 100 104 ${T1} S node vitest`]));
    assert.deepEqual(observeRun(t2, ps([`104 1 104 ${T2} S unrelated`])), []);
  });

  it("a reused group id admits neither its new members nor their children", () => {
    const t = trackRun(RUN, ps([sup, `104 100 104 ${T1} S node vitest`]));
    assert.deepEqual([...t.groups].sort(), [100, 104]);
    // 104 and its group are gone; a replacement group got id 104 in the same
    // poll: its leader (new start time), a member, and that member's child in
    // a group of its own.
    const next = ps([
      `104 1 104 ${T2} S replacement-leader`,
      `105 104 104 ${T2} S replacement-member`,
      `106 105 106 ${T2} S replacement-child`,
    ]);
    assert.deepEqual(observeRun(t, next), []);
    assert.ok(!t.groups.has(104) && !t.groups.has(106));
    assert.ok(!t.known.has(105) && !t.known.has(106));
    // Nor later.
    assert.deepEqual(observeRun(t, next), []);
  });

  it("a leader that reappears in a group first seen without one is a reuse too", () => {
    // Group 104 first seen with its leader already gone, a known member left.
    const t = trackRun(RUN, ps([sup, `105 100 104 ${T1} S node vitest-worker`]));
    assert.ok(t.groups.has(104));
    assert.deepEqual(
      observeRun(t, ps([`104 1 104 ${T2} S new`, `107 104 104 ${T2} S new-member`])),
      [],
    );
  });

  it("a known worker that moves to a new group takes that group with it", () => {
    const t = trackRun(
      RUN,
      ps([
        sup,
        `102 100 102 ${T1} S claude --session-id ${SID}`,
        `120 102 102 ${T1} S node worker`,
      ]),
    );
    assert.ok(t.known.has(120));
    // claude has exited; the worker called setsid: its own group, launchd's child.
    const moved = ps([`120 1 120 ${T1} S node worker`]);
    assert.deepEqual(observeRun(t, moved), [120]);
    assert.deepEqual(observeRun(t, moved), [120], "and keeps it");
  });

  it("a known process never drags in our own group, nor a rejected id", () => {
    const self = `500 1 500 ${T1} S bash factory-agent.sh`;
    const t = trackRun(
      RUN,
      ps([sup, self, `102 100 102 ${T1} S claude --session-id ${SID}`, `120 102 102 ${T1} S w`]),
      { selfPids: [500] },
    );
    assert.deepEqual(observeRun(t, ps([self, `120 1 500 ${T1} S w`])), []);
  });

  it("children of a group that still matches stay discoverable, in groups of their own", () => {
    const t = trackRun(RUN, ps([sup, `102 100 102 ${T1} S claude --session-id ${SID}`]));
    // The supervisor is gone; claude's group still matches (same leader).
    const next = ps([
      `102 1 102 ${T1} S claude --session-id ${SID}`,
      `110 102 110 ${T2} S node worker --setsid`,
      `111 110 110 ${T2} S node worker-thread`,
      `112 111 112 ${T2} S node grandchild --setsid`,
    ]);
    assert.deepEqual(
      observeRun(t, next).sort((a, b) => a - b),
      [102, 110, 112],
    );
  });

  it("follows children the run starts meanwhile, into groups of their own", () => {
    const t = trackRun(RUN, ps([sup, `102 100 102 ${T1} S claude --session-id ${SID}`]));
    const next = ps([
      `102 100 102 ${T1} S claude --session-id ${SID}`,
      `110 102 110 ${T2} S node daemon --setsid`,
    ]);
    assert.deepEqual(observeRun(t, next).sort(), [102, 110]);
  });
});

describe("kill and finish", () => {
  const RUN_ID = "20261117T100000Z-abc123";
  const sup = `100 1 100 Ss node implement-lane.mjs _supervise --run-dir /x/7-${RUN_ID}`;
  const claude = `102 101 102 S claude --session-id ${SID}`;
  const ledger = (runDir) => ({
    7: { runId: RUN_ID, slot: 1, pid: 100, sessionId: SID, runDir, worktree: "/wt" },
  });
  const kill = (env, deps, extra = []) =>
    main(
      ["kill", "--issue", "7", "--repo-root", "/repo", "--state-file", env.stateFile, ...extra],
      deps,
    );

  it("no run: nothing to do", async () => {
    const env = await setup();
    const deps = fakeDeps();
    assert.deepEqual(await kill(env, deps), { ok: true, issue: "7", state: "none" });
    assert.deepEqual(deps.calls, []);
  });

  it("SIGTERMs every group of the run, and with --finish 1 unlocks, finishes and writes collected.json", async () => {
    const root = tempDir();
    const runDir = v1RunDir(root);
    const env = await setup({ runs: ledger(runDir) });
    const live = parseProcessTable([sup, `101 100 100 S node run-claude.mjs`, claude].join("\n"));
    const deps = fakeDeps({ rows: [live, live, []] });
    const out = await kill(env, deps, ["--finish", "1", "--outcome", "stopped"]);
    assert.deepEqual(
      [out.ok, out.state, out.signalled, out.killed, out.finished],
      [true, "gone", true, false, true],
    );
    assert.deepEqual(deps.calls.filter((c) => c.startsWith("kill")).sort(), [
      "kill -100 SIGTERM",
      "kill -102 SIGTERM",
    ]);
    assert.ok(
      before(deps.calls, "kill -100 SIGTERM", "git worktree unlock /wt"),
      "unlocked only once the run is gone",
    );
    assert.deepEqual((await loadFactoryState(env.stateFile)).implement.runs, {});
    const collected = JSON.parse(fs.readFileSync(join(runDir, "collected.json"), "utf8"));
    assert.deepEqual([collected.runId, collected.outcome], [RUN_ID, "stopped"]);
  });

  it("escalates to SIGKILL, and keeps the run in the ledger while anything is alive", async () => {
    const root = tempDir();
    const env = await setup({ runs: ledger(v1RunDir(root)) });
    // claude orphaned (re-parented to launchd): found by its session id.
    const orphan = `102 1 102 S claude --session-id ${SID}`;
    const live = parseProcessTable([sup, orphan].join("\n"));
    const deps = fakeDeps({ rows: [live] });
    const out = await kill(env, deps, ["--finish", "1", "--wait-ms", "1000"]);
    assert.deepEqual([out.ok, out.state, out.killed], [false, "alive", true]);
    assert.ok(deps.calls.includes("kill -100 SIGKILL") && deps.calls.includes("kill -102 SIGKILL"));
    assert.equal((await loadFactoryState(env.stateFile)).implement.runs["7"].runId, RUN_ID);
    assert.ok(!deps.calls.some((c) => c.startsWith("git")), "a live run's worktree stays locked");
  });

  it("without --finish, stops only (the collector then hands the run to the handler)", async () => {
    const root = tempDir();
    const env = await setup({ runs: ledger(v1RunDir(root)) });
    const live = parseProcessTable(sup);
    const out = await kill(env, fakeDeps({ rows: [live, []] }));
    assert.deepEqual([out.ok, out.state, out.finished], [true, "gone", undefined]);
    assert.equal((await loadFactoryState(env.stateFile)).implement.runs["7"].runId, RUN_ID);
  });

  it("a reused pid is never signalled", async () => {
    const root = tempDir();
    const env = await setup({ runs: ledger(v1RunDir(root)) });
    const deps = fakeDeps({ rows: parseProcessTable("100 1 100 Ss /usr/bin/some-other-daemon") });
    const out = await kill(env, deps, ["--finish", "1"]);
    assert.equal(out.state, "gone");
    assert.ok(!deps.calls.some((c) => c.startsWith("kill")));
  });

  it("SIGKILLs a descendant group that outlived its ancestors, and only then finishes", async () => {
    const root = tempDir();
    const env = await setup({ runs: ledger(v1RunDir(root)) });
    const start = parseProcessTable(
      [sup, `101 100 100 S node run-claude.mjs`, claude, `104 102 104 S node vitest`].join("\n"),
    );
    const orphan = parseProcessTable("104 1 104 S node vitest");
    const deps = fakeDeps({ rows: [start, start, orphan, orphan, orphan, orphan, []] });
    const out = await kill(env, deps, ["--finish", "1", "--wait-ms", "500"]);
    assert.deepEqual([out.ok, out.state, out.killed, out.finished], [true, "gone", true, true]);
    assert.ok(deps.calls.includes("kill -104 SIGTERM"));
    assert.ok(deps.calls.includes("kill -104 SIGKILL"), deps.calls.join("\n"));
    assert.ok(
      before(deps.calls, "kill -104 SIGKILL", "git worktree unlock /wt"),
      "unlocked only once the leftover group is gone",
    );
  });

  it("finish keeps the run when the unlock doesn't take, marked unlock-pending, and retries later", async () => {
    const root = tempDir();
    const env = await setup({ runs: ledger(v1RunDir(root)) });
    const args = ["finish", "--issue", "7", "--run-id", RUN_ID, "--outcome", "collected"].concat([
      "--repo-root",
      "/repo",
      "--state-file",
      env.stateFile,
    ]);
    // git still lists /wt as locked after the unlock.
    const stuck = fakeDeps({ rows: [], lockedWorktrees: ["/wt"] });
    stuck.worktrees.push("/wt");
    const out = await main(args, stuck);
    assert.deepEqual([out.ok, out.reason], [false, "unlock-failed"]);
    const run = (await loadFactoryState(env.stateFile)).implement.runs["7"];
    assert.deepEqual([run.runId, run.unlockPending], [RUN_ID, true]);
    const st = await main(["status", "--state-file", env.stateFile], fakeDeps({ rows: [] }));
    assert.equal(st.runs[0].unlockPending, true);
    // The list can't be read either: still refused.
    const blind = fakeDeps({ rows: [] });
    blind.git = async (a) => ({ code: a[1] === "list" ? 128 : 0, stdout: "", stderr: "" });
    assert.equal((await main(args, blind)).reason, "unlock-failed");
    // A later tick: the lock comes off, the run goes.
    const ok = fakeDeps({ rows: [] });
    ok.worktrees.push("/wt");
    assert.equal((await main(args, ok)).ok, true);
    assert.deepEqual((await loadFactoryState(env.stateFile)).implement.runs, {});
  });

  it("finish refuses a run attached since the stop decided (pid changed)", async () => {
    const root = tempDir();
    const env = await setup({ runs: ledger(v1RunDir(root)) });
    const deps = fakeDeps({ rows: [] });
    const out = await main(
      [
        "finish",
        "--issue",
        "7",
        "--run-id",
        RUN_ID,
        "--outcome",
        "stopped",
        "--pid",
        "none",
      ].concat(["--state-file", env.stateFile]),
      deps,
    );
    assert.deepEqual([out.ok, out.reason], [false, "pid-changed"]);
    assert.deepEqual(deps.calls, [], "no unlock");
    assert.equal((await loadFactoryState(env.stateFile)).implement.runs["7"].pid, 100);
  });

  it("kill --finish refuses when a supervisor was attached during the stop", async () => {
    // Reserved, never attached (pid null): the stop finds nothing to signal.
    // Before the finish, an attach lands (another tick's start).
    const root = tempDir();
    const runDir = v1RunDir(root);
    const env = await setup({ runs: { 7: { ...ledger(runDir)["7"], pid: null } } });
    const deps = fakeDeps({ rows: [] });
    let calls = 0;
    const table = deps.table;
    deps.table = () => {
      calls += 1;
      if (calls === 2) {
        const st = JSON.parse(fs.readFileSync(env.stateFile, "utf8"));
        st.implement.runs["7"].pid = 4242;
        fs.writeFileSync(env.stateFile, JSON.stringify(st));
      }
      return table();
    };
    const out = await kill(env, deps, ["--finish", "1"]);
    assert.deepEqual(
      [out.ok, out.state, out.finished, out.reason],
      [false, "gone", false, "pid-changed"],
    );
    assert.equal((await loadFactoryState(env.stateFile)).implement.runs["7"].pid, 4242);
    assert.ok(!deps.calls.some((c) => c.startsWith("git")));
  });

  it("finish refuses while anything of the run is alive, or when ps can't tell", async () => {
    const root = tempDir();
    const env = await setup({ runs: ledger(v1RunDir(root)) });
    const args = ["finish", "--issue", "7", "--run-id", RUN_ID, "--outcome", "collected"].concat([
      "--state-file",
      env.stateFile,
    ]);
    const alive = await main(args, fakeDeps({ rows: parseProcessTable(sup) }));
    assert.deepEqual([alive.ok, alive.reason], [false, "still-alive"]);
    const deps = fakeDeps();
    deps.table = () => null;
    assert.equal((await main(args, deps)).reason, "unverifiable");
    assert.equal((await loadFactoryState(env.stateFile)).implement.runs["7"].runId, RUN_ID);
  });

  const writeLeftover = (runDir, groups, extra = {}) =>
    fs.writeFileSync(
      join(runDir, "leftover.json"),
      JSON.stringify({
        formatVersion: 1,
        runId: RUN_ID,
        state: "alive",
        groups,
        members: [],
        ...extra,
      }),
    );
  const LEFT = "Tue Nov 17 10:00:00 2026";
  const leftRow = `904 1 904 ${LEFT} S node vitest-left-behind`;

  it("a leftover the supervisor recorded keeps the run alive in status until it is gone", async () => {
    const root = tempDir();
    const runDir = v1RunDir(root, { exit: { exitCode: 0, endedAt: iso(NOW - 120_000) } });
    writeLeftover(runDir, [{ pgid: 904, leaderPresent: true, leaderLstart: LEFT }]);
    const env = await setup({ runs: ledger(runDir) });
    const status = (rows) => main(["status", "--state-file", env.stateFile], fakeDeps({ rows }));
    const held = (await status(parseProcessTable(leftRow))).runs[0];
    assert.deepEqual([held.state, held.alive, held.live], ["draining", true, true]);
    // The same pgid reused by an unrelated group doesn't count.
    const reused = (await status(parseProcessTable(`904 1 904 Tue Nov 17 11:00:00 2026 S other`)))
      .runs[0];
    assert.equal(reused.state, "done");
    assert.equal((await status([])).runs[0].state, "done");
  });

  it("kill carries the cleanup on from leftover.json, and finish refuses while it lives", async () => {
    const root = tempDir();
    const runDir = v1RunDir(root, { exit: { exitCode: 0, endedAt: iso(NOW) } });
    writeLeftover(runDir, [{ pgid: 904, leaderPresent: true, leaderLstart: LEFT }]);
    const env = await setup({ runs: ledger(runDir) });
    const finishArgs = [
      "finish",
      "--issue",
      "7",
      "--run-id",
      RUN_ID,
      "--outcome",
      "collected",
    ].concat(["--state-file", env.stateFile]);
    const refused = await main(finishArgs, fakeDeps({ rows: parseProcessTable(leftRow) }));
    assert.deepEqual([refused.ok, refused.reason], [false, "still-alive"]);
    const live = parseProcessTable(leftRow);
    const deps = fakeDeps({ rows: [live, live, []] });
    const out = await kill(env, deps, ["--finish", "1"]);
    assert.deepEqual([out.ok, out.state, out.finished], [true, "gone", true]);
    assert.ok(deps.calls.includes("kill -904 SIGTERM"));
    assert.ok(before(deps.calls, "kill -904 SIGTERM", "git worktree unlock /wt"));
  });

  it("an unreadable leftover.json: status says unreadable, kill and finish refuse", async () => {
    const root = tempDir();
    const runDir = v1RunDir(root, { exit: { exitCode: 0, endedAt: iso(NOW) } });
    fs.writeFileSync(join(runDir, "leftover.json"), "{ nope");
    const env = await setup({ runs: ledger(runDir) });
    const st = await main(["status", "--state-file", env.stateFile], fakeDeps({ rows: [] }));
    assert.deepEqual(
      [st.runs[0].state, st.runs[0].problem],
      ["unreadable", "leftover.json corrupt"],
    );
    const k = await kill(env, fakeDeps({ rows: [] }), ["--finish", "1"]);
    assert.deepEqual([k.ok, k.state], [false, "unknown"]);
    const f = await main(
      [
        "finish",
        "--issue",
        "7",
        "--run-id",
        RUN_ID,
        "--outcome",
        "x",
        "--state-file",
        env.stateFile,
      ],
      fakeDeps({ rows: [] }),
    );
    assert.equal(f.reason, "leftover-unreadable");
    assert.equal((await loadFactoryState(env.stateFile)).implement.runs["7"].runId, RUN_ID);
  });

  it("finish refuses another run's id and leaves the ledger alone", async () => {
    const root = tempDir();
    const env = await setup({ runs: ledger(v1RunDir(root)) });
    const deps = fakeDeps();
    const out = await main(
      [
        "finish",
        "--issue",
        "7",
        "--run-id",
        "other",
        "--outcome",
        "collected",
        "--state-file",
        env.stateFile,
      ],
      deps,
    );
    assert.deepEqual([out.ok, out.reason], [false, "run-id-mismatch"]);
    assert.deepEqual(deps.calls, []);
    assert.equal((await loadFactoryState(env.stateFile)).implement.runs["7"].runId, RUN_ID);
  });
});

describe("housekeeping", () => {
  it("reaps old run dirs the ledger doesn't hold, and nothing else", async () => {
    const root = tempDir();
    const held = v1RunDir(root, { runId: "20261001T000000Z-aaaaaa" });
    const old = v1RunDir(root, { runId: "20261002T000000Z-bbbbbb" });
    const fresh = v1RunDir(root, { runId: "20261116T000000Z-cccccc" });
    const other = join(root, "notes");
    fs.mkdirSync(other);
    const past = new Date(NOW - 40 * 24 * 3600_000);
    for (const d of [held, old, other]) fs.utimesSync(d, past, past);
    const env = await setup({
      runs: { 7: { runId: "20261001T000000Z-aaaaaa", slot: 1, pid: 1, runDir: held } },
    });
    const out = await main(
      ["housekeeping", "--run-root", root, "--state-file", env.stateFile],
      fakeDeps(),
    );
    assert.deepEqual(out.reaped, ["7-20261002T000000Z-bbbbbb"]);
    assert.ok(fs.existsSync(held) && fs.existsSync(fresh) && fs.existsSync(other));
    assert.equal(fs.existsSync(old), false);
  });
});

describe("runSupervise: what the run left behind", () => {
  // A fake run-claude.mjs that exits at once, and a process table where the
  // run left a group of its own behind (pgid 9001, started by the supervisor).
  function supervise({ table, exitAfterMs = 700 }) {
    const runDir = tempDir();
    const runId = "20261117T100000Z-abc123";
    fs.writeFileSync(
      join(runDir, "meta.json"),
      JSON.stringify({
        formatVersion: 1,
        runId,
        sessionId: SID,
        node: "node",
        runClaude: "/x/run-claude.mjs",
        argv: [],
        worktree: runDir,
        hardKillAt: iso(Date.now() + 3600_000),
        termGraceSec: 1,
      }),
    );
    fs.writeFileSync(join(runDir, "input.md"), "x");
    const kills = [];
    const signalProcess = new EventEmitter();
    signalProcess.kill = (pid, sig) => kills.push(`${pid} ${sig}`);
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.pid = 4243;
      child.kill = () => true;
      setTimeout(() => child.emit("exit", 0, null), exitAfterMs);
      return child;
    };
    // As in production, the run id is in the run dir's name on the command line.
    const sup = `${process.pid} 1 ${process.pid} S node implement-lane.mjs _supervise --run-dir /logs/implement/7-${runId}`;
    return runSupervise(
      { runDir },
      {
        env: {},
        fs,
        spawnImpl,
        signalProcess,
        table: () => table(sup),
        leftover: { retries: 2, waitMs: 50, retryMs: 10 },
      },
    ).then((r) => ({ r, runDir, kills }));
  }
  const stuck = `9001 ${process.pid} 9001 Tue Nov 17 10:00:00 2026 S node vitest-ignores-kill`;

  it("a group that won't die is written to leftover.json, versioned, before exit.json", async () => {
    const { runDir, kills } = await supervise({
      table: (sup) => parseProcessTable([sup, stuck].join("\n")),
    });
    const left = JSON.parse(fs.readFileSync(join(runDir, "leftover.json"), "utf8"));
    assert.equal(left.formatVersion, 1);
    assert.equal(left.state, "alive");
    assert.deepEqual(left.groups, [
      { pgid: 9001, leaderPresent: true, leaderLstart: "Tue Nov 17 10:00:00 2026" },
    ]);
    assert.ok(kills.includes("-9001 SIGTERM") && kills.includes("-9001 SIGKILL"));
    assert.ok(fs.existsSync(join(runDir, "exit.json")));
  });

  it("ps failing during the cleanup is not clean: leftover.json, state unknown", async () => {
    let calls = 0;
    const { runDir } = await supervise({
      table: (sup) => {
        calls += 1;
        // Answers while the run lives (the follow), then fails for good.
        return calls <= 3 ? parseProcessTable([sup, stuck].join("\n")) : null;
      },
    });
    const left = JSON.parse(fs.readFileSync(join(runDir, "leftover.json"), "utf8"));
    assert.equal(left.state, "unknown");
    assert.deepEqual(
      left.groups.map((g) => g.pgid),
      [9001],
    );
  });

  it("every ps read fails: cleanup-unverified, and status and finish keep the run", async () => {
    const { runDir } = await supervise({ table: () => null });
    const left = JSON.parse(fs.readFileSync(join(runDir, "leftover.json"), "utf8"));
    assert.deepEqual([left.formatVersion, left.state, left.groups], [1, "cleanup-unverified", []]);
    assert.ok(fs.existsSync(join(runDir, "exit.json")));
    // The ledger's view of that run: not done, held, and never finished.
    const env = await setup({
      runs: {
        7: {
          runId: "20261117T100000Z-abc123",
          slot: 1,
          pid: 4243,
          sessionId: SID,
          runDir,
          worktree: "/wt",
          deadlineAt: iso(Date.now() + 3600_000),
        },
      },
    });
    const st = await main(["status", "--state-file", env.stateFile], fakeDeps({ rows: [] }));
    assert.deepEqual([st.runs[0].state, st.runs[0].live], ["unverified", true]);
    assert.deepEqual(st.live, ["7"]);
    const deps = fakeDeps({ rows: [] });
    const fin = await main(
      ["finish", "--issue", "7", "--run-id", "20261117T100000Z-abc123", "--outcome", "x"].concat([
        "--repo-root",
        "/repo",
        "--state-file",
        env.stateFile,
      ]),
      deps,
    );
    assert.deepEqual([fin.ok, fin.reason], [false, "cleanup-unverified"]);
    assert.ok(!deps.calls.some((c) => c.startsWith("git")), "no unlock");
    const k = await main(
      [
        "kill",
        "--issue",
        "7",
        "--finish",
        "1",
        "--repo-root",
        "/repo",
        "--state-file",
        env.stateFile,
      ],
      fakeDeps({ rows: [] }),
    );
    assert.deepEqual([k.ok, k.reason], [false, "cleanup-unverified"]);
    assert.equal((await loadFactoryState(env.stateFile)).implement.runs["7"].pid, 4243);
  });

  it("an empty snapshot, then ps failing while claude still runs: unverified, though the end read works", async () => {
    // Reads while running at ~300 ms (empty: nothing below the supervisor),
    // then ~1 s and ~2 s fail: a worker could start and leave the tree in
    // that gap. The final read, after claude ends at 2.5 s, succeeds.
    let calls = 0;
    const { runDir } = await supervise({
      exitAfterMs: 2500,
      table: (sup) => {
        calls += 1;
        return calls === 1 || calls >= 4 ? parseProcessTable(sup) : null;
      },
    });
    const left = JSON.parse(fs.readFileSync(join(runDir, "leftover.json"), "utf8"));
    assert.equal(left.state, "cleanup-unverified");
    const exit = JSON.parse(fs.readFileSync(join(runDir, "exit.json"), "utf8"));
    assert.equal(exit.cleanup, "unverified");
  });

  it("a gap closed by a later successful read while claude runs, and a good final read: clean", async () => {
    let calls = 0;
    const { runDir } = await supervise({
      exitAfterMs: 2500,
      table: (sup) => {
        calls += 1;
        return calls === 2 ? null : parseProcessTable(sup);
      },
    });
    assert.equal(fs.existsSync(join(runDir, "leftover.json")), false);
    const exit = JSON.parse(fs.readFileSync(join(runDir, "exit.json"), "utf8"));
    assert.equal(exit.cleanup, "clean");
  });

  it("the final read, after claude ended, failing: unverified", async () => {
    let calls = 0;
    const { runDir } = await supervise({
      exitAfterMs: 1500,
      table: (sup) => {
        calls += 1;
        return calls <= 2 ? parseProcessTable(sup) : null;
      },
    });
    const left = JSON.parse(fs.readFileSync(join(runDir, "leftover.json"), "utf8"));
    assert.equal(left.state, "cleanup-unverified");
  });

  it("nothing left behind: no leftover.json", async () => {
    const { runDir } = await supervise({ table: (sup) => parseProcessTable(sup) });
    assert.equal(fs.existsSync(join(runDir, "leftover.json")), false);
  });
});
