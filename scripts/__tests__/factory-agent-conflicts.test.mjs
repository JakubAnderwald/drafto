import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Merge conflicts with main (ADR-0061). #755 sat in Approved for days: --release
// only commented on a conflict, the comment pointed at a route no mode reads,
// and nothing in the factory ever merged main into a PR branch. Now a conflict
// anywhere past In Review hands the card back, and --watch resolves it.

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

const watchBlock = (() => {
  const start = script.indexOf("# ── --watch mode");
  const end = script.indexOf("# ── In Test feedback sweep", start);
  assert.ok(start !== -1 && end !== -1, "could not locate the In Review loop");
  return script.slice(start, end);
})();

const inTestSweep = (() => {
  const start = script.indexOf("# ── In Test feedback sweep");
  const end = script.indexOf("# ── --release mode", start);
  assert.ok(start !== -1 && end !== -1, "could not locate the In Test sweep");
  return script.slice(start, end);
})();

// Extract <fns> from the real script and run <body> against stubs. Calls the
// functions make are appended to $CALLS, which is printed after the body.
function run(fns, body) {
  const dir = mkdtempSync(join(tmpdir(), "factory-conflicts-"));
  const extract = fns
    .map((fn) => `eval "$(awk '/^${fn}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`)
    .join("\n");
  const snippet = `
set -euo pipefail
CALLS="${dir}/calls"; : >"$CALLS"
LOG_FILE="${dir}/log"
SCRIPT_DIR=/factory/scripts
DRY_RUN=0
log() { echo "LOG $*" >>"$CALLS"; }
gh() { echo "GH $*" >>"$CALLS"; }
transition_status() { echo "MOVE $2 $3" >>"$CALLS"; }
${extract}
${body}
echo "---"
cat "$CALLS"
`;
  try {
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("conflict_handback", () => {
  const head = "e89f095cddc4a1b2c3d4e5f6";

  it("comments once per head and moves an Approved card back to In Review", () => {
    const out = run(
      ["conflict_handback"],
      `issue_has_marker() { echo "MARKER? $2" >>"$CALLS"; return 1; }
       conflict_handback ITEM 688 755 ${head} "Approved"`,
    );
    assert.match(out, /MARKER\? drafto-factory-conflict:e89f095cddc4\n/);
    assert.match(out, /GH issue comment 688 .*PR #755 conflicts with `main`/s);
    assert.match(out, /your approval doesn't carry over/);
    assert.match(out, /<!-- drafto-factory-conflict:e89f095cddc4 -->/);
    assert.match(out, /MOVE 688 In Review/);
  });

  it("tells an In Test reporter to stop testing the old version", () => {
    const out = run(
      ["conflict_handback"],
      `issue_has_marker() { return 1; }
       conflict_handback ITEM 748 765 ${head} "In Test"`,
    );
    assert.match(out, /from \*\*In Test\*\* back to \*\*In Review\*\*/);
    assert.match(out, /fresh preview/);
    assert.match(out, /MOVE 748 In Review/);
  });

  it("still moves the card when this head was already announced", () => {
    const out = run(
      ["conflict_handback"],
      `issue_has_marker() { return 0; }
       conflict_handback ITEM 688 755 ${head} "Approved"`,
    );
    assert.doesNotMatch(out, /GH issue comment/);
    assert.match(out, /MOVE 688 In Review/);
  });

  it("only logs on a dry run", () => {
    const out = run(
      ["conflict_handback"],
      `DRY_RUN=1
       issue_has_marker() { return 1; }
       conflict_handback ITEM 688 755 ${head} "Approved"`,
    );
    assert.doesNotMatch(out, /GH |MOVE /);
    assert.match(out, /DRY-RUN: would comment on #688/);
  });

  it("does nothing without a head SHA, since the marker would be ambiguous", () => {
    const out = run(
      ["conflict_handback"],
      `issue_has_marker() { return 1; }
       conflict_handback ITEM 688 755 "" "Approved" || echo "RC=$?"`,
    );
    assert.match(out, /RC=1/);
    assert.doesNotMatch(out, /GH |MOVE /);
  });
});

describe("conflict_pass_verified", () => {
  const merge = JSON.stringify({
    mainSha: "m".repeat(40),
    conflictedFiles: ["docs/adr/README.md"],
  });
  const resolved = (head) =>
    JSON.stringify({ head, resolved: true, inProgress: false, unmergedFiles: [] });
  // node stands in for worktree-cli.mjs: merge-check prints $CHECK, push moves
  // the PR head to the local head.
  const stubs = `
PR_HEAD_FILE=$(mktemp)
node() {
  case "$2" in
    merge-check) echo "CHECK $*" >>"$CALLS"; echo "$CHECK" ;;
    push) echo "PUSH $*" >>"$CALLS"; echo "$LOCAL" >"$PR_HEAD_FILE" ;;
  esac
}
pr_head_oid() { cat "$PR_HEAD_FILE"; }
`;

  it("accepts a resolution that is committed and on the PR", () => {
    const out = run(
      ["conflict_pass_verified"],
      `${stubs}
       LOCAL=abc; echo abc >"$PR_HEAD_FILE"; CHECK='${resolved("abc")}'
       conflict_pass_verified /wt 755 '${merge}' && echo VERIFIED`,
    );
    assert.match(out, /VERIFIED/);
    assert.doesNotMatch(out, /PUSH/);
    // The conflicted files go over as JSON, so a comma in a path survives.
    assert.match(out, /CHECK .* --files-json \["docs\/adr\/README\.md"\]/);
  });

  it("pushes a verified resolution the agent forgot to push", () => {
    const out = run(
      ["conflict_pass_verified"],
      `${stubs}
       LOCAL=abc; echo old >"$PR_HEAD_FILE"; CHECK='${resolved("abc")}'
       conflict_pass_verified /wt 755 '${merge}' && echo VERIFIED`,
    );
    assert.match(out, /PUSH .*push --path \/wt/);
    assert.match(out, /VERIFIED/);
  });

  it("rejects a merge that is not resolved, whatever the agent said", () => {
    const check = JSON.stringify({
      head: "abc",
      resolved: false,
      inProgress: false,
      unmergedFiles: [],
      mainIsAncestor: true,
      filesWithMarkers: ["docs/adr/README.md"],
      adrCollisions: [],
    });
    const out = run(
      ["conflict_pass_verified"],
      `${stubs}
       LOCAL=abc; echo abc >"$PR_HEAD_FILE"; CHECK='${check}'
       conflict_pass_verified /wt 755 '${merge}' || echo "WHY=$CONFLICT_PASS_WHY"`,
    );
    assert.match(out, /WHY=unresolved: .*filesWithMarkers.*README/);
  });

  it("rejects a resolution that never reaches the PR", () => {
    const out = run(
      ["conflict_pass_verified"],
      `${stubs}
       pr_head_oid() { echo old; }
       LOCAL=abc; CHECK='${resolved("abc")}'
       conflict_pass_verified /wt 755 '${merge}' || echo "WHY=$CONFLICT_PASS_WHY"`,
    );
    assert.match(out, /WHY=the resolution never reached the PR/);
  });
});

describe("rollback_conflict_pass", () => {
  it("aborts the merge and rolls back to the pre-merge head", () => {
    const out = run(
      ["rollback_conflict_pass"],
      `node() { echo "NODE $*" >>"$CALLS"; }
       rollback_conflict_pass /wt abc123`,
    );
    assert.match(
      out,
      /NODE \/factory\/scripts\/lib\/worktree-cli\.mjs merge-abort --path \/wt --to abc123/,
    );
  });

  it("only aborts when the pre-merge head is unknown, and never fails", () => {
    const out = run(
      ["rollback_conflict_pass"],
      `node() { echo "NODE $*" >>"$CALLS"; return 1; }
       rollback_conflict_pass /wt "" && echo OK`,
    );
    assert.match(out, /NODE \S+ merge-abort --path \/wt\n/);
    assert.match(out, /OK/);
  });
});

describe("build_watch_bundle carries the merge result", () => {
  const scriptsDir = resolve(HERE, "..");
  const setup = `SCRIPT_DIR='${scriptsDir}'; REPO_ROOT='${resolve(scriptsDir, "..")}'
    SUPPORT_ALLOWLIST=a@example.com; OAUTH_USER_EMAIL=b@example.com; PHASE=C
    ISSUE='{"number":688,"title":"t","body":"","labels":[]}'`;

  it("as mergeConflict on a conflict pass, and null on any other", () => {
    const merge = JSON.stringify({
      status: "conflicts",
      mainSha: "abc",
      conflictedFiles: ["docs/adr/README.md"],
      adrCollisions: [],
      nextFreeAdr: "0062",
    });
    const out = run(
      ["build_watch_bundle"],
      `${setup}
       build_watch_bundle "$ISSUE" null null "" "[]" 0 "[]" "[]" | jq -c '.mergeConflict'
       build_watch_bundle "$ISSUE" null null "" "[]" 0 "[]" "[]" '${merge}' | jq -c '.mergeConflict'`,
    );
    const [plain, conflict] = out.split("---")[0].trim().split("\n");
    assert.equal(plain, "null");
    assert.deepEqual(JSON.parse(conflict), {
      mainSha: "abc",
      conflictedFiles: ["docs/adr/README.md"],
      adrCollisions: [],
      nextFreeAdr: "0062",
    });
  });
});

describe("--watch conflict pass wiring", () => {
  it("reads mergeability before anything that waits on CI", () => {
    const conflictAt = watchBlock.indexOf('jq -r \'.mergeable // ""\')" == "CONFLICTING"');
    const threadsAt = watchBlock.indexOf('REVIEW_THREADS=$(fetch_review_threads "$PR_NUM"');
    const pendingAt = watchBlock.indexOf('if [[ "$PENDING" -gt 0 ]]; then');
    assert.ok(conflictAt > 0 && threadsAt > 0 && pendingAt > 0);
    assert.ok(conflictAt < threadsAt && conflictAt < pendingAt);
    assert.match(
      watchBlock,
      /if \[\[ "\$CONFLICTING" -eq 0 && "\$FAILING" -eq 0 && "\$PENDING" -eq 0 \]\] && ci_required_green/,
    );
  });

  it("merges main after resuming the worktree and before the install", () => {
    const addAt = watchBlock.indexOf('worktree-cli.mjs" add --issue "$ISSUE_NUM"');
    const mergeAt = watchBlock.indexOf('worktree-cli.mjs" merge-main --path "$WT_PATH"');
    const installAt = watchBlock.indexOf('run_pnpm_install "$WT_PATH"');
    assert.ok(addAt > 0 && mergeAt > addAt && installAt > mergeAt);
  });

  it("pushes a clean merge without a Claude run, and hands conflicts to the agent", () => {
    const pass = watchBlock.slice(
      watchBlock.indexOf('worktree-cli.mjs" merge-main'),
      watchBlock.indexOf('run_pnpm_install "$WT_PATH"'),
    );
    assert.match(pass, /up-to-date\|clean\)/);
    assert.match(pass, /worktree-cli\.mjs" push --path "\$WT_PATH"/);
    assert.match(
      pass,
      /build_watch_bundle .*"\$REVIEW_THREADS" "\$MERGE_JSON"/,
      "the agent needs the merge result",
    );
  });

  it("never leaves the worktree mid-merge when claude fails or hits a session limit", () => {
    const failAt = watchBlock.indexOf("if [[ $EXIT_CODE -ne 0 ]]; then");
    const limitAt = watchBlock.indexOf("pause_for_session_limit", failAt);
    assert.ok(failAt > 0 && limitAt > failAt);
    assert.match(
      watchBlock.slice(failAt, limitAt),
      /\[\[ "\$CONFLICTING" -eq 1 \]\] && rollback_conflict_pass "\$WT_PATH" "\$MERGE_BEFORE"/,
    );
  });

  it("verifies the agent's fixed, and rolls back and spends an attempt only on failure", () => {
    const start = watchBlock.indexOf(
      'if [[ "$CONFLICTING" -eq 1 ]]; then\n        if [[ "$WACTION"',
    );
    assert.ok(start > 0, "conflict outcome block not found");
    const outcome = watchBlock.slice(start, watchBlock.indexOf('case "$WACTION" in', start));
    assert.match(outcome, /conflict_pass_verified "\$WT_PATH" "\$PR_NUM" "\$MERGE_JSON"/);
    // A verified merge is progress: nothing between it and the else spends budget.
    const success = outcome.slice(0, outcome.indexOf("        else\n"));
    assert.doesNotMatch(success, /bump-attempts/);
    const failure = outcome.slice(outcome.indexOf("        else\n"));
    assert.match(failure, /rollback_conflict_pass "\$WT_PATH" "\$MERGE_BEFORE"/);
    assert.match(failure, /"Blocked"/);
    assert.match(failure, /factory:bump-attempts/);
    assert.match(outcome, /continue/);
  });

  it("retries an unreachable origin without spending budget", () => {
    const arm = watchBlock.slice(
      watchBlock.indexOf("          unreachable)"),
      watchBlock.indexOf("          up-to-date|clean)"),
    );
    assert.match(arm, /retrying next tick/);
    assert.match(arm, /continue/);
    assert.doesNotMatch(arm, /bump-attempts/);
  });

  it("gives the agent no PR comments, and builds the bundle once, after the merge", () => {
    assert.match(watchBlock, /\[\[ "\$CONFLICTING" -eq 1 \]\] && UNRESOLVED="\[\]"/);
    assert.match(
      watchBlock,
      /if \[\[ "\$CONFLICTING" -eq 0 \|\| "\$DRY_RUN" -eq 1 \]\]; then\n\s+if ! BUNDLE=\$\(build_watch_bundle/,
    );
  });

  it("skips the install while a package.json is conflicted", () => {
    const at = watchBlock.indexOf("package.json conflicts; leaving the install to the agent");
    assert.ok(at > 0);
    const guard = watchBlock.slice(at - 400, at);
    assert.match(guard, /any\(test\("\(\^\|\/\)package\\\\\.json\$"\)\)/);
  });

  it("says a conflict exhausted the budget when one did", () => {
    assert.match(
      script,
      /EXHAUSTED_WHAT="merge \\`main\\` into PR #\$PR_NUM and resolve its conflicts"/,
    );
  });
});

describe("In Test sweep hands a conflicting card back", () => {
  it("asks GitHub for mergeability", () => {
    assert.match(inTestSweep, /--json statusCheckRollup,comments,headRefOid,mergeable/);
  });

  it("acts before dispatching betas, and only when no feedback is pending", () => {
    const pendingAt = inTestSweep.indexOf("INTEST_PENDING_FEEDBACK=1");
    const handbackAt = inTestSweep.indexOf(
      'conflict_handback "$ITEM_ID" "$ISSUE_NUM" "$INTEST_PR_NUM"',
    );
    const lanesAt = inTestSweep.indexOf("intest_check_lane_outcomes");
    const dispatchAt = inTestSweep.indexOf("intest_dispatch_betas");
    assert.ok(pendingAt > 0 && handbackAt > pendingAt);
    assert.ok(handbackAt < lanesAt && handbackAt < dispatchAt);
    const guard = inTestSweep.slice(handbackAt - 300, handbackAt);
    assert.match(guard, /"\$INTEST_PENDING_FEEDBACK" -eq 0/);
    assert.match(guard, /CONFLICTING/);
  });
});
