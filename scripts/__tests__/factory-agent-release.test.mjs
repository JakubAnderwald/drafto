import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Tests for the --release engine (Approved → Released auto-merge). Covers the
// extractable migration_violation() helper behaviourally, plus the structural
// wiring of the --release block in factory-agent.sh and the loop wrapper.

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const loopPath = resolve(HERE, "..", "factory-agent-loop.sh");
const script = readFileSync(agentPath, "utf8");

// Slice the --release block out of the script so structural assertions can't be
// satisfied by an incidental match elsewhere (e.g. the --watch CI-rollup jq).
const releaseBlock = (() => {
  const start = script.indexOf("# ── --release mode");
  assert.ok(start !== -1, "could not find the --release block");
  const end = script.indexOf("# All reachable modes have returned above", start);
  assert.ok(end !== -1, "could not find the end of the --release block");
  return script.slice(start, end);
})();

// Run a bash snippet that extracts a function definition from the real script
// (start of `name()` through its first column-0 `}`) and exercises it.
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

describe("factory-agent.sh syntax", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", agentPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("migration_violation (extracted from factory-agent.sh)", () => {
  const mig = "supabase/migrations/0099_add_col.sql";
  const web = "apps/web/src/x.ts";

  it("blocks a migration PR with no migration-approved label", () => {
    const out = withFn(
      "migration_violation",
      `migration_violation ${JSON.stringify(`${mig}\n${web}`)} ${JSON.stringify("status:approved")}`,
    );
    assert.notEqual(out, "", "expected a violation reason");
    assert.match(out, /migration-approved/);
  });

  it("passes a migration PR once migration-approved is present", () => {
    const out = withFn(
      "migration_violation",
      `migration_violation ${JSON.stringify(`${mig}\n${web}`)} ${JSON.stringify("status:approved,migration-approved")}`,
    );
    assert.equal(out, "");
  });

  it("passes a PR that touches no migrations regardless of labels", () => {
    const out = withFn(
      "migration_violation",
      `migration_violation ${JSON.stringify(web)} ${JSON.stringify("")}`,
    );
    assert.equal(out, "");
  });

  it("does not match a similarly-named non-migration path", () => {
    // e.g. a doc about migrations, or a supabase/functions path — only the
    // migrations dir is gated.
    const out = withFn(
      "migration_violation",
      `migration_violation ${JSON.stringify("docs/operations/migrations.md\nsupabase/functions/x.ts")} ${JSON.stringify("")}`,
    );
    assert.equal(out, "");
  });
});

describe("parity_violation (extracted from factory-agent.sh)", () => {
  // parity_violation reads the $PHASE global; the extracted snippet must set it
  // or `set -u` trips before the function body even runs.
  const callAt = (phase, platforms, override, diff) =>
    withFn(
      "parity_violation",
      `PHASE=${phase}\nparity_violation ${JSON.stringify(platforms)} ${JSON.stringify(override)} ${JSON.stringify(diff)}`,
    );

  it("does not crash on the --release call site's empty platforms (bash 3.2 set -u regression)", () => {
    // The --release gate invokes `parity_violation "" "" "$DIFF_FILES"` to
    // exercise only the phase-scope guard. An empty platforms CSV used to
    // expand an empty array under `set -u`, aborting the whole --release run
    // with "unbound variable" on bash 3.2 (the Mac mini's /bin/bash) — which
    // crash-looped the release engine and spammed failure issues. withFn runs
    // the snippet under `set -euo pipefail`, so any recurrence fails the test.
    const out = callAt("C", "", "", "docs/README.md\nCLAUDE.md");
    assert.equal(out, "", "empty platforms must yield no violation, not a crash");
  });

  it("holds a Phase B PR that touches mobile/desktop (web-only rule)", () => {
    const out = callAt("B", "", "", "apps/mobile/src/x.ts");
    assert.match(out, /Phase B is web-only/);
  });

  it("flags a claimed platform that has no matching diff", () => {
    const out = callAt("C", "web", "", "docs/README.md");
    assert.match(out, /claimed platform 'web' has no apps\/web changes/);
  });

  it("passes when the claimed platform is present in the diff", () => {
    const out = callAt("C", "web", "", "apps/web/src/x.ts");
    assert.equal(out, "");
  });

  it("skips the cross-platform mandate when a parity override is set", () => {
    const out = callAt("C", "", "web-only", "apps/web/src/x.ts");
    assert.equal(out, "");
  });
});

describe("--release engine wiring", () => {
  it("queries the Approved board column", () => {
    assert.match(releaseBlock, /query-status-items \\?\s*\n?\s*--status "Approved"/);
  });

  it("enforces the migration gate as a hard stop and leaves the card in Approved", () => {
    assert.match(releaseBlock, /migration_violation "\$DIFF_FILES" "\$PR_LABELS"/);
    assert.match(releaseBlock, /drafto-factory-migration-gate/);
  });

  it("requires green CI before merging (failing parks; required contexts must be green)", () => {
    // Advisory non-required reds (e.g. CodeRabbit) must not block the merge, so
    // the park-check counts only required failures.
    assert.match(releaseBlock, /FAILING=\$\(pr_failing_required "\$PR_VIEW"\)/);
    assert.match(releaseBlock, /has \$FAILING failing required check\(s\); not merging/);
    assert.match(releaseBlock, /if ! ci_required_green "\$PR_VIEW"; then/);
  });

  it("fetches branch-protection required contexts once per run", () => {
    assert.match(
      script,
      /REQUIRED_CONTEXTS_JSON=\$\(gh api "repos\/JakubAnderwald\/drafto\/branches\/main\/protection\/required_status_checks"/,
    );
  });

  it("sources changed files from the uncapped `gh pr diff --name-only`, not `--json files`", () => {
    assert.match(
      releaseBlock,
      /DIFF_FILES=\$\(gh pr diff "\$PR_NUM" --repo JakubAnderwald\/drafto --name-only/,
    );
    assert.doesNotMatch(releaseBlock, /\.files\[\]\?\.path/);
  });

  it("re-asserts the phase parity scope on the diff at merge time", () => {
    assert.match(releaseBlock, /parity_violation "" "" "\$DIFF_FILES"/);
  });

  it("refuses drafts and non-main base branches", () => {
    assert.match(releaseBlock, /is a draft; leaving for the operator/);
    assert.match(releaseBlock, /targets '\$PR_BASE', not main; refusing to merge/);
  });

  it("handles a stale (BEHIND) branch by updating it instead of merging", () => {
    assert.match(releaseBlock, /MERGE_STATE=\$\(echo "\$PR_VIEW" \| jq -r '\.mergeStateStatus/);
    // Through the helper --watch uses too (ADR-0070), pinned to the head read,
    // and recorded so a hand-back to In Review carries the review over.
    assert.match(
      releaseBlock,
      /RELEASE_HEAD=\$\(echo "\$PR_VIEW" \| jq -r '\.headRefOid \/\/ ""'\)/,
    );
    assert.match(
      releaseBlock,
      /if update_pr_branch "\$PR_NUM" "\$RELEASE_HEAD"; then\n(?:\s*#[^\n]*\n)*\s*if \[\[ -n "\$RELEASE_HEAD" \]\]; then\n\s*node "\$SCRIPT_DIR\/lib\/state-cli\.mjs" factory:set-issue-field "\$ISSUE_NUM" branchUpdatedFrom \\\n\s*"\$RELEASE_HEAD"/,
    );
    assert.match(releaseBlock, /drafto-factory-branch-updated/);
  });

  it("recovers from a lost merge response instead of false-alarming", () => {
    assert.match(releaseBlock, /RECHECK_STATE/);
    assert.match(releaseBlock, /merge response lost but PR #\$PR_NUM is MERGED/);
  });

  it("finishes the Released transition if the PR merged out-of-band (TOCTOU)", () => {
    assert.match(releaseBlock, /PR_VIEW_STATE" == "MERGED"/);
    assert.match(releaseBlock, /merged out-of-band; finishing Released transition/);
  });

  it("deletes the remote head branch after merge", () => {
    assert.match(
      releaseBlock,
      /--method DELETE "repos\/JakubAnderwald\/drafto\/git\/refs\/heads\/factory\/issue-\$ISSUE_NUM"/,
    );
  });

  it("only merges a MERGEABLE PR", () => {
    assert.match(releaseBlock, /MERGEABLE=\$\(echo "\$PR_VIEW" \| jq -r '\.mergeable/);
    assert.match(releaseBlock, /if \[\[ "\$MERGEABLE" != "MERGEABLE" \]\]; then/);
  });

  // ADR-0061. A conflict used to park the card in Approved with a comment that
  // told the operator to "comment a change request" — which no mode reads on
  // an Approved card — and sat behind a CI gate a conflicting head never passes.
  it("hands a conflicting PR back to In Review, ahead of the CI gate", () => {
    const conflictAt = releaseBlock.search(/if \[\[ "\$MERGEABLE" == "CONFLICTING" \]\]; then/);
    const ciGateAt = releaseBlock.indexOf('FAILING=$(pr_failing_required "$PR_VIEW")');
    assert.ok(conflictAt > 0 && ciGateAt > 0, "conflict gate or CI gate not found");
    assert.ok(conflictAt < ciGateAt, "a conflicting head gets no CI, so it must be caught first");
    const gate = releaseBlock.slice(conflictAt, conflictAt + 400);
    assert.match(gate, /conflict_handback "\$ITEM_ID" "\$ISSUE_NUM" "\$PR_NUM" .* "Approved"/);
    assert.match(gate, /continue/);
    assert.doesNotMatch(releaseBlock, /drafto-factory-merge-conflict/);
    assert.doesNotMatch(script, /comment a change request/);
  });

  // ADR-0077. #802 and #829 shared a migration version; once #829 merged,
  // #802 went red and the CI gate sent it back for an LLM pass and a second
  // Approved drag. The renumber gate now runs first and keeps the card here.
  it("runs the migration renumber gate after the label and conflict gates, before the CI gate", () => {
    const at = (s) => {
      const i = releaseBlock.indexOf(s);
      assert.ok(i !== -1, `missing: ${s}`);
      return i;
    };
    const gateAt = at('if ! migration_renumber_gate "$ISSUE_NUM" "$PR_NUM"');
    assert.ok(at('MIG_VIOLATION=$(migration_violation "$DIFF_FILES" "$PR_LABELS")') < gateAt);
    assert.ok(at('if [[ "$MERGEABLE" == "CONFLICTING" ]]; then') < gateAt);
    assert.ok(gateAt < at('FAILING=$(pr_failing_required "$PR_VIEW")'));
    assert.match(
      releaseBlock,
      /if ! migration_renumber_gate "\$ISSUE_NUM" "\$PR_NUM" "\$\(echo "\$PR_VIEW" \| jq -r '\.headRefOid \/\/ ""'\)" "Approved" "\$DIFF_FILES"; then\n\s*case "\$MIGRATION_RENUMBER_RESULT" in\n\s*renumbered\|error\) continue ;;\n\s*esac\n\s*fi/,
    );
  });

  // A renumber waits for CI on the new head; an error retries next tick, so a
  // lookup blip can't cost a second Approved drag. A plan that needs a person
  // or a spent budget goes on to the CI gate as before, which hands red CI
  // back to In Review for the fix loop's recipe, instead of parking the card
  // in Approved for good.
  it("keeps a renumbered or erroring card in Approved, and lets manual and capped go on", () => {
    const start = releaseBlock.indexOf("    # Migration renumber gate (ADR-0077)");
    const end = releaseBlock.indexOf("    # CI gate.", start);
    assert.ok(start !== -1 && end !== -1);
    for (const [result, expected] of [
      ["renumbered", "GATE 794 802 abc123 Approved x"],
      ["error", "GATE 794 802 abc123 Approved x"],
      ["manual", "GATE 794 802 abc123 Approved x\nCI GATE"],
      ["capped", "GATE 794 802 abc123 Approved x\nCI GATE"],
      ["clean", "GATE 794 802 abc123 Approved x\nCI GATE"],
    ]) {
      const snippet = `
set -euo pipefail
PR_VIEW='{"headRefOid":"abc123"}'; ISSUE_NUM=794; PR_NUM=802; DIFF_FILES=x
transition_status() { echo "MOVE $*"; }
migration_renumber_gate() { echo "GATE $*"; MIGRATION_RENUMBER_RESULT=${result}; [[ ${result} == clean ]]; }
for _once in 1; do
${releaseBlock.slice(start, end)}
  echo "CI GATE"
done`;
      const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), expected, result);
    }
  });

  describe("the BEHIND step (ADR-0077)", () => {
    const start = releaseBlock.indexOf("    # Branch-protection merge state.");
    const end = releaseBlock.indexOf(
      '    log "Issue #$ISSUE_NUM: PR #$PR_NUM green + mergeable',
      start,
    );
    assert.ok(start !== -1 && end !== -1, "BEHIND step not found");
    function step(mergeState, behind) {
      const snippet = `
set -euo pipefail
exec 3>&1
PR_VIEW='{"mergeStateStatus":"${mergeState}","headRefOid":"abc123"}'
ISSUE_NUM=794; PR_NUM=802; DRY_RUN=0; SCRIPT_DIR=/factory/scripts; STATE_FILE=/s; LOG_FILE=/dev/null
log() { echo "LOG $*"; }
issue_has_marker() { return 0; }
node() { echo "SET $4 $5" >&3; }
gh() {
  if [[ "$1 $2" == "api --method" ]]; then echo "UPDATE $*" >&3; return 0; fi
  if [[ "$1" == "api" ]]; then echo "${behind}"; return 0; fi
}
eval "$(awk '/^pr_behind_main\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
eval "$(awk '/^update_pr_branch\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
for _once in 1; do
${releaseBlock.slice(start, end)}
  echo MERGE
done`;
      const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    }

    it("updates a branch the compare API says is behind, even when GitHub reads CLEAN", () => {
      const out = step("CLEAN", "2");
      assert.match(
        out,
        /UPDATE api --method PUT .*pulls\/802\/update-branch -f expected_head_sha=abc123/,
      );
      assert.match(out, /SET branchUpdatedFrom abc123/);
      assert.doesNotMatch(out, /MERGE/);
    });

    it("still updates on BEHIND when the compare fails", () => {
      const out = step("BEHIND", "");
      assert.match(out, /UPDATE api --method PUT/);
      assert.doesNotMatch(out, /MERGE/);
    });

    it("waits on UNKNOWN instead of merging a head GitHub hasn't judged", () => {
      for (const state of ["UNKNOWN", ""]) {
        const out = step(state, "0");
        assert.doesNotMatch(out, /UPDATE|MERGE/, state);
        assert.match(out, /GitHub still computing\?\); waiting/, state);
      }
    });

    it("merges a current branch", () => {
      for (const [state, behind] of [
        ["CLEAN", "0"],
        ["UNSTABLE", ""],
        ["BLOCKED", "0"],
      ]) {
        const out = step(state, behind);
        assert.match(out, /MERGE/, state);
        assert.doesNotMatch(out, /UPDATE/, state);
      }
    });
  });

  it("squash-merges via the GitHub API PUT form, not gh pr merge", () => {
    assert.match(releaseBlock, /MERGE_ARGS=\(-f merge_method=squash\)/);
    assert.match(
      releaseBlock,
      /gh api --method PUT "repos\/JakubAnderwald\/drafto\/pulls\/\$PR_NUM\/merge" \\?\s*\n?\s*"\$\{MERGE_ARGS\[@\]\}"/,
    );
    // No actual `gh pr merge` invocation (only the explanatory comment mentions
    // it). A real call would start a line, after optional indentation.
    assert.doesNotMatch(releaseBlock, /^\s*gh pr merge/m);
  });

  it("advances the card to Released and records lastReleaseAt", () => {
    assert.match(releaseBlock, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "Released"/);
    assert.match(releaseBlock, /factory:set-issue-field "\$ISSUE_NUM" lastReleaseAt/);
  });

  it("releases the slot + worktree after a successful merge", () => {
    assert.match(releaseBlock, /release_slot_and_worktree "\$ISSUE_NUM"/);
  });

  it("is idempotent: an already-MERGED PR finishes the transition, never re-merges", () => {
    assert.match(releaseBlock, /PR_STATE" == "MERGED"/);
    assert.match(releaseBlock, /already merged; finishing Released transition/);
  });

  it("posts a merged-and-released marker comment", () => {
    assert.match(releaseBlock, /drafto-factory-released/);
  });

  it("parks (does not regress) when there is no factory PR", () => {
    assert.match(releaseBlock, /Approved but no factory PR found; leaving for the operator/);
  });

  it("honours the factory-pause kill switch", () => {
    assert.match(
      releaseBlock,
      /factory-pause,"\* \]\]; then\s*\n\s*log "Issue #\$ISSUE_NUM: skipping \(factory-pause/,
    );
  });

  it("posts a merge-failed marker and leaves the card in Approved on merge error", () => {
    assert.match(releaseBlock, /squash-merge of PR #\$PR_NUM failed; leaving card in Approved/);
    assert.match(releaseBlock, /drafto-factory-merge-failed/);
  });

  it("supports --dry-run without mutating", () => {
    assert.match(releaseBlock, /DRY-RUN: would squash-merge PR #\$PR_NUM/);
  });
});

describe("Phase-D beta dispatch (gap 1)", () => {
  it("is gated to Phase D and marker-guarded", () => {
    assert.match(
      releaseBlock,
      /if \[\[ "\$PHASE" == "D" \]\] && ! issue_has_marker "\$ISSUE_NUM" "drafto-factory-beta-dispatched"; then/,
    );
  });

  it("calls dispatch-release.mjs reusing the already-computed diff (no second pr diff)", () => {
    assert.match(
      releaseBlock,
      /printf '%s\\n' "\$DIFF_FILES" \| node "\$SCRIPT_DIR\/lib\/dispatch-release\.mjs" derive-platforms --diff-file -/,
    );
    assert.match(
      releaseBlock,
      /node "\$SCRIPT_DIR\/lib\/dispatch-release\.mjs" dispatch --platforms "\$DISPATCH_CSV"/,
    );
    // exactly one actual diff fetch (the merge-time files) — the dispatch step
    // reuses $DIFF_FILES rather than re-running `gh pr diff`
    assert.equal(releaseBlock.match(/DIFF_FILES=\$\(gh pr diff/g)?.length, 1);
  });

  it("builds desktop in its dedicated build root, not the factory checkout", () => {
    // $REPO_ROOT is live (other cards install and edit there), so the desktop
    // lane gets its own disposable root, installed like mobile's (ADR-0067).
    assert.match(releaseBlock, /--repo-root "\$REPO_ROOT" \$DESKTOP_ROOT_FLAG/);
    assert.match(releaseBlock, /DESKTOP_ROOT_FLAG="--desktop-root \$DESKTOP_ROOT_READY"/);
    const lib = readFileSync(resolve(HERE, "..", "lib", "beta-build-root.sh"), "utf8");
    assert.match(lib, /^\s*BETA_DESKTOP_ROOT="\$\{DRAFTO_DESKTOP_BUILD_ROOT:-/m);
  });

  it("prepares the desktop build root at the merged commit, or skips the lane", () => {
    // A disposable root, reset to the merge commit and installed there.
    assert.match(releaseBlock, /ensure_beta_build_root desktop "\$\{MERGE_SHA:-origin\/main\}"/);
    assert.match(
      releaseBlock,
      /DISPATCH_PLATFORMS=\$\(echo "\$DISPATCH_PLATFORMS" \| jq -c '\.desktop = false'/,
    );
    assert.match(releaseBlock, /macOS beta skipped/);
  });

  it("surfaces lanes that could not START, not just guard-refused ones", () => {
    // dispatchLanes now separates `failed` (could not start) from `skipped`
    // (a guard refused it). Reporting only `skipped` would let a post-merge
    // lane vanish silently — the exact bug family this change set closes.
    assert.match(releaseBlock, /\(\.skipped\[\]\?, \.failed\[\]\?\) \| \.id/);
    assert.match(releaseBlock, /\(\.skipped\[\]\?, \.failed\[\]\?\) \| \.reason/);
  });

  it("surfaces refused lanes in the released comment rather than dropping them", () => {
    assert.match(releaseBlock, /SKIPPED_LANES=\$\(echo "\$DISPATCH_JSON" \| jq -r/);
    assert.match(releaseBlock, /DESKTOP_SKIP_NOTE/);
  });

  it("runs after teardown and never references a production lane/workflow", () => {
    const teardownIdx = releaseBlock.indexOf('release_slot_and_worktree "$ISSUE_NUM"');
    const dispatchIdx = releaseBlock.indexOf("dispatch-release.mjs");
    assert.ok(dispatchIdx > teardownIdx, "dispatch must run after slot/worktree teardown");
    assert.doesNotMatch(
      releaseBlock,
      /production-release\.yml|release:prod:|fastlane \w+ production/,
    );
  });

  it("the released comment is phase-aware (uses BETA_NOTE, not a hardcoded line)", () => {
    assert.match(releaseBlock, /\$\{BETA_NOTE\}/);
    assert.match(releaseBlock, /drafto-factory-beta-dispatched/);
  });
});

describe("review threads gate the merge (ADR-0035)", () => {
  // The old behaviour — resolve_review_threads() force-resolving every thread
  // unread right before the merge — satisfied required_conversation_resolution
  // on paper while throwing the findings away. It must stay gone.
  it("no longer defines or calls a blind bulk-resolver", () => {
    // Matched as a definition / invocation, not as a word: the replacement
    // function's comment names the removed one on purpose, so future readers
    // know why the merge gate verifies instead of clears.
    assert.doesNotMatch(script, /^\s*resolve_review_threads\(\)\s*\{/m);
    assert.doesNotMatch(script, /\$\(\s*resolve_review_threads\b/);
    assert.doesNotMatch(script, /resolveReviewThread\(input:\{threadId:/);
  });

  it("reads thread bodies, not just ids", () => {
    assert.match(script, /fetch_review_threads\(\) \{/);
    assert.match(script, /reviewThreads\(first:100\)/);
    // Bodies + author are what make a finding answerable rather than clearable.
    assert.match(script, /comments\(first:20\)\{nodes\{body author\{login\}\}\}/);
  });

  it("refuses to merge while any thread is open", () => {
    const checkIdx = releaseBlock.indexOf('fetch_review_threads "$PR_NUM"');
    const mergeIdx = releaseBlock.indexOf("pulls/$PR_NUM/merge");
    assert.ok(
      checkIdx !== -1 && mergeIdx !== -1 && checkIdx < mergeIdx,
      "the thread check must run before the merge call",
    );
    const window = releaseBlock.slice(checkIdx, mergeIdx);
    assert.match(window, /OPEN_THREADS.*-gt 0/s, "expected a >0 open-threads guard");
    assert.match(window, /continue/, "an open thread must skip the merge");
  });

  it("fails closed when the thread query itself fails", () => {
    // A transient API error must never read as "no findings".
    const checkIdx = releaseBlock.indexOf("if ! OPEN_THREADS_JSON=$(fetch_review_threads");
    assert.ok(checkIdx !== -1, "expected the query failure to be handled explicitly");
    const window = releaseBlock.slice(checkIdx, checkIdx + 400);
    assert.match(window, /not merging this tick/);
    assert.match(window, /continue/);
  });

  it("hands the card back to --watch rather than stranding it in Approved", () => {
    // --watch is the only mode that runs the fix loop, and it only looks at In
    // Review cards. Leaving an open-threads card in Approved would strand it.
    const checkIdx = releaseBlock.indexOf('fetch_review_threads "$PR_NUM"');
    const window = releaseBlock.slice(checkIdx, checkIdx + 2600);
    assert.match(window, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "In Review"/);
  });

  it("only checks on a real merge (after the dry-run guard)", () => {
    const dryIdx = releaseBlock.indexOf("DRY-RUN: would squash-merge");
    const checkIdx = releaseBlock.indexOf('fetch_review_threads "$PR_NUM"');
    assert.ok(dryIdx !== -1 && checkIdx > dryIdx, "the check must be after the dry-run guard");
  });
});

describe("ci_required_green (extracted from factory-agent.sh)", () => {
  // Run ci_required_green with a given REQUIRED_CONTEXTS_JSON + PR_VIEW.
  function ciGreen(reqContexts, prView) {
    const snippet = `
set -euo pipefail
REQUIRED_CONTEXTS_JSON='${reqContexts}'
eval "$(awk '/^ci_required_green\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
if ci_required_green '${prView}'; then echo GREEN; else echo NOTGREEN; fi
`;
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
    return r.stdout.trim();
  }
  const view = (checks) => JSON.stringify({ statusCheckRollup: checks });

  it("passes when all required contexts are SUCCESS", () => {
    const v = view([
      { name: "Lint & Typecheck", conclusion: "SUCCESS" },
      { name: "E2E Tests", conclusion: "SUCCESS" },
    ]);
    assert.equal(ciGreen('["Lint & Typecheck","E2E Tests"]', v), "GREEN");
  });

  it("fails when a required context is missing from the rollup", () => {
    const v = view([{ name: "Lint & Typecheck", conclusion: "SUCCESS" }]);
    assert.equal(ciGreen('["Lint & Typecheck","E2E Tests"]', v), "NOTGREEN");
  });

  it("fails an EMPTY rollup even with required contexts (no checks ≠ green)", () => {
    assert.equal(ciGreen('["Lint & Typecheck"]', view([])), "NOTGREEN");
  });

  it("recognises StatusContext shape (.context/.state) for required contexts", () => {
    const v = view([{ context: "SonarCloud", state: "SUCCESS" }]);
    assert.equal(ciGreen('["SonarCloud"]', v), "GREEN");
  });

  it("with no required contexts, falls back to ≥1 success and nothing pending", () => {
    assert.equal(ciGreen("[]", view([{ name: "x", conclusion: "SUCCESS" }])), "GREEN");
    assert.equal(ciGreen("[]", view([])), "NOTGREEN");
    assert.equal(
      ciGreen(
        "[]",
        view([
          { name: "x", conclusion: "SUCCESS" },
          { name: "y", status: "IN_PROGRESS" },
        ]),
      ),
      "NOTGREEN",
    );
  });
});

describe("issue_has_marker fail-closed guard", () => {
  it("returns early (suppresses re-posting) on an empty/failed comment fetch", () => {
    assert.match(
      script,
      /if ! comments=\$\(fetch_issue_comments .* \|\| \[\[ -z "\$comments" \]\]; then\s*\n\s*return 0/,
    );
  });
});

describe("slot teardown helper", () => {
  it("resolves only the slot the issue actually holds (safe for teardown)", () => {
    assert.match(script, /slot_held_by_issue\(\) \{/);
    assert.match(script, /release_slot_and_worktree\(\) \{/);
  });

  it("tears down through the PR-gated helper, never a raw --delete-branch", () => {
    // The teardown must go through remove_worktree_for, which refuses to delete
    // a branch that still backs a live PR. Asserting the old literal call
    // string would pass by accident, since that string survives inside the
    // helper — so assert the guard instead.
    assert.match(script, /remove_worktree_for\(\) \{/);
    assert.match(script, /branch_keep_reason\(\) \{/);
    assert.match(script, /remove_worktree_for "\$issue_num" "\$known_state"/);
    const deleteBranchCalls = script.match(/worktree-cli\.mjs" remove[^\n]*--delete-branch/g) ?? [];
    assert.equal(
      deleteBranchCalls.length,
      1,
      "exactly one --delete-branch call should remain, inside remove_worktree_for",
    );
  });

  it("skips the PR lookup when the caller already knows the PR merged", () => {
    // --release only tears down after confirming MERGED, so it passes the state
    // through rather than paying for another gh call.
    const releaseCalls = releaseBlock.match(/release_slot_and_worktree "\$ISSUE_NUM"[^\n]*/g) ?? [];
    assert.equal(releaseCalls.length, 3, "expected the three --release teardown sites");
    for (const call of releaseCalls) {
      assert.match(call, /"MERGED"/, `--release teardown should pass MERGED: ${call}`);
    }
  });
});

describe("launchd loop wrapper", () => {
  const loop = readFileSync(loopPath, "utf8");
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", loopPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
  it("invokes --release first each tick, before any other mode (ADR-0068)", () => {
    assert.match(loop, /--release\s+--phase "\$PHASE"/);
    // Anchor on the actual invocations, not the header comments that also
    // mention the modes.
    const releaseIdx = loop.indexOf('/bin/bash "$AGENT" --release');
    const firstMode = loop.indexOf('/bin/bash "$AGENT" --');
    assert.ok(releaseIdx !== -1 && releaseIdx === firstMode, "--release should run first");
  });
  it("collects finished CodeRabbit CLI reviews before it merges anything", () => {
    // --release now runs before --watch, whose housekeeping used to post a
    // finished run's findings first. Without its own call, a PR could merge and
    // the findings would be discarded for a closed PR.
    const callIdx = releaseBlock.indexOf(
      'if [[ "$APPROVED_COUNT" -gt 0 ]]; then cr_cli_housekeeping; fi',
    );
    const loopIdx = releaseBlock.indexOf("for ((IDX=0; IDX<APPROVED_COUNT; IDX++))");
    assert.ok(callIdx !== -1 && loopIdx !== -1 && callIdx < loopIdx);
  });

  it("self-updates to origin/main before running any mode", () => {
    // The factory must only ever execute reviewed, CI-gated code. The sync
    // must happen before the agent invocations, and inside the mutex (after the
    // lock is acquired) so two ticks can't reset the tree concurrently.
    assert.match(loop, /git -C "\$SCRIPT_DIR" fetch --quiet origin main/);
    assert.match(loop, /git -C "\$SCRIPT_DIR" reset --hard --quiet origin\/main/);
    const lockIdx = loop.indexOf('echo "$$" > "$LOCK_PID_FILE"');
    const fetchIdx = loop.indexOf("fetch --quiet origin main");
    const syncIdx = loop.indexOf("reset --hard --quiet origin/main");
    const firstMode = loop.indexOf('/bin/bash "$AGENT" --');
    assert.ok(lockIdx !== -1 && fetchIdx > lockIdx, "fetch must run after lock acquisition");
    assert.ok(lockIdx !== -1 && syncIdx > lockIdx, "sync must run after lock acquisition");
    assert.ok(
      fetchIdx < firstMode && syncIdx < firstMode,
      "sync must run before the first agent mode",
    );
  });

  it("is escapable via FACTORY_AUTOPULL=0 and re-execs on its own change", () => {
    // Assert fetch/reset are actually gated by the FACTORY_AUTOPULL guard, not
    // merely that the token appears somewhere in the file.
    assert.match(
      loop,
      /if \[\[ "\$\{FACTORY_AUTOPULL:-1\}" == "1" \]\]; then[\s\S]*git -C "\$SCRIPT_DIR" fetch --quiet origin main[\s\S]*git -C "\$SCRIPT_DIR" reset --hard --quiet origin\/main[\s\S]*fi/,
    );
    // Re-exec guard: prevents running a stale wrapper after it changes in the
    // sync, with an env guard against an infinite re-exec loop.
    assert.match(loop, /FACTORY_LOOP_REEXECED/);
    assert.match(loop, /exec \/bin\/bash "\$\{BASH_SOURCE\[0\]\}"/);
  });
});
