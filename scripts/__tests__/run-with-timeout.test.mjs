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

  it("takes the grace window from CLAUDE_CALL_KILL_GRACE_SEC when none is passed", async () => {
    // --implement sets it to 30 s (ADR-0084) so claude can record the killed
    // tool call before the SIGKILL. Here 1 s: SIGTERM at the cap, no SIGKILL
    // half a second later, SIGKILL once the second has passed.
    const saved = process.env.CLAUDE_CALL_KILL_GRACE_SEC;
    process.env.CLAUDE_CALL_KILL_GRACE_SEC = "1";
    try {
      const scenario = { spawnCalls: [], children: [] };
      const promise = lib.runWithTimeout({
        command: "claude",
        timeoutMs: 100,
        spawn: makeSpawn(scenario),
      });
      setTimeout(() => {
        const c = scenario.children[0];
        assert.deepEqual(c.killSignals, ["SIGTERM"], "still inside the 1 s grace window");
      }, 600);
      setTimeout(() => {
        const c = scenario.children[0];
        assert.deepEqual(c.killSignals, ["SIGTERM", "SIGKILL"]);
        c.emit("exit", null, "SIGKILL");
      }, 1500);
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
