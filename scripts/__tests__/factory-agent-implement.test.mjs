import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for issue #414. The `--implement` block in
// scripts/factory-agent.sh used `for IDX in $(seq 0 $((INPROG_COUNT - 1)))`
// which, when INPROG_COUNT=0, becomes `seq 0 -1`. BSD seq (macOS) auto-flips
// to a descending sequence and prints "0\n-1", so the loop ran twice with
// bogus indices and called fetch_issue_comments with the literal string
// "null". This locks in the C-style for-loop form that handles count=0
// correctly across platforms.

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-agent.sh");

function runBash(snippet) {
  const result = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
  assert.equal(result.status, 0, `bash exited non-zero: ${result.stderr}`);
  return result.stdout.trim().split("\n").filter(Boolean);
}

describe("factory-agent --implement loop construct", () => {
  it("factory-agent.sh uses C-style loops and guards the zero-count case", () => {
    const script = readFileSync(scriptPath, "utf8");
    // --implement: C-style loop + early-return guard for empty In Progress
    assert.match(
      script,
      /for\s*\(\(IDX=0;\s*IDX<INPROG_COUNT;\s*IDX\+\+\)\)/,
      "expected C-style for-loop over INPROG_COUNT",
    );
    assert.match(
      script,
      /if\s+\[\[\s*"\$INPROG_COUNT"\s+-eq\s+0\s*\]\]/,
      "expected zero-count guard before the --implement loop",
    );
    // --plan: same C-style form (sibling loop fixed in the same change)
    assert.match(
      script,
      /for\s*\(\(IDX=0;\s*IDX<READY_COUNT;\s*IDX\+\+\)\)/,
      "expected C-style for-loop over READY_COUNT",
    );
    // The BSD-seq form that caused #414 must not reappear.
    assert.doesNotMatch(
      script,
      /for\s+IDX\s+in\s+\$\(seq\s+0\s+\$\(\((INPROG|READY)_COUNT\s*-\s*1\)\)\)/,
      "seq-based loop form must not be reintroduced",
    );
  });

  it("C-style for-loop does not iterate when count is 0", () => {
    const lines = runBash('COUNT=0; for ((IDX=0; IDX<COUNT; IDX++)); do echo "$IDX"; done');
    assert.deepEqual(lines, [], "loop must not run when COUNT=0");
  });

  it("C-style for-loop iterates the expected number of times", () => {
    const lines = runBash('COUNT=3; for ((IDX=0; IDX<COUNT; IDX++)); do echo "$IDX"; done');
    assert.deepEqual(lines, ["0", "1", "2"]);
  });

  it("documents the BSD-seq gotcha that the old form hit", () => {
    // This is the exact pattern that caused #414. We don't assert "must
    // print 2 lines" because GNU seq (Linux CI) would print zero — the
    // bug only manifests on BSD seq. We assert the safer claim: the old
    // form is not guaranteed to be empty across platforms, while the new
    // form is. So we just verify the new form's emptiness above and
    // record this case for future readers.
    const platform = process.platform;
    const lines = runBash('COUNT=0; for IDX in $(seq 0 $((COUNT - 1))); do echo "$IDX"; done');
    if (platform === "darwin") {
      assert.deepEqual(
        lines,
        ["0", "-1"],
        "BSD seq on darwin prints 0 and -1 for `seq 0 -1` — this is what caused #414",
      );
    }
    // On linux GNU seq, lines === []; no assertion needed.
  });
});

// A card with no free slot must not stop the sweep. The cards that hold the two
// slots can sit lower on the board — a revision sent back from In Test keeps
// its slot — and only their own runs can ever free one. With a `break` here,
// newly approved cards at the top of In Progress (#794) kept the slot holders
// (#790, #328) from running for a day. This runs the script's real
// slot_for_issue and slot block against a state where both slots are taken.
describe("factory-agent --implement slot deferral", () => {
  const script = readFileSync(scriptPath, "utf8");
  const scriptsDir = dirname(scriptPath);
  const slotFn = script.match(/^slot_for_issue\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
  const slotBlock = script.match(
    /^ {4}SLOT=\$\(slot_for_issue "\$ISSUE_NUM"\)\n {4}if \[\[ -z "\$SLOT" \]\]; then\n[\s\S]*?\n {4}fi\n/m,
  )?.[0];

  function sweep(slots, order) {
    const dir = mkdtempSync(join(tmpdir(), "factory-slot-sweep-"));
    try {
      const stateFile = join(dir, "factory-state.json");
      const slotRecord = (issueNumber) => ({
        pid: null,
        issueNumber,
        acquiredAt: issueNumber ? "2026-11-07T15:00:00.000Z" : null,
      });
      writeFileSync(
        stateFile,
        JSON.stringify({ slots: { 0: slotRecord(slots[0]), 1: slotRecord(slots[1]) } }),
      );
      const harness = [
        "set -u",
        `SCRIPT_DIR=${JSON.stringify(scriptsDir)}`,
        `STATE_FILE=${JSON.stringify(stateFile)}`,
        "LOG_FILE=/dev/null",
        'log() { echo "log: $*"; }',
        slotFn,
        `for ISSUE_NUM in ${order.join(" ")}; do`,
        slotBlock,
        '  echo "implement #$ISSUE_NUM in slot $SLOT"',
        "done",
      ].join("\n");
      return runBash(harness);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("finds slot_for_issue and the slot block in factory-agent.sh", () => {
    assert.ok(slotFn, "could not extract slot_for_issue()");
    assert.ok(slotBlock, "could not extract the --implement slot block");
  });

  it("runs the slot holders below a slotless card instead of stopping the sweep", () => {
    assert.deepEqual(sweep(["790", "328"], ["794", "790", "328", "759"]), [
      "log: Issue #794: both worktree slots busy; deferring to a later tick",
      "implement #790 in slot 0",
      "implement #328 in slot 1",
      "log: Issue #759: both worktree slots busy; deferring to a later tick",
    ]);
  });

  it("hands a free slot to the first card that needs one", () => {
    assert.deepEqual(sweep(["790", null], ["794", "790"]), [
      "implement #794 in slot 1",
      "implement #790 in slot 0",
    ]);
  });
});
