import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for the orphaned-"Planning" rescue sweep.
//
// Background (issue #418): a --plan tick was killed by SIGTERM while writing
// the board status back from Planning → Plan Review after a successful replan.
// The card was stranded in Planning forever: the Ready sweep only scans Ready
// items and the replan sweep only scans Plan Review items, so nothing ever
// re-floated it. The rescue sweep at the top of --plan fixes this class of
// orphan. These assertions lock in the behaviour and — critically — its
// ordering relative to the Ready sweep.

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");

function runBash(snippet) {
  const result = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
  assert.equal(result.status, 0, `bash exited non-zero: ${result.stderr}`);
  return result.stdout.trim().split("\n").filter(Boolean);
}

describe("factory-agent --plan orphaned-Planning rescue sweep", () => {
  it("the script is syntactically valid bash", () => {
    const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(result.status, 0, `bash -n failed: ${result.stderr}`);
  });

  it("queries the Planning queue for orphans", () => {
    assert.match(
      script,
      /query-status-items\s+\\\n\s*--status Planning/,
      "expected a rescue query against the Planning status",
    );
  });

  it("runs the rescue sweep BEFORE the Ready sweep parks new cards in Planning", () => {
    // This ordering is the whole correctness argument: because the per-mode
    // plan lock guarantees no concurrent planner, any card in Planning at the
    // TOP of the tick is a genuine orphan. If the rescue ran after the Ready
    // sweep it could grab a card this very tick just moved into Planning.
    const rescueIdx = script.indexOf("rescue sweep:");
    const readyQueryIdx = script.indexOf("Pull the Ready queue from the board");
    assert.ok(rescueIdx > 0, "expected a rescue sweep log line");
    assert.ok(readyQueryIdx > 0, "expected the Ready queue fetch");
    assert.ok(rescueIdx < readyQueryIdx, "rescue sweep must precede the Ready queue fetch");
  });

  it("uses a C-style for-loop (the #414 BSD-seq-safe form)", () => {
    assert.match(
      script,
      /for\s*\(\(IDX=0;\s*IDX<RESCUE_COUNT;\s*IDX\+\+\)\)/,
      "expected C-style for-loop over RESCUE_COUNT",
    );
  });

  it("routes orphans by whether a plan comment exists", () => {
    // Isolate the rescue block (top of --plan, ends at the Ready queue fetch).
    const start = script.indexOf("Orphaned-Planning rescue sweep");
    const end = script.indexOf("Pull the Ready queue from the board");
    assert.ok(start > 0 && end > start, "could not isolate the rescue block");
    const block = script.slice(start, end);

    // Decision is gated on the existing plan-marker helper.
    assert.match(block, /issue_already_planned "\$COMMENTS_JSON"/);
    // plan comment present → Plan Review.
    assert.match(block, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "Plan Review"/);
    // no plan comment → Ready (re-plan from scratch).
    assert.match(block, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "Ready"/);
    // exhausted retry budget → Blocked (bounds a persistently-dying card).
    assert.match(block, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "Blocked"/);
    // the exhaustion notice is idempotency-guarded so a stuck → Blocked
    // transition can't make every subsequent tick re-post the same comment.
    assert.match(block, /jq -e/);
    assert.match(block, /test\("<!-- drafto-factory-retry-exhausted -->"\)/);
    // honours the per-card kill switch.
    assert.match(block, /factory-pause/);
  });

  it("C-style loop does not iterate when RESCUE_COUNT is 0", () => {
    const lines = runBash(
      'RESCUE_COUNT=0; for ((IDX=0; IDX<RESCUE_COUNT; IDX++)); do echo "$IDX"; done',
    );
    assert.deepEqual(lines, [], "rescue loop must be a no-op on an empty Planning queue");
  });

  it("non-numeric count is coerced to 0 before the loop", () => {
    // Mirrors the guard in the script: a malformed jq result must not let the
    // loop run with a garbage bound.
    const lines = runBash(
      'RESCUE_COUNT="oops"; if ! [[ "$RESCUE_COUNT" =~ ^[0-9]+$ ]]; then RESCUE_COUNT=0; fi; ' +
        'for ((IDX=0; IDX<RESCUE_COUNT; IDX++)); do echo "$IDX"; done; echo "count=$RESCUE_COUNT"',
    );
    assert.deepEqual(lines, ["count=0"]);
  });
});
