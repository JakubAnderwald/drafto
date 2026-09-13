import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Structural guardrails for the Phase B engine (--implement + --watch +
// --release). These assert the contract the runtime depends on, so a future
// refactor can't silently drop a gate or re-introduce a Phase-A-only stub.
// The --release engine has its own dedicated suite in
// factory-agent-release.test.mjs.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..");
const agentPath = resolve(SCRIPTS, "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

describe("factory-agent.sh syntax", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", agentPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("Phase / mode gates", () => {
  it("Phase A still no-ops --release and --watch", () => {
    assert.match(
      script,
      /if \[\[ "\$PHASE" == "A" && \( "\$MODE_RELEASE" -eq 1 \|\| "\$MODE_WATCH" -eq 1 \) \]\]/,
    );
  });

  it("--release is no longer the deferred stub (real engine built)", () => {
    // The Phase-A gate (asserted above) is what no-ops --release now; the
    // unconditional "deferred, exit 0" stub must be gone.
    assert.doesNotMatch(script, /--release is deferred \(staged Phase B/);
    assert.match(script, /--release \(phase=\$PHASE\): \$APPROVED_COUNT Approved item/);
  });

  it("does NOT contain a Phase B+ 'NOT YET IMPLEMENTED' guard for implement/watch", () => {
    // The old Wave-3 guards exited 0 for any non-A implement/watch. They must
    // be gone now that the engines exist.
    assert.doesNotMatch(script, /--implement is NOT YET IMPLEMENTED/);
    assert.doesNotMatch(script, /Wave 3 ships Phase A only/);
  });
});

describe("--implement engine", () => {
  it("keeps the Phase A one-time stub branch", () => {
    assert.match(script, /drafto-factory-impl-phase-a/);
    assert.match(script, /Phase A: implementation skipped/);
  });

  it("Phase B path acquires a slot and creates a worktree", () => {
    assert.match(script, /factory:slot-acquire/);
    assert.match(script, /worktree-cli\.mjs" add --issue/);
  });

  it("blocks when there is no approved plan to implement from", () => {
    assert.match(script, /drafto-factory-no-plan/);
  });

  it("runs the parity post-check and blocks on violation", () => {
    assert.match(script, /parity_violation/);
    assert.match(script, /drafto-factory-parity-violation/);
  });

  it("retains the slot + worktree for --watch on the happy path", () => {
    assert.match(script, /retained for --watch/);
    assert.match(script, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "In Review"/);
  });
});

describe("--watch engine", () => {
  it("runs a cleanup sweep that releases slots leaving In Review/In Test", () => {
    assert.match(script, /Cleanup sweep/);
    assert.match(script, /left In Review\/In Test; releasing slot \+ worktree/);
  });

  it("advances to In Test only when CI is green AND a preview exists", () => {
    assert.match(script, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "In Test"/);
    assert.match(script, /drafto-factory-in-test/);
  });

  it("invokes the watch fix loop with the dedicated prompt", () => {
    assert.match(script, /factory-watch-prompt\.md/);
    assert.match(script, /WATCH_TIMEOUT_SEC/);
  });
});

describe("supporting files exist", () => {
  it("implement + watch prompts and the worktree CLI are present", () => {
    assert.ok(existsSync(resolve(SCRIPTS, "factory-prompt.md")));
    assert.ok(existsSync(resolve(SCRIPTS, "factory-watch-prompt.md")));
    assert.ok(existsSync(resolve(SCRIPTS, "lib", "worktree-cli.mjs")));
  });
});
