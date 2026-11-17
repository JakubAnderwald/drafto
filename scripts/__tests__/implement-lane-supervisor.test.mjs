// Detached --implement runs (ADR-0085), end to end with real processes: the
// real `implement-lane.mjs start` spawns the real supervisor detached, which
// runs the real run-claude.mjs, which runs a fake `claude` first on PATH.
// Fake `git` and `gh` on PATH record every call, so the test can tell that the
// supervisor never ran either (start's own `git worktree lock` is the tick's).
//
// Covered: the argv and env claude gets, fresh and resumed; the wall cap (124);
// a SIGTERM still leaving exit.json; the supervisor outliving the bash that
// started it, whose EXIT trap and lock are untouched by it; and the state file
// left alone while the supervisor runs.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyFactoryState, saveFactoryState } from "../lib/factory-state.mjs";
import { buildImplementArgv } from "../lib/implement-lane.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE = resolve(HERE, "..", "lib", "implement-lane.mjs");
// A session id of its own: liveness also matches any process whose command line
// carries the run's session id, and other test files run beside this one.
const SID = randomUUID();

const dirs = [];
const supervisors = [];
const strays = [];
after(() => {
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  for (const pid of supervisors) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(process.cwd() + "/claude-call.json", JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    timeout: process.env.CLAUDE_CALL_TIMEOUT_SEC,
    grace: process.env.CLAUDE_CALL_KILL_GRACE_SEC,
    group: process.env.CLAUDE_CALL_KILL_GROUP,
    tickVar: process.env.FAKE_TICK_VAR,
  },
}));
if (process.env.FAKE_CLAUDE_MODE === "sleep") {
  // A child in claude's own process group, and a grandchild that left it
  // (setsid, like a test runner's worker) and ignores SIGTERM.
  const { spawn } = require("child_process");
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  const grand = spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
    { detached: true, stdio: "ignore" },
  );
  fs.writeFileSync(
    process.cwd() + "/claude-pids.json",
    JSON.stringify({ claude: process.pid, child: child.pid, grand: grand.pid }),
  );
  setInterval(() => {}, 1000);
} else {
  process.stdout.write("issue=7 action=implemented pr=https://github.com/x/y/pull/9\\n");
  process.stderr.write("fake claude stderr\\n");
}
`;

function setup({ mode = "fresh", timeoutSec = 60, termGraceSec = 1, claudeMode = "ok" } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), "impl-lane-sup-"));
  dirs.push(root);
  const bin = join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  for (const tool of ["git", "gh"]) {
    fs.writeFileSync(
      join(bin, tool),
      `#!/bin/bash\nprintf '%s\\n' "$*" >>"${join(root, `${tool}-calls`)}"\nexit 0\n`,
      { mode: 0o755 },
    );
  }
  const wt = join(root, "wt");
  fs.mkdirSync(wt);
  const input = join(root, "input");
  fs.writeFileSync(input, "the implementer prompt\n\n## Run-time facts\n\n```json\n{}\n```\n");
  const spec = join(root, "spec.json");
  fs.writeFileSync(
    spec,
    JSON.stringify({
      issue: "7",
      slot: 1,
      worktree: wt,
      inputFile: input,
      effort: "ultracode",
      mode,
      sessionId: SID,
      timeoutSec: String(timeoutSec),
      termGraceSec: String(termGraceSec),
      killGraceSec: "300",
      maxRunning: "1",
      ctx: { itemId: "item-7" },
    }),
  );
  const stateFile = join(root, "state.json");
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    FAKE_CLAUDE_MODE: claudeMode,
    FAKE_TICK_VAR: "from-the-tick",
  };
  return { root, wt, input, spec, stateFile, env, runRoot: join(root, "logs", "implement") };
}

async function seedState(t) {
  const s = emptyFactoryState();
  s.slots[1] = { pid: 99, issueNumber: "7", acquiredAt: new Date().toISOString() };
  await saveFactoryState(s, t.stateFile);
}

function lane(t, args) {
  const r = spawnSync(process.execPath, [LANE, ...args, "--state-file", t.stateFile], {
    encoding: "utf8",
    env: t.env,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function startRun(t) {
  const out = lane(t, [
    "start",
    "--spec-file",
    t.spec,
    "--run-root",
    t.runRoot,
    "--repo-root",
    t.root,
  ]);
  assert.equal(out.started, true, JSON.stringify(out));
  supervisors.push(out.pid);
  return out;
}

async function waitFor(fn, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const exitJson = (runDir) => join(runDir, "exit.json");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Dead for certain: signal 0 answers ESRCH (no such process). Zombies of our
// own children don't apply: none of these is this process's child.
const assertGone = async (pids) => {
  for (const [name, pid] of Object.entries(pids)) {
    await waitFor(() => !alive(pid), 15_000).catch(() => {});
    assert.throws(
      () => process.kill(pid, 0),
      (err) => err.code === "ESRCH",
      `${name} (pid ${pid}) is still running`,
    );
  }
};
const recordPids = async (wt) => {
  const file = join(wt, "claude-pids.json");
  await waitFor(() => fs.existsSync(file));
  const pids = readJson(file);
  strays.push(...Object.values(pids));
  return pids;
};

describe("implement-lane supervisor (real detached spawn, fake claude)", () => {
  it("runs claude with the synchronous call's argv and env, in the worktree, and touches no state, git or gh", async () => {
    const t = setup();
    await seedState(t);
    const out = startRun(t);
    // Everything the tick wrote is in by the time start returns (attach included).
    const stateAfterStart = fs.readFileSync(t.stateFile, "utf8");
    const mtimeAfterStart = fs.statSync(t.stateFile).mtimeMs;
    const gitAfterStart = fs.readFileSync(join(t.root, "git-calls"), "utf8");

    await waitFor(() => fs.existsSync(exitJson(out.runDir)));
    await waitFor(() => !alive(out.pid));
    const call = readJson(join(t.wt, "claude-call.json"));
    assert.deepEqual(call.argv, [
      "-p",
      fs.readFileSync(t.input, "utf8"),
      ...buildImplementArgv({ effort: "ultracode", mode: "fresh", sessionId: SID }),
    ]);
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(t.wt));
    assert.deepEqual(call.env, { timeout: "60", grace: "1", group: "1", tickVar: "from-the-tick" });

    const exit = readJson(exitJson(out.runDir));
    assert.deepEqual(
      [exit.formatVersion, exit.exitCode, exit.timedOut, exit.terminated, exit.error],
      [1, 0, false, false, null],
    );
    assert.equal(
      fs.readFileSync(join(out.runDir, "stdout.txt"), "utf8"),
      "issue=7 action=implemented pr=https://github.com/x/y/pull/9\n",
    );
    assert.match(fs.readFileSync(join(out.runDir, "stderr.txt"), "utf8"), /fake claude stderr/);

    // The supervisor wrote nothing to the state file, ran no git and no gh.
    assert.equal(fs.readFileSync(t.stateFile, "utf8"), stateAfterStart);
    assert.equal(fs.statSync(t.stateFile).mtimeMs, mtimeAfterStart);
    assert.equal(fs.readFileSync(join(t.root, "git-calls"), "utf8"), gitAfterStart);
    assert.deepEqual(gitAfterStart.trim().split("\n"), [
      `worktree unlock ${t.wt}`,
      `worktree lock --reason implement run ${out.runId} ${t.wt}`,
    ]);
    assert.equal(fs.existsSync(join(t.root, "gh-calls")), false);

    const status = lane(t, ["status"]);
    assert.deepEqual([status.runs[0].state, status.runs[0].collect.exitCode], ["done", 0]);
  });

  it("resumes with --resume <session>", async () => {
    const t = setup({ mode: "resume" });
    await seedState(t);
    const out = startRun(t);
    await waitFor(() => fs.existsSync(exitJson(out.runDir)));
    const call = readJson(join(t.wt, "claude-call.json"));
    assert.deepEqual(call.argv.slice(-2), ["--resume", SID]);
    assert.ok(!call.argv.includes("--session-id"));
  });

  it("ends at the cap with 124, with claude, its child and its setsid grandchild all gone", async () => {
    const t = setup({ timeoutSec: 3, termGraceSec: 1, claudeMode: "sleep" });
    await seedState(t);
    const out = startRun(t);
    const pids = await recordPids(t.wt);
    await waitFor(() => fs.existsSync(exitJson(out.runDir)));
    const exit = readJson(exitJson(out.runDir));
    assert.deepEqual([exit.exitCode, exit.timedOut, exit.terminated], [124, true, false]);
    await waitFor(() => !alive(out.pid));
    // Independently of status: each process is gone, the one that left
    // claude's group and ignored SIGTERM included (the supervisor stops what
    // the run left behind).
    await assertGone(pids);
    const status = lane(t, ["status"]);
    assert.equal(status.runs[0].state, "done");
    assert.equal(status.runs[0].collect.exitCode, 124);
  });

  it("a SIGTERM (kill) still leaves exit.json, and the run reads as interrupted", async () => {
    const t = setup({ claudeMode: "sleep" });
    await seedState(t);
    const out = startRun(t);
    const pids = await recordPids(t.wt);
    // Let the supervisor see the grandchild before the stop.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(lane(t, ["status"]).runs[0].state, "running");
    const killed = lane(t, ["kill", "--issue", "7", "--wait-ms", "20000", "--repo-root", t.root]);
    assert.deepEqual([killed.state, killed.signalled], ["gone", true]);
    await assertGone(pids);
    const exit = readJson(exitJson(out.runDir));
    assert.equal(exit.terminated, true);
    assert.notEqual(exit.exitCode, 0);
    const status = lane(t, ["status"]);
    assert.equal(status.runs[0].state, "done");
    assert.equal(status.runs[0].collect.interrupted, true);
    // kill without --finish leaves the run for the collector.
    assert.equal(status.issues[0], "7");
  });

  it("outlives the bash that started it, whose EXIT trap and lock file it leaves alone", async () => {
    const t = setup({ claudeMode: "sleep" });
    await seedState(t);
    const lock = join(t.root, "factory-implement.lock");
    const trapLog = join(t.root, "trap-ran");
    // factory-agent.sh's shape: a pid lock, a cleanup() EXIT trap that removes
    // it, and the start's JSON captured with $(…), which would hang on any
    // pipe the supervisor kept.
    const script = `
set -euo pipefail
echo "$$" >"${lock}"
cleanup() { rm -f "${lock}"; echo ran >>"${trapLog}"; }
trap cleanup EXIT
out=$("${process.execPath}" "${LANE}" start --spec-file "${t.spec}" --run-root "${t.runRoot}" \\
  --repo-root "${t.root}" --state-file "${t.stateFile}")
printf '%s\\n' "$out"
ps -o pgid= -p $$ | tr -d ' '
`;
    const began = Date.now();
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: t.env, timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Date.now() - began < 15_000, "bash must not wait for the supervisor");
    const [json, bashPgid] = r.stdout.trim().split("\n");
    const out = JSON.parse(json);
    supervisors.push(out.pid);
    assert.equal(out.started, true);
    assert.equal(fs.existsSync(lock), false, "cleanup() removed the lock");
    assert.equal(fs.readFileSync(trapLog, "utf8"), "ran\n", "the trap ran once, in bash only");

    const pids = await recordPids(t.wt);
    assert.ok(alive(out.pid), "the supervisor is still running after bash exited");
    const pgid = spawnSync("ps", ["-o", "pgid=", "-p", String(out.pid)], {
      encoding: "utf8",
    }).stdout.trim();
    assert.equal(pgid, String(out.pid), "it leads its own process group");
    assert.notEqual(pgid, bashPgid, "outside the tick's group, which launchd kills");
    assert.equal(lane(t, ["status"]).runs[0].state, "running");

    const killed = lane(t, ["kill", "--issue", "7", "--finish", "1", "--repo-root", t.root]);
    assert.deepEqual([killed.state, killed.finished], ["gone", true]);
    await assertGone(pids);
    assert.deepEqual(lane(t, ["status"]).runs, []);
  });
});
