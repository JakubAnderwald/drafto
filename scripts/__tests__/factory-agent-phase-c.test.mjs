import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Structural guardrails for Phase C. Phase C lifts the Phase-B web-only hard
// stop (the factory may now implement mobile/desktop for board cards) and adds
// a `support`-label skip so the factory never poaches issues owned by
// nightly-support.sh Phase 3 (see the ADR-0026 update, 2026-06-21). These
// assert the runtime contract so a future refactor can't silently drop a guard
// or turn the web-only relaxation into an unconditional parity bypass.

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

describe("support-label skip guard (nightly-support.sh coexistence)", () => {
  it("skips support-labelled cards in every factory loop (all 7)", () => {
    // One guard per loop: Planning rescue, Ready, Plan Review replan,
    // In Progress, In Review, In Test, Approved. The factory must never act on
    // an issue nightly-support.sh owns.
    const matches = script.match(/",support,"\*/g) || [];
    assert.equal(
      matches.length,
      7,
      `expected a support-label skip in all 7 loops, found ${matches.length}`,
    );
  });

  it("documents that nightly-support.sh owns support issues", () => {
    assert.match(script, /support label — nightly-support\.sh owns these/);
  });

  it("pairs each support skip with the factory-pause kill switch", () => {
    // The support guard mirrors the per-card factory-pause guard at each site,
    // so there must be at least as many factory-pause guards as support guards.
    const pause = script.match(/",factory-pause,"\*/g) || [];
    const support = script.match(/",support,"\*/g) || [];
    assert.ok(
      pause.length >= support.length,
      `factory-pause guards (${pause.length}) should be >= support guards (${support.length})`,
    );
  });
});

describe("Phase C web-only relaxation is gate-based, not a bypass", () => {
  it("keeps the Phase-B web-only hard stop keyed on $PHASE == B", () => {
    assert.match(script, /if \[\[ "\$PHASE" == "B" \]\] && echo "\$diff_files" \| grep -qE/);
  });

  it("does not introduce an unconditional Phase-C parity bypass", () => {
    assert.doesNotMatch(script, /"\$PHASE" == "C".*apps\/\(mobile\|desktop\)/);
  });

  it("retains the per-platform parity mandate (claimed-but-missing checks)", () => {
    assert.match(script, /claimed platform 'mobile' has no apps\/mobile changes/);
  });
});
