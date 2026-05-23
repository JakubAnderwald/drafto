import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
