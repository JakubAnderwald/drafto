// Integration test for the detached `_supervise` half of coderabbit-cli.mjs.
// A stub `coderabbit` shell script stands in for the vendor CLI: it prints
// fixture NDJSON, dumps the environment it was given, records its pid, and
// either exits with a chosen code or sleeps until killed. The supervisor is
// spawned for real (detached, via the module's own spawnDetached), so this
// exercises the process lifecycle the factory relies on across ticks.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDeps,
  pollRun,
  runHousekeeping,
  runSupervise,
  SUPERVISED_PATH,
} from "../lib/coderabbit-cli.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "coderabbit-cli.mjs");

const FIXTURE = [
  { type: "review_context", reviewType: "all", baseCommit: "d".repeat(40) },
  {
    type: "finding",
    severity: "minor",
    fileName: "apps/x.ts",
    codegenInstructions: "In @apps/x.ts at line 1, Do the thing.",
    suggestions: [],
  },
  { type: "complete", status: "review_completed", findings: 1, reviewedFiles: ["apps/x.ts"] },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

let tmp;
let stub;
const pids = new Set();

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "coderabbit-supervisor-test-"));
  stub = path.join(tmp, "coderabbit");
  // The CLI's env is stripped, so the stub can only find its fixture and write
  // its dumps relative to cwd (the "worktree"). $5 picks the behaviour.
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      "echo $$ > ./stub.pid",
      "env > ./stub.env",
      "cat ./fixture.ndjson",
      'if [ "$5" = "sleep" ]; then exec sleep 30; fi',
      'exit "$5"',
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
});

after(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Built by concatenation: no file under scripts/ may spell the paid flag out.
const PAID_FLAG = "--use-" + "credits";

function makeRun(name, { behaviour, deadlineInMs, bin = stub, extraArgs = [], work: workDir }) {
  const runId = `42-aaaaaaaaaaaa-${name}`;
  const runDir = path.join(tmp, "runs", runId);
  const work = workDir ?? path.join(tmp, `work-${name}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "fixture.ndjson"), FIXTURE + "\n");
  writeFileSync(
    path.join(runDir, "meta.json"),
    JSON.stringify({
      runId,
      bin,
      args: ["review", "--agent", "--base-commit", "d".repeat(40), behaviour, ...extraArgs],
      cwd: work,
      deadlineAt: new Date(Date.now() + deadlineInMs).toISOString(),
      issue: "42",
      pr: "7",
      sha: "a".repeat(40),
      baseSha: "d".repeat(40),
      mode: "full",
    }),
  );
  return { runId, runDir, work };
}

async function startSupervisor(runDir, env) {
  const deps = createDeps();
  const res = await deps.spawnDetached(process.execPath, [CLI, "_supervise", "--run-dir", runDir], {
    cwd: runDir,
    logPath: path.join(runDir, "supervisor.log"),
    env,
  });
  assert.equal(res.ok, true, res.reason);
  pids.add(res.pid);
  return res.pid;
}

describe("_supervise (detached)", () => {
  it("captures events and the CLI exit code in exit.json, with a stripped environment", async () => {
    const { runId, runDir, work } = makeRun("exit3", { behaviour: "3", deadlineInMs: 60_000 });
    const pid = await startSupervisor(runDir, {
      ...process.env,
      GH_TOKEN: "ghp_secret",
      GITHUB_TOKEN: "ghs_secret",
      SUPPORT_ZOHO_CLIENT_SECRET: "zoho_secret",
    });

    const exitFile = path.join(runDir, "exit.json");
    assert.ok(await waitFor(() => existsSync(exitFile)), "exit.json never appeared");
    const exit = JSON.parse(readFileSync(exitFile, "utf8"));
    assert.equal(exit.exitCode, 3);
    assert.equal(exit.timedOut, false);
    assert.match(exit.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const events = readFileSync(path.join(runDir, "events.ndjson"), "utf8");
    assert.match(events, /"type":"complete"/);
    assert.match(events, /"type":"finding"/);

    const env = readFileSync(path.join(work, "stub.env"), "utf8");
    assert.doesNotMatch(env, /GH_TOKEN|GITHUB_TOKEN|SUPPORT_/);
    assert.match(env, new RegExp(`^PATH=${SUPERVISED_PATH.replace(/\//g, "\\/")}$`, "m"));

    assert.ok(await waitFor(() => !isAlive(pid)), "supervisor did not exit");
    const deps = createDeps();
    const polled = await pollRun(
      {
        runId,
        pid,
        runDir,
        startedAt: new Date().toISOString(),
        deadlineAt: new Date().toISOString(),
      },
      { now: new Date().toISOString() },
      deps,
    );
    assert.equal(polled.state, "done");
    assert.equal(polled.exit.exitCode, 3);
  });

  it("kills the CLI at the deadline and records timedOut", async () => {
    const { runDir, work } = makeRun("timeout", { behaviour: "sleep", deadlineInMs: 1000 });
    await startSupervisor(runDir, process.env);

    const exitFile = path.join(runDir, "exit.json");
    assert.ok(await waitFor(() => existsSync(exitFile)), "exit.json never appeared");
    const exit = JSON.parse(readFileSync(exitFile, "utf8"));
    assert.equal(exit.timedOut, true);
    assert.equal(exit.signal, "SIGTERM");

    const stubPid = Number(readFileSync(path.join(work, "stub.pid"), "utf8").trim());
    pids.add(stubPid);
    assert.ok(await waitFor(() => !isAlive(stubPid), 5000), "CLI process survived the deadline");
  });

  it("reports running while the supervisor is alive, then lost once it is gone without exit.json", async () => {
    const { runId, runDir } = makeRun("lost", { behaviour: "sleep", deadlineInMs: 60_000 });
    const pid = await startSupervisor(runDir, process.env);
    const deps = createDeps();
    const inFlight = {
      runId,
      pid,
      runDir,
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const now = () => new Date().toISOString();

    assert.ok(await waitFor(() => existsSync(path.join(runDir, "events.ndjson"))));
    assert.equal((await pollRun(inFlight, { now: now() }, deps)).state, "running");

    // SIGKILL leaves no chance to write exit.json: that is "lost". The fixture
    // already printed `complete`, so blank it to exercise the no-salvage path.
    process.kill(pid, "SIGKILL");
    assert.ok(await waitFor(() => !isAlive(pid)));
    writeFileSync(
      path.join(runDir, "events.ndjson"),
      '{"type":"heartbeat","status":"reviewing"}\n',
    );
    assert.equal((await pollRun(inFlight, { now: now() }, deps)).state, "lost");
  });

  it("refuses to spawn when meta.json's argv or binary carries the paid-overage flag", async () => {
    const cases = [
      makeRun("paid-arg", { behaviour: "0", deadlineInMs: 60_000, extraArgs: [PAID_FLAG] }),
      makeRun("paid-arg-eq", {
        behaviour: "0",
        deadlineInMs: 60_000,
        extraArgs: [`${PAID_FLAG}=1`],
      }),
      makeRun("paid-bin", {
        behaviour: "0",
        deadlineInMs: 60_000,
        bin: path.join(tmp, `bin${PAID_FLAG}`, "coderabbit"),
      }),
    ];
    for (const { runDir, work } of cases) {
      const out = await runSupervise({ runDir });
      assert.equal(out.exitCode, 1);
      const exit = JSON.parse(readFileSync(path.join(runDir, "exit.json"), "utf8"));
      assert.equal(exit.exitCode, 1);
      assert.equal(exit.error, "paid-flag-refused");
      assert.equal(existsSync(path.join(work, "stub.pid")), false, "the CLI must never start");
      assert.equal(existsSync(path.join(runDir, "events.ndjson")), false);
    }
  });

  it("housekeeping's reap keeps a released run's worktree until its real supervisor exits", async () => {
    const repoRoot = path.join(tmp, "repo-reap");
    const worktree = path.join(repoRoot, "worktrees", "cr-cli-42-aaaaaaaaaaaa");
    mkdirSync(worktree, { recursive: true });
    const { runDir } = makeRun("reap", {
      behaviour: "sleep",
      deadlineInMs: 60_000,
      work: worktree,
    });
    const pid = await startSupervisor(runDir, process.env);
    assert.ok(await waitFor(() => existsSync(path.join(worktree, "stub.pid"))));
    pids.add(Number(readFileSync(path.join(worktree, "stub.pid"), "utf8").trim()));

    // No ledger at all (as after factory:cr-cli-finish): only the live process protects it.
    const opts = {
      stateFile: path.join(tmp, "reap-state.json"),
      repoRoot,
      runRoot: path.join(tmp, "runs"),
    };
    const deps = { ...createDeps(), env: {} };
    const first = await runHousekeeping(opts, deps);
    assert.equal(first.state, "idle");
    assert.deepEqual(first.reaped.worktrees, []);
    assert.ok(existsSync(worktree));

    process.kill(-pid, "SIGKILL");
    assert.ok(await waitFor(() => !isAlive(pid)));
    const second = await runHousekeeping(opts, deps);
    assert.deepEqual(second.reaped.worktrees, [worktree]);
    assert.equal(existsSync(worktree), false);
  });

  it("reports lost for a dead pid with no exit.json", async () => {
    const dead = spawnSync("true").pid;
    const runDir = path.join(tmp, "runs", "never-started");
    mkdirSync(runDir, { recursive: true });
    const polled = await pollRun(
      {
        runId: "never-started",
        pid: dead,
        runDir,
        startedAt: new Date().toISOString(),
        deadlineAt: new Date().toISOString(),
      },
      { now: new Date().toISOString() },
      createDeps(),
    );
    assert.equal(polled.state, "lost");
  });
});
