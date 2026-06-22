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
    assert.match(releaseBlock, /FAILING=\$\(echo "\$PR_VIEW" \| jq/);
    assert.match(releaseBlock, /has \$FAILING failing check\(s\); not merging/);
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
    assert.match(releaseBlock, /pulls\/\$PR_NUM\/update-branch/);
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

  it("only merges a MERGEABLE PR and parks conflicts", () => {
    assert.match(releaseBlock, /MERGEABLE=\$\(echo "\$PR_VIEW" \| jq -r '\.mergeable/);
    assert.match(releaseBlock, /drafto-factory-merge-conflict/);
  });

  it("squash-merges via the GitHub API PUT form, not gh pr merge", () => {
    assert.match(
      releaseBlock,
      /gh api --method PUT "repos\/JakubAnderwald\/drafto\/pulls\/\$PR_NUM\/merge" \\?\s*\n?\s*-f merge_method=squash/,
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
      /printf '%s\\n' "\$DIFF_FILES" \| node "\$SCRIPT_DIR\/lib\/dispatch-release\.mjs" dispatch --diff-file - --repo-root "\$REPO_ROOT"/,
    );
    // exactly one actual diff fetch (the merge-time files) — the dispatch step
    // reuses $DIFF_FILES rather than re-running `gh pr diff`
    assert.equal(releaseBlock.match(/DIFF_FILES=\$\(gh pr diff/g)?.length, 1);
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

describe("review-thread resolution at ship (gap 2)", () => {
  it("defines resolve_review_threads using GraphQL reviewThreads + resolveReviewThread", () => {
    assert.match(script, /resolve_review_threads\(\) \{/);
    assert.match(script, /reviewThreads\(first:100\)/);
    assert.match(script, /resolveReviewThread\(input:\{threadId:/);
  });

  it("resolves threads before merging (engages conversation-resolution, not silent bypass)", () => {
    assert.match(releaseBlock, /RESOLVED_THREADS=\$\(resolve_review_threads "\$PR_NUM"\)/);
    const resolveIdx = releaseBlock.indexOf('resolve_review_threads "$PR_NUM"');
    const mergeIdx = releaseBlock.indexOf("pulls/$PR_NUM/merge");
    assert.ok(
      resolveIdx !== -1 && mergeIdx !== -1 && resolveIdx < mergeIdx,
      "resolve_review_threads must run before the merge call",
    );
  });

  it("only resolves on a real merge (after the dry-run guard)", () => {
    const dryIdx = releaseBlock.indexOf("DRY-RUN: would squash-merge");
    const resolveIdx = releaseBlock.indexOf('resolve_review_threads "$PR_NUM"');
    assert.ok(dryIdx !== -1 && resolveIdx > dryIdx, "resolve must be after the dry-run guard");
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
    assert.match(
      script,
      /worktree-cli\.mjs" remove --issue "\$issue_num" --root "\$REPO_ROOT" --force --delete-branch/,
    );
  });
});

describe("launchd loop wrapper", () => {
  const loop = readFileSync(loopPath, "utf8");
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", loopPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
  it("invokes --release after --watch each tick", () => {
    assert.match(loop, /--watch\s+--phase "\$PHASE"/);
    assert.match(loop, /--release\s+--phase "\$PHASE"/);
    // Anchor on the actual invocations, not the header comments that also
    // mention --watch / --release.
    const watchIdx = loop.indexOf('/bin/bash "$AGENT" --watch');
    const releaseIdx = loop.indexOf('/bin/bash "$AGENT" --release');
    assert.ok(releaseIdx > watchIdx, "--release should run after --watch");
  });
});
