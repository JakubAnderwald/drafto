import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Unit tests for the generic wall-clock wrapper extracted from run-claude.mjs
// (#451). Mirrors run-claude.test.mjs's fake-spawn approach: no real processes.

let lib;

beforeEach(async () => {
  lib = await import(`../lib/run-with-timeout.mjs?t=${Date.now()}-${Math.random()}`);
});

function makeFakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.killSignals = [];
  child.kill = (sig) => {
    child.killSignals.push(sig);
    child.killed = true;
    return true;
  };
  return child;
}

function makeSpawn(scenario) {
  return (cmd, args, opts) => {
    scenario.spawnCalls.push({ cmd, args, opts });
    const child = makeFakeChild();
    scenario.children.push(child);
    if (scenario.onSpawn) scenario.onSpawn(child);
    return child;
  };
}

describe("parseCliArgs (pure)", () => {
  it("parses <sec> <command> [args...] into timeoutMs + command + args", () => {
    assert.deepEqual(lib.parseCliArgs(["600", "pnpm", "install", "--offline"]), {
      timeoutMs: 600000,
      command: "pnpm",
      args: ["install", "--offline"],
    });
  });

  it("allows a command with no extra args", () => {
    assert.deepEqual(lib.parseCliArgs(["5", "true"]), {
      timeoutMs: 5000,
      command: "true",
      args: [],
    });
  });

  it("returns null on missing command / non-numeric / non-positive seconds", () => {
    assert.equal(lib.parseCliArgs(["600"]), null, "missing command");
    assert.equal(lib.parseCliArgs(["abc", "pnpm"]), null, "non-numeric seconds");
    assert.equal(lib.parseCliArgs(["0", "pnpm"]), null, "zero seconds");
    assert.equal(lib.parseCliArgs(["-5", "pnpm"]), null, "negative seconds");
    assert.equal(lib.parseCliArgs([]), null, "empty argv");
  });
});

describe("runWithTimeout (mocked spawn)", () => {
  it("propagates the child's exit code unchanged on normal exit", async () => {
    const scenario = { spawnCalls: [], children: [] };
    const promise = lib.runWithTimeout({
      command: "pnpm",
      args: ["install"],
      timeoutMs: 1000,
      spawn: makeSpawn(scenario),
    });
    setImmediate(() => scenario.children[0].emit("exit", 0, null));
    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(scenario.children[0].killed, false);
  });

  it("propagates non-zero exit codes (NOT 124) when child errors quickly", async () => {
    const scenario = { spawnCalls: [], children: [] };
    const promise = lib.runWithTimeout({
      command: "pnpm",
      timeoutMs: 1000,
      spawn: makeSpawn(scenario),
    });
    setImmediate(() => scenario.children[0].emit("exit", 1, null));
    const result = await promise;
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, false);
  });

  it("kills the child with SIGTERM and exits 124 when timeout fires", async () => {
    const scenario = { spawnCalls: [], children: [] };
    const promise = lib.runWithTimeout({
      command: "pnpm",
      timeoutMs: 200,
      killGraceMs: 2000,
      spawn: makeSpawn(scenario),
    });
    setTimeout(() => {
      const c = scenario.children[0];
      assert.ok(c.killSignals.includes("SIGTERM"), "should send SIGTERM");
      c.emit("exit", null, "SIGTERM");
    }, 500);
    const result = await promise;
    assert.equal(result.exitCode, lib.TIMEOUT_EXIT_CODE);
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
  });

  it("escalates to SIGKILL after the grace window if SIGTERM is ignored", async () => {
    const scenario = { spawnCalls: [], children: [] };
    const promise = lib.runWithTimeout({
      command: "pnpm",
      timeoutMs: 200,
      killGraceMs: 400,
      spawn: makeSpawn(scenario),
    });
    setTimeout(() => {
      const c = scenario.children[0];
      assert.ok(c.killSignals.includes("SIGTERM"));
      assert.ok(c.killSignals.includes("SIGKILL"), "should escalate to SIGKILL");
      c.emit("exit", null, "SIGKILL");
    }, 1000);
    const result = await promise;
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
  });

  it("takes the grace window from CLAUDE_CALL_KILL_GRACE_SEC when none is passed", async (t) => {
    // --implement sets it to 30 s (ADR-0084) so claude can record the killed
    // tool call before the SIGKILL. Here 1 s. Mocked timers step through the
    // cap and the grace separately, so a loaded machine can't reorder them.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const saved = process.env.CLAUDE_CALL_KILL_GRACE_SEC;
    process.env.CLAUDE_CALL_KILL_GRACE_SEC = "1";
    try {
      const scenario = { spawnCalls: [], children: [] };
      const promise = lib.runWithTimeout({
        command: "claude",
        timeoutMs: 100,
        spawn: makeSpawn(scenario),
      });
      const c = scenario.children[0];
      t.mock.timers.tick(99);
      assert.deepEqual(c.killSignals, [], "before the cap");
      t.mock.timers.tick(1);
      assert.deepEqual(c.killSignals, ["SIGTERM"], "SIGTERM at the cap");
      t.mock.timers.tick(999);
      assert.deepEqual(c.killSignals, ["SIGTERM"], "still inside the 1 s grace window");
      t.mock.timers.tick(1);
      assert.deepEqual(c.killSignals, ["SIGTERM", "SIGKILL"], "SIGKILL once the second has passed");
      c.emit("exit", null, "SIGKILL");
      const result = await promise;
      assert.equal(result.exitCode, 124);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CALL_KILL_GRACE_SEC;
      else process.env.CLAUDE_CALL_KILL_GRACE_SEC = saved;
    }
  });

  it("returns 127 when spawn itself fails (e.g. ENOENT)", async () => {
    const scenario = { spawnCalls: [], children: [] };
    const promise = lib.runWithTimeout({
      command: "does-not-exist",
      timeoutMs: 1000,
      spawn: makeSpawn(scenario),
    });
    setImmediate(() => {
      const err = new Error("spawn does-not-exist ENOENT");
      err.code = "ENOENT";
      scenario.children[0].emit("error", err);
    });
    const result = await promise;
    assert.equal(result.exitCode, lib.SPAWN_FAILURE_EXIT_CODE);
    assert.equal(result.exitCode, 127);
    assert.equal(result.timedOut, false);
  });

  it("forwards command + argv verbatim to spawn (passthrough invariant)", async () => {
    const scenario = { spawnCalls: [], children: [] };
    const promise = lib.runWithTimeout({
      command: "pnpm",
      args: ["install", "--frozen-lockfile", "--offline"],
      timeoutMs: 1000,
      spawn: makeSpawn(scenario),
    });
    setImmediate(() => scenario.children[0].emit("exit", 0, null));
    await promise;
    assert.equal(scenario.spawnCalls[0].cmd, "pnpm");
    assert.deepEqual(scenario.spawnCalls[0].args, ["install", "--frozen-lockfile", "--offline"]);
  });
});

describe("resolveKillGraceMs (pure)", () => {
  it("defaults to 5 s when CLAUDE_CALL_KILL_GRACE_SEC is unset or empty", () => {
    assert.equal(lib.resolveKillGraceMs({}), 5000);
    assert.equal(lib.resolveKillGraceMs({ CLAUDE_CALL_KILL_GRACE_SEC: "" }), 5000);
    assert.equal(lib.KILL_GRACE_MS, 5000);
  });

  it("reads whole seconds", () => {
    assert.equal(lib.resolveKillGraceMs({ CLAUDE_CALL_KILL_GRACE_SEC: "30" }), 30000);
    assert.equal(lib.resolveKillGraceMs({ CLAUDE_CALL_KILL_GRACE_SEC: " 7 " }), 7000);
  });

  it("falls back to 5 s on anything but a positive integer", () => {
    for (const raw of ["0", "-1", "1.5", "abc", "08", "30s"]) {
      assert.equal(lib.resolveKillGraceMs({ CLAUDE_CALL_KILL_GRACE_SEC: raw }), 5000, raw);
    }
  });
});

// #842 review: at the cap, claude's descendants (its Bash tasks, background
// agents) must not keep writing to the worktree the next run resumes in.
// Real processes. The leader exits as soon as it gets SIGTERM; its background
// subshell (a plain `( … ) &`, as a Bash tool call would start) ignores
// SIGTERM and writes a marker after a delay, so only SIGKILL to the group,
// sent after the leader is already gone, stops it.
describe("process-group mode (real processes)", () => {
  const LEADER =
    '( trap "" TERM; echo $$ > /dev/null; sh -c \'echo $PPID\' > "$DIR/desc.pid"; sleep 1.5; echo late > "$DIR/marker" ) & ' +
    'echo $$ > "$DIR/leader.pid"; trap "exit 0" TERM; sleep 30 & wait';

  async function withDir(fn) {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "rwt-group-"));
    const saved = process.env.DIR;
    process.env.DIR = dir;
    try {
      return await fn(dir, path);
    } finally {
      if (saved === undefined) delete process.env.DIR;
      else process.env.DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = (pgid) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const readPid = async (file) => {
    const { readFileSync } = await import("node:fs");
    for (let i = 0; i < 50; i++) {
      try {
        const n = Number(readFileSync(file, "utf8").trim());
        if (n > 0) return n;
      } catch {
        /* not yet */
      }
      await sleep(20);
    }
    throw new Error(`no pid in ${file}`);
  };

  it("by default signals the direct child only: a descendant outlives the cap", async () => {
    await withDir(async (dir, path) => {
      const { existsSync } = await import("node:fs");
      const result = await lib.runWithTimeout({
        command: "bash",
        args: ["-c", LEADER],
        timeoutMs: 300,
        killGraceMs: 300,
        label: "test",
        killGroup: false,
      });
      assert.equal(result.exitCode, 124);
      await sleep(1800);
      assert.equal(existsSync(path.join(dir, "marker")), true, "every other caller is unchanged");
    });
  });

  it("keeps a background subshell in the leader's process group", async () => {
    await withDir(async (dir, path) => {
      const { spawnSync } = await import("node:child_process");
      const run = lib.runWithTimeout({
        command: "bash",
        args: ["-c", LEADER],
        timeoutMs: 400,
        killGraceMs: 300,
        label: "test",
        killGroup: true,
      });
      const leader = await readPid(path.join(dir, "leader.pid"));
      const desc = await readPid(path.join(dir, "desc.pid"));
      const pgid = Number(
        spawnSync("ps", ["-o", "pgid=", "-p", String(desc)], { encoding: "utf8" }).stdout.trim(),
      );
      assert.equal(pgid, leader, "nested `( … ) &` stays in the group the wrapper signals");
      await run;
    });
  });

  it("on the cap, SIGKILLs the group after the grace window even though the leader already exited, and returns only once the group is gone", async () => {
    await withDir(async (dir, path) => {
      const { existsSync } = await import("node:fs");
      const started = Date.now();
      const run = lib.runWithTimeout({
        command: "bash",
        args: ["-c", LEADER],
        timeoutMs: 300,
        killGraceMs: 600,
        label: "test",
        killGroup: true,
      });
      const leader = await readPid(path.join(dir, "leader.pid"));
      const result = await run;
      const elapsed = Date.now() - started;
      assert.equal(result.exitCode, 124);
      assert.equal(result.timedOut, true);
      // The leader exits on SIGTERM at ~300 ms; the wrapper still waits for
      // the SIGKILL at ~900 ms and the group's end.
      assert.ok(elapsed >= 850, `returned after ${elapsed} ms, before the escalation`);
      assert.equal(alive(leader), false, "no member of the group is left when it returns");
      await sleep(1500);
      assert.equal(existsSync(path.join(dir, "marker")), false);
    });
  });

  it("cleans up the group of a leader killed from outside before returning", async () => {
    await withDir(async (dir, path) => {
      const { existsSync } = await import("node:fs");
      const run = lib.runWithTimeout({
        command: "bash",
        args: ["-c", LEADER],
        timeoutMs: 60_000,
        killGraceMs: 300,
        label: "test",
        killGroup: true,
      });
      const leader = await readPid(path.join(dir, "leader.pid"));
      await readPid(path.join(dir, "desc.pid"));
      process.kill(leader, "SIGKILL");
      const result = await run;
      assert.equal(result.exitCode, 137);
      assert.equal(result.timedOut, false);
      assert.equal(alive(leader), false);
      await sleep(1500);
      assert.equal(existsSync(path.join(dir, "marker")), false);
    });
  });

  it("passes a SIGTERM sent to the wrapper on to the group, with the same escalation", async () => {
    await withDir(async (dir, path) => {
      const { spawn } = await import("node:child_process");
      const { existsSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const cli = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "lib",
        "run-with-timeout.mjs",
      );
      const wrapper = spawn(process.execPath, [cli, "60", "bash", "-c", LEADER], {
        env: {
          ...process.env,
          DIR: dir,
          CLAUDE_CALL_KILL_GROUP: "1",
          CLAUDE_CALL_KILL_GRACE_SEC: "1",
        },
        stdio: "ignore",
      });
      const leader = await readPid(path.join(dir, "leader.pid"));
      await readPid(path.join(dir, "desc.pid"));
      const sent = Date.now();
      wrapper.kill("SIGTERM");
      const code = await new Promise((r) => wrapper.once("exit", (c) => r(c)));
      assert.ok(Date.now() - sent >= 900, "it waited for the grace window and the group");
      assert.equal(alive(leader), false);
      // The leader's own `exit 0` on TERM is its exit code.
      assert.equal(code, 0);
      await sleep(1500);
      assert.equal(existsSync(path.join(dir, "marker")), false);
    });
  });

  // #842 review: a leader that exits on its own (a session-limit exit, say)
  // must not leave its descendants running either.
  it("cleans up a group the leader left behind when it exits 0 on its own", async () => {
    await withDir(async (dir, path) => {
      const { existsSync } = await import("node:fs");
      const started = Date.now();
      const run = lib.runWithTimeout({
        command: "bash",
        args: [
          "-c",
          '( trap "" TERM; sleep 1.5; echo late > "$DIR/marker" ) & echo $$ > "$DIR/leader.pid"; sleep 0.3; exit 0',
        ],
        timeoutMs: 60_000,
        killGraceMs: 400,
        label: "test",
        killGroup: true,
      });
      const leader = await readPid(path.join(dir, "leader.pid"));
      const result = await run;
      assert.deepEqual(result, { exitCode: 0, timedOut: false, signal: null });
      // Leader gone at ~300 ms; the descendant ignores TERM, so the wrapper
      // waits for the SIGKILL at ~700 ms and the group's end.
      assert.ok(Date.now() - started >= 650);
      assert.equal(alive(leader), false);
      await sleep(1500);
      assert.equal(existsSync(path.join(dir, "marker")), false);
    });
  });

  it("resolves at once on a normal exit that leaves nothing behind", async () => {
    const result = await lib.runWithTimeout({
      command: "bash",
      args: ["-c", "exit 3"],
      timeoutMs: 5000,
      killGraceMs: 5000,
      label: "test",
      killGroup: true,
    });
    assert.deepEqual(result, { exitCode: 3, timedOut: false, signal: null });
  });

  it("returns anyway, and says so, when the group outlives the bounded wait", async () => {
    // A fake group that never dies: kill -0 always succeeds.
    const scenario = { spawnCalls: [], children: [] };
    const sent = [];
    const fakeProcess = {
      kill: (pid, sig) => {
        sent.push([pid, sig]);
      },
      on() {},
      off() {},
    };
    const writes = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const promise = lib.runWithTimeout({
        command: "claude",
        timeoutMs: 20,
        killGraceMs: 30,
        label: "t",
        spawn: (cmd, args, opts) => {
          const c = makeSpawn(scenario)(cmd, args, opts);
          c.pid = 4242;
          c.unref = () => {};
          return c;
        },
        killGroup: true,
        signalProcess: fakeProcess,
        groupSettleMs: 80,
        pollMs: 10,
      });
      setTimeout(() => scenario.children[0].emit("exit", null, "SIGTERM"), 40);
      const result = await promise;
      assert.equal(result.exitCode, 124);
      assert.deepEqual(scenario.spawnCalls[0].opts, { stdio: "inherit", detached: true });
      assert.ok(sent.some(([p, s]) => p === -4242 && s === "SIGTERM"));
      assert.ok(sent.some(([p, s]) => p === -4242 && s === "SIGKILL"));
      assert.ok(
        writes.some((w) => /process group 4242 survived SIGKILL; returning anyway/.test(w)),
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe("resolveKillGroup (pure)", () => {
  it("is on only for CLAUDE_CALL_KILL_GROUP=1", () => {
    assert.equal(lib.resolveKillGroup({}), false);
    assert.equal(lib.resolveKillGroup({ CLAUDE_CALL_KILL_GROUP: "1" }), true);
    assert.equal(lib.resolveKillGroup({ CLAUDE_CALL_KILL_GROUP: " 1 " }), true);
    for (const v of ["0", "", "true", "yes"]) {
      assert.equal(lib.resolveKillGroup({ CLAUDE_CALL_KILL_GROUP: v }), false, v);
    }
  });
});
