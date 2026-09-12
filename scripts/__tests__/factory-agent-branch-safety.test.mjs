// Branch-safety wiring in factory-agent.sh.
//
// The bug being pinned: the --watch cleanup sweep deleted the local branch
// whenever a card lost its status:in-progress/in-review/in-test label while
// still holding a slot — which the retry-exhausted paths cause with the PR
// still OPEN. addWorktree then found no local branch and rebuilt the worktree
// from origin/main, so the next revision run edited pre-PR files and its push
// was rejected. See ADR-0033.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

// Extract one function definition (start of `name()` through its first
// column-0 `}`) from the real script and exercise it. Mirrors the idiom in
// factory-agent-release.test.mjs.
function withFn(fn, body) {
  const snippet = `
set -euo pipefail
eval "$(awk '/^${fn}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
${body}
`;
  const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
  assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
  return r.stdout.trim();
}

// The sweep block, sliced so a match can't be satisfied elsewhere in the file.
const sweepBlock = (() => {
  const start = script.indexOf("  # ── 1. Cleanup sweep ──");
  assert.ok(start !== -1, "could not find the cleanup sweep block");
  const end = script.indexOf("  # ── 2.", start);
  assert.ok(end !== -1, "could not find the end of the cleanup sweep block");
  return script.slice(start, end);
})();

describe("factory-agent.sh branch safety", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", agentPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  describe("branch_keep_reason", () => {
    const stub = (json) => `find_prior_pr() { printf '%s' '${json}'; }\n`;

    it("allows deletion when the PR merged", () => {
      assert.equal(
        withFn(
          "branch_keep_reason",
          stub('{"number":9,"state":"MERGED"}') + "branch_keep_reason 9",
        ),
        "",
      );
    });

    it("allows deletion when the issue never had a PR", () => {
      assert.equal(withFn("branch_keep_reason", stub("null") + "branch_keep_reason 9"), "");
    });

    it("keeps the branch while the PR is OPEN", () => {
      const out = withFn(
        "branch_keep_reason",
        stub('{"number":591,"state":"OPEN"}') + "branch_keep_reason 591",
      );
      assert.match(out, /OPEN/);
      assert.match(out, /591/);
    });

    it("keeps the branch for a CLOSED PR (reopen-by-push)", () => {
      const out = withFn(
        "branch_keep_reason",
        stub('{"number":12,"state":"CLOSED"}') + "branch_keep_reason 12",
      );
      assert.match(out, /CLOSED/);
    });

    it("fails closed when the PR lookup exits non-zero", () => {
      // The gh-outage case: `pipefail` makes find_prior_pr's failure visible,
      // and the branch must be kept rather than assumed disposable.
      const out = withFn(
        "branch_keep_reason",
        "find_prior_pr() { return 1; }\nbranch_keep_reason 9",
      );
      assert.notEqual(out, "", "a failed lookup must keep the branch");
    });

    it("fails closed when the PR lookup returns nothing", () => {
      const out = withFn(
        "branch_keep_reason",
        "find_prior_pr() { printf ''; }\nbranch_keep_reason 9",
      );
      assert.notEqual(out, "", "an empty lookup must keep the branch");
    });

    it("fails closed on an unrecognised PR state", () => {
      const out = withFn(
        "branch_keep_reason",
        stub('{"number":9,"state":"WEIRD"}') + "branch_keep_reason 9",
      );
      assert.notEqual(out, "", "an unknown state must keep the branch");
    });

    it("skips the lookup entirely when the caller knows it merged", () => {
      // find_prior_pr deliberately explodes: a MERGED hint must short-circuit.
      const out = withFn(
        "branch_keep_reason",
        "find_prior_pr() { echo 'lookup should not run' >&2; exit 1; }\nbranch_keep_reason 9 MERGED",
      );
      assert.equal(out, "");
    });
  });

  describe("teardown call sites", () => {
    it("routes the cleanup sweep through the PR-gated helper", () => {
      assert.match(sweepBlock, /remove_worktree_for "\$SLOT_ISSUE"/);
      assert.doesNotMatch(
        sweepBlock,
        /--delete-branch/,
        "the sweep must never unconditionally delete the branch — the PR may still be open",
      );
    });

    it("keeps exactly one --delete-branch call in the whole script", () => {
      const calls = script.match(/worktree-cli\.mjs" remove[^\n]*--delete-branch/g) ?? [];
      assert.equal(calls.length, 1, "only remove_worktree_for may delete a branch");
    });
  });

  describe("slot leak on Blocked transitions", () => {
    // A slot retained past a Blocked transition is what arms the sweep to tear
    // down a worktree whose PR is still open.
    const markers = [
      ["implement retry exhausted", "Implementation retry budget exhausted"],
      ["disk guard", "drafto-factory-disk-low"],
      ["no approved plan", "drafto-factory-no-plan"],
    ];

    for (const [name, marker] of markers) {
      it(`releases the slot after the ${name} Blocked transition`, () => {
        const at = script.indexOf(marker);
        assert.ok(at !== -1, `could not locate the ${name} path`);
        const window = script.slice(at, at + 900);
        assert.match(window, /release_slot_and_worktree "\$ISSUE_NUM"/);
      });
    }

    it("releases the slot after the watch retry-exhausted Blocked transition", () => {
      const at = script.indexOf("Fix retry budget exhausted");
      assert.ok(at !== -1, "could not locate the watch retry-exhausted path");
      const window = script.slice(at, at + 900);
      assert.match(window, /release_slot_and_worktree "\$ISSUE_NUM"/);
    });
  });

  describe("worktree creation", () => {
    it("passes --fetch at both add sites so a deleted branch is recovered", () => {
      const adds =
        script.match(/worktree-cli\.mjs" add --issue[\s\S]{0,120}?2>>"\$LOG_FILE"/g) ?? [];
      assert.equal(adds.length, 2, "expected the --implement and --watch add sites");
      for (const add of adds) {
        assert.match(add, /--fetch/, `add site missing --fetch: ${add}`);
      }
    });

    it("logs where the worktree was branched from", () => {
      const logs = script.match(/fromRemote=\$\(echo "\$WT_JSON"/g) ?? [];
      assert.equal(logs.length, 2, "both add sites should report fromRemote");
    });
  });
});
