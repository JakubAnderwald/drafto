import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

let lib;

beforeEach(async () => {
  // Import fresh so the module-level `_spawnForTests` shim resets.
  lib = await import(`../lib/run-claude.mjs?t=${Date.now()}-${Math.random()}`);
});

// Minimal ChildProcess fake. We only need .kill() and the "exit"/"error"
// events the wrapper subscribes to.
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
    // Allow the test to drive the lifecycle by exposing the child.
    if (scenario.onSpawn) scenario.onSpawn(child);
    return child;
  };
}

describe("resolveTimeoutSec (pure)", () => {
  it("returns the default (180) when env var is missing or empty", async () => {
    assert.equal(lib.resolveTimeoutSec({}), 180);
    assert.equal(lib.resolveTimeoutSec({ CLAUDE_CALL_TIMEOUT_SEC: "" }), 180);
  });

  it("returns the parsed value when set to a positive integer", async () => {
    assert.equal(lib.resolveTimeoutSec({ CLAUDE_CALL_TIMEOUT_SEC: "60" }), 60);
    assert.equal(lib.resolveTimeoutSec({ CLAUDE_CALL_TIMEOUT_SEC: "1" }), 1);
  });

  it("falls back to default for non-numeric / non-positive values (defensive)", async () => {
    assert.equal(lib.resolveTimeoutSec({ CLAUDE_CALL_TIMEOUT_SEC: "0" }), 180);
    assert.equal(lib.resolveTimeoutSec({ CLAUDE_CALL_TIMEOUT_SEC: "-5" }), 180);
    assert.equal(lib.resolveTimeoutSec({ CLAUDE_CALL_TIMEOUT_SEC: "abc" }), 180);
  });
});

describe("runClaudeWithTimeout (mocked spawn)", () => {
  it("propagates the child's exit code unchanged on normal exit", async () => {
    const scenario = { spawnCalls: [], children: [] };
    const promise = lib.runClaudeWithTimeout({
      args: ["-p", "hello"],
      timeoutMs: 1000,
      spawn: makeSpawn(scenario),
    });
    // Drive: child exits 0 immediately.
    setImmediate(() => scenario.children[0].emit("exit", 0, null));
    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(scenario.children[0].killed, false);
    assert.deepEqual(scenario.spawnCalls[0].args, ["-p", "hello"]);
  });

  it("propagates non-zero exit codes (NOT 124) when child errors quickly", async () => {
    const scenario = { spawnCalls: [], children: [] };
    const promise = lib.runClaudeWithTimeout({
      args: [],
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
    const promise = lib.runClaudeWithTimeout({
      args: [],
      timeoutMs: 200, // small but wide enough that GC pauses on a loaded
      killGraceMs: 2000, // CI runner won't make the SIGTERM-driven exit
      spawn: makeSpawn(scenario), // race against the wall timer
    });
    // Wait for the wall timer to fire and the wrapper to issue SIGTERM,
    // then have the child report exit. setTimeout(500) is intentionally
    // ~2.5x timeoutMs so wallTimer always wins ordering.
    setTimeout(() => {
      const c = scenario.children[0];
      assert.ok(c.killSignals.includes("SIGTERM"), "should send SIGTERM");
      c.emit("exit", null, "SIGTERM");
    }, 500);
    const result = await promise;
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
  });

  it("escalates to SIGKILL after the grace window if SIGTERM is ignored", async () => {
    const scenario = { spawnCalls: [], children: [] };
    const promise = lib.runClaudeWithTimeout({
      args: [],
      timeoutMs: 200,
      killGraceMs: 400,
      spawn: makeSpawn(scenario),
    });
    // Stubborn child: ignores SIGTERM, only exits after SIGKILL fires.
    // 1000ms is well past timeoutMs (200) + killGraceMs (400) = 600ms.
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

  it("returns 127 when spawn itself fails (e.g. ENOENT — claude not on PATH)", async () => {
    const scenario = { spawnCalls: [], children: [] };
    const promise = lib.runClaudeWithTimeout({
      args: [],
      timeoutMs: 1000,
      spawn: makeSpawn(scenario),
    });
    setImmediate(() => {
      const err = new Error("spawn claude ENOENT");
      err.code = "ENOENT";
      scenario.children[0].emit("error", err);
    });
    const result = await promise;
    assert.equal(result.exitCode, 127);
    assert.equal(result.timedOut, false);
  });

  it("forwards argv verbatim to spawn (passthrough invariant)", async () => {
    const scenario = { spawnCalls: [], children: [] };
    const promise = lib.runClaudeWithTimeout({
      command: "claude",
      args: ["-p", "long input with spaces", "--dangerously-skip-permissions"],
      timeoutMs: 1000,
      spawn: makeSpawn(scenario),
    });
    setImmediate(() => scenario.children[0].emit("exit", 0, null));
    await promise;
    assert.deepEqual(scenario.spawnCalls[0].args, [
      "-p",
      "long input with spaces",
      "--dangerously-skip-permissions",
    ]);
    assert.equal(scenario.spawnCalls[0].cmd, "claude");
  });
});
