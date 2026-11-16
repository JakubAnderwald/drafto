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

// #842 review: at the cap, claude's descendants (its Bash tasks, background
// agents) must not keep writing to the worktree the next run resumes in. Real
// processes: a child that ignores SIGTERM, with a grandchild that also ignores
// it and writes a marker after a delay, so only SIGKILL stops them.
describe("forced SIGKILL and the child's descendants (real processes)", () => {
  const SCRIPT = 'trap "" TERM; ( trap "" TERM; sleep 1.2; echo late > "$MARKER" ) & sleep 30';

  async function runCase({ killGroup }) {
    const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "rwt-group-"));
    const marker = path.join(dir, "marker");
    const saved = process.env.MARKER;
    process.env.MARKER = marker;
    try {
      const result = await lib.runWithTimeout({
        command: "bash",
        args: ["-c", SCRIPT],
        timeoutMs: 200,
        killGraceMs: 200,
        label: "test",
        killGroup,
      });
      await new Promise((r) => setTimeout(r, 1800));
      return { result, marker: existsSync(marker) };
    } finally {
      if (saved === undefined) delete process.env.MARKER;
      else process.env.MARKER = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("by default signals the direct child only: a descendant outlives the cap", async () => {
    const { result, marker } = await runCase({ killGroup: false });
    assert.equal(result.exitCode, 124);
    assert.equal(marker, true, "the default for every other caller is unchanged");
  });

  it("in process-group mode kills the whole group: the descendant never writes", async () => {
    const { result, marker } = await runCase({ killGroup: true });
    assert.equal(result.exitCode, 124);
    assert.equal(marker, false);
  });

  it("in group mode passes a SIGTERM sent to the wrapper on to the group", async () => {
    const { spawn } = await import("node:child_process");
    const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const cli = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "lib",
      "run-with-timeout.mjs",
    );
    const dir = mkdtempSync(path.join(tmpdir(), "rwt-forward-"));
    const marker = path.join(dir, "marker");
    try {
      // The grandchild doesn't ignore TERM here: forwarding is enough.
      const wrapper = spawn(
        process.execPath,
        [cli, "60", "bash", "-c", '( sleep 1.2; echo late > "$MARKER" ) & sleep 30'],
        { env: { ...process.env, MARKER: marker, CLAUDE_CALL_KILL_GROUP: "1" }, stdio: "ignore" },
      );
      await new Promise((r) => setTimeout(r, 300));
      wrapper.kill("SIGTERM");
      const code = await new Promise((r) => wrapper.once("exit", (c) => r(c)));
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(code, 143, "the child's death by SIGTERM, as a shell reports it");
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
