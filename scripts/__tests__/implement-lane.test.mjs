// Unit tests for detached --implement runs (ADR-0085): the ledger in
// factory-state.mjs, and implement-lane.mjs's decisions (run states, what a
// collected run means, which process groups are the run's) and subcommands with
// their processes, git and spawning faked. The real detached spawn is in
// implement-lane-supervisor.test.mjs.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  runGroups,
} from "../lib/implement-lane.mjs";
import { descendants, groupRunState, parseProcessTable } from "../lib/supervisor-proc.mjs";

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
  const c = (run, files, alive, nowMs = NOW) =>
    classifyRun({
      run: { ...base, ...run },
      metaProblem: null,
      exitProblem: null,
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
    ["lost", {}, {}, false, "lost"],
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

function fakeDeps({ rows = [], pressure = 1, spawnOk = true, spawnPid = 4242, gitCode = 0 } = {}) {
  const calls = [];
  const tables = Array.isArray(rows[0]) ? [...rows] : null;
  let clock = NOW;
  return {
    calls,
    env: { PATH: "/usr/bin:/bin" },
    fs,
    nowMs: () => clock,
    table: () => (tables ? (tables.length > 1 ? tables.shift() : tables[0]) : rows),
    kill: (pid, sig) => {
      calls.push(`kill ${pid} ${sig}`);
      return true;
    },
    git: async (args) => {
      calls.push(`git ${args.join(" ")}`);
      return { code: gitCode, stdout: "", stderr: gitCode ? "fatal: nope" : "" };
    },
    spawnDetached: async (cmd, args, opts) => {
      calls.push(`spawn ${args.slice(1).join(" ")}`);
      calls.push(`spawn-env PATH=${opts.env.PATH}`);
      return spawnOk ? { ok: true, pid: spawnPid } : { ok: false, reason: "ENOENT" };
    },
    memoryPressure: async () => pressure,
    sleep: async (ms) => {
      clock += ms;
    },
    selfPids: [process.pid],
  };
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

const start = (env, deps) =>
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
      `git worktree unlock ${env.wt}`,
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
    assert.equal(deps.calls.at(-1), `git worktree unlock ${env.wt}`);
  });

  it("a failed lock is reported, and the run still starts", async () => {
    const env = await setup();
    const out = await start(env, fakeDeps({ gitCode: 128 }));
    assert.equal(out.started, true);
    assert.equal(out.locked, false);
    assert.equal(out.lockError, "fatal: nope");
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
      JSON.stringify({ formatVersion: exitVersion, ...exit }),
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
      deps.calls.indexOf("git worktree unlock /wt") > deps.calls.indexOf("kill -100 SIGTERM"),
      "unlocked only once the run is gone",
    );
    assert.deepEqual((await loadFactoryState(env.stateFile)).implement.runs, {});
    const collected = JSON.parse(fs.readFileSync(join(runDir, "collected.json"), "utf8"));
    assert.deepEqual([collected.runId, collected.outcome], [RUN_ID, "stopped"]);
  });

  it("escalates to SIGKILL, and keeps the run in the ledger while anything is alive", async () => {
    const root = tempDir();
    const env = await setup({ runs: ledger(v1RunDir(root)) });
    const live = parseProcessTable([sup, claude].join("\n"));
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
