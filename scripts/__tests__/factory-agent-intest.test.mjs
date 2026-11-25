import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  utimesSync,
  existsSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildBody } from "../comment-intest-build.mjs";

// Tests for the In Review → In Test hand-off: the stage that writes the human
// test scenario and posts it as the In Test comment.
//
// The bug that motivated it (#463 / PR #591): a mobile+desktop-only PR advanced
// to In Test with a hardcoded "the Vercel preview is live" comment, pointing the
// tester at a web preview that exercised none of the change — and no scenario at
// all. The assertions below pin the properties that fix it and, just as
// importantly, the ones that keep the state machine safe when the scenario
// writer fails.

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");
// Build-root helpers (ensure/claim/release_beta_build_root, copy_worktree_env,
// …) and the root defaults moved to the lib both schedulers source.
const libPath = resolve(HERE, "..", "lib", "beta-build-root.sh");
const lib = readFileSync(libPath, "utf8");

// Slice the In Review → In Test advance out of the script so structural
// assertions can't be satisfied by an incidental match elsewhere.
const advanceBlock = (() => {
  const start = script.indexOf("# ── 2. In Review → In Test ──");
  assert.ok(start !== -1, "could not find the In Review → In Test block");
  const end = script.indexOf("# ── In Test feedback sweep", start);
  assert.ok(end !== -1, "could not find the end of the advance block");
  return script.slice(start, end);
})();

const sweepBlock = (() => {
  const start = script.indexOf("# ── In Test feedback sweep");
  assert.ok(start !== -1, "could not find the In Test feedback sweep");
  const end = script.indexOf("# ── --release mode", start);
  assert.ok(end !== -1, "could not find the end of the sweep");
  return script.slice(start, end);
})();

// The intest_handoff / intest_fallback_comment function bodies.
function fnBody(name, src = script) {
  const re = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m");
  const m = src.match(re);
  assert.ok(m, `could not find ${name}()`);
  return m[0];
}

// The PATH launchd gives the factory: no /usr/sbin or /sbin. Filtered rather
// than replaced, so node, jq, ps and awk still resolve.
function pathWithoutSbin() {
  return (process.env.PATH ?? "")
    .split(":")
    .filter((p) => !["/usr/sbin", "/sbin"].includes(p.replace(/\/+$/, "")))
    .join(":");
}

describe("factory-agent.sh syntax", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", agentPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("In Test advance — platform awareness", () => {
  it("derives the platforms from the PR diff, not the issue's checkboxes", () => {
    assert.match(
      advanceBlock,
      /INTEST_DIFF_FILES=\$\(gh pr diff "\$PR_NUM" --repo JakubAnderwald\/drafto --name-only/,
    );
    assert.match(advanceBlock, /dispatch-release\.mjs" derive-platforms --diff-file -/);
  });

  it("requires a Vercel preview only when apps/web is touched", () => {
    // Native-only PRs used to deadlock behind a preview URL that tested nothing.
    assert.match(advanceBlock, /WEB_TOUCHED=\$\(echo "\$INTEST_PLATFORMS" \| jq -r '\.web/);
    assert.match(
      advanceBlock,
      /if \[\[ "\$WEB_TOUCHED" == "true" && -z "\$PREVIEW_URL" \]\]; then/,
    );
  });

  it("no longer claims a Vercel preview unconditionally", () => {
    assert.ok(
      !script.includes("the Vercel preview is live"),
      "the hardcoded preview line must be gone — it was the #463 bug",
    );
  });

  it("reads headRefOid from the existing pr view (no extra API call)", () => {
    assert.match(advanceBlock, /--json state,mergeable,statusCheckRollup,comments,headRefOid/);
    assert.match(advanceBlock, /HEAD_SHA=\$\(echo "\$PR_VIEW" \| jq -r '\.headRefOid/);
  });
});

describe("In Test advance — ordering and safety", () => {
  it("advances the card BEFORE invoking the scenario writer", () => {
    // The transition is the state machine; the comment is commentary. A card must
    // never be stuck in In Review because a comment couldn't be written.
    const transitionIdx = advanceBlock.indexOf(
      'transition_status "$ITEM_ID" "$ISSUE_NUM" "In Test"',
    );
    assert.ok(transitionIdx !== -1, "In Test transition not found");
    // The live path only — the earlier intest_handoff call is inside the
    // --dry-run branch, which returns before any transition happens.
    const livePath = advanceBlock.slice(transitionIdx);
    assert.match(livePath, /intest_handoff/, "the live path must hand off after transitioning");
    const dryRunIdx = advanceBlock.indexOf('DRY_RUN" -eq 1');
    assert.ok(
      dryRunIdx !== -1 && dryRunIdx < transitionIdx,
      "the dry-run guard must precede the transition",
    );
  });

  it("never lets the hand-off fail the tick", () => {
    assert.match(advanceBlock, /intest_handoff [^\n]*\|\| true/);
  });

  it("still gates the advance on required-green CI", () => {
    assert.match(advanceBlock, /if ! ci_required_green "\$PR_VIEW"; then/);
  });
});

describe("intest_handoff — failure degrades, never escalates", () => {
  const body = fnBody("intest_handoff");

  it("never bumps the retry budget (commentary, not code)", () => {
    // Burning the budget here would march a green, testable card toward Blocked.
    assert.ok(!body.includes("factory:bump-attempts"), "the scenario stage must not bump attempts");
  });

  it("never transitions the card (it is already In Test)", () => {
    assert.ok(!body.includes("transition_status"), "the scenario stage must not move the card");
  });

  it("falls back to a deterministic comment on timeout, error, or no marker", () => {
    // One fallback per failure path: missing prompt, issue fetch, bundle build,
    // session limit, and no scenario for the head after the run. A timeout or
    // an error exit goes through that last check too (ADR-0082): the run may
    // have posted before it died.
    const calls = body.match(/intest_fallback_comment/g) || [];
    assert.ok(calls.length >= 5, `expected a fallback on every failure path, got ${calls.length}`);
    assert.match(body, /exit_code -eq 124/);
    assert.match(body, /check_session_limit/);
    assert.match(body, /action="exit-\$exit_code"/);
  });

  it("forwards its coverage-note argument to every fallback and to the bundle", () => {
    assert.match(body, /local cr_note="\$\{10:-\}"/);
    const calls = body.match(/intest_fallback_comment [^\n]*/g) || [];
    assert.ok(calls.length >= 5);
    for (const call of calls) {
      assert.match(call, /"\$\{beta_json:-\}" "\$cr_note"$/, `fallback without the note: ${call}`);
    }
    assert.match(body, /"\$head_sha" "\$comments_json" "\$cr_note" "\$scenario_cfg"\); then/);
    const bundle = fnBody("build_intest_bundle");
    assert.match(bundle, /local cr_coverage_note="\$\{12:-\}"/);
    assert.match(bundle, /--arg crCoverageNote "\$cr_coverage_note"/);
    assert.match(bundle, /crCoverageNote: \$crCoverageNote,/);
  });

  it("trusts the posted comment for exactly this head over the model's directive line", () => {
    // Every older scenario carries drafto-factory-test-scenario too, so a run
    // that exited 0 without posting used to count as posted (ADR-0082).
    assert.doesNotMatch(body, /issue_has_marker "\$issue_num" "drafto-factory-test-scenario"/);
    assert.match(body, /posted=\$\(scenario_comment_state "\$comments_after" "\$head_sha"\)/);
    const state = fnBody("scenario_comment_state");
    assert.match(state, /scenarioCommentState/);
  });

  it("records the head SHA on EVERY path that posts a comment", () => {
    // The watch refresh re-fires the hand-off whenever intestCommentSha !=
    // headRefOid, so a posting path that returns without recording would
    // re-post the same comment every 5-minute tick — issue spam.
    const posts = (body.match(/intest_fallback_comment/g) || []).length;
    const records = (body.match(/intest_record_comment_sha/g) || []).length;
    assert.ok(posts >= 5, `expected a fallback on every failure path, got ${posts}`);
    // Four early-return paths pair 1:1 with a recorder; the fifth (no scenario
    // for the head after the run) falls through to the recorder at the tail,
    // which also covers the success path. The one extra recorder is the skip
    // for a head that already has its scenario (ADR-0082), which posts nothing
    // but must still stop the sweep re-firing.
    assert.equal(
      records,
      posts + 1,
      `every posting path must record the SHA (${posts} posts vs ${records} records)`,
    );
    // No `return 0` may sit between a fallback post and its recorder.
    for (const seg of body.split("intest_fallback_comment").slice(1)) {
      const window = seg.split("\n").slice(0, 3).join("\n");
      if (/return 0/.test(window)) {
        assert.match(
          window,
          /intest_record_comment_sha/,
          "a posting path returns without recording",
        );
      }
    }
  });

  it("the recorder writes intestCommentSha and no-ops on an empty SHA", () => {
    const rec = fnBody("intest_record_comment_sha");
    assert.match(rec, /intestCommentSha "\$head_sha"/);
    assert.match(rec, /-n "\$head_sha" \]\] \|\| return 0/);
  });

  it("runs read-only in the factory checkout at the plan effort", () => {
    assert.match(body, /cd "\$REPO_ROOT"/);
    assert.match(body, /CLAUDE_CALL_TIMEOUT_SEC="\$INTEST_TIMEOUT_SEC"/);
    assert.match(body, /--effort "\$FACTORY_PLAN_EFFORT"/);
    // No worktree, no slot, no install for this stage.
    assert.ok(!body.includes("worktree-cli.mjs"), "the scenario stage needs no worktree");
    assert.ok(!body.includes("run_pnpm_install"), "the scenario stage needs no install");
  });

  it("prints the bundle to stdout only under --dry-run (bundles carry PII)", () => {
    assert.match(body, /DRY_RUN" -eq 1/);
    const dryRunSection = body.slice(body.indexOf("DRY-RUN: In Test bundle"));
    assert.match(dryRunSection.slice(0, 400), /echo "\$bundle"/);
    assert.equal(body.split('echo "$bundle"').length - 1, 1, "the bundle is printed once");
  });
});

describe("intest_handoff — the scenario writer's claude call (extracted, real bash)", () => {
  // The model knob block (ADR-0080, ADR-0101), so a run with `model` set goes
  // through the same validation the factory does at startup.
  const modelKnobs = script.match(/^MODEL_KNOB_RE=[\s\S]*?^ {2}FACTORY_INTEST_MODEL=""\nfi\n/m);
  const SHA = "c".repeat(40);

  // Runs the REAL intest_handoff with its collaborators stubbed, and returns
  // the argv run-claude.mjs got (NUL-separated, since the prompt is multi-line).
  // `model` undefined: FACTORY_INTEST_MODEL is unset altogether and the knob
  // block left out, so the function itself must cope under `set -u`.
  // `factoryModel` sets FACTORY_MODEL (unset otherwise).
  function runHandoff({ model, factoryModel } = {}) {
    assert.ok(modelKnobs, "model knob block not found");
    const dir = mkdtempSync(join(tmpdir(), "intest-handoff-"));
    const argsFile = join(dir, "args.bin");
    const events = join(dir, "events.txt");
    const prompt = join(dir, "prompt.md");
    writeFileSync(prompt, "# In Test scenario prompt\n");
    const snippet = `set -euo pipefail
${model === undefined ? "" : modelKnobs[0]}
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
SCRIPT_DIR=${JSON.stringify(resolve(HERE, ".."))}
REPO_ROOT=${JSON.stringify(dir)}
INTEST_PROMPT_FILE=${JSON.stringify(prompt)}
INTEST_TIMEOUT_SEC=600
FACTORY_PLAN_EFFORT=xhigh
DRY_RUN=0
log() { echo "[log] $*"; }
fetch_issue_record() { echo '{"number":12}'; }
fetch_issue_comments() { echo '[]'; }
extract_plan_comment() { echo null; }
gh() { echo "diff --git a/apps/web/x.ts b/apps/web/x.ts"; }
build_intest_bundle() { echo '{"bundle":true}'; }
check_session_limit() { return 1; }
pause_for_session_limit() { :; }
# No scenario for the head before the run (the writer runs), one after it.
scenario_comment_state() {
  if [[ -f ${JSON.stringify(join(dir, "asked"))} ]]; then echo scenario; else : >${JSON.stringify(join(dir, "asked"))}; echo none; fi
}
intest_fallback_comment() { echo "fallback" >>${JSON.stringify(events)}; }
intest_record_comment_sha() { echo "recorded $2" >>${JSON.stringify(events)}; }
node() {
  case "$1" in
    */run-claude.mjs)
      shift
      printf '%s\\0' "$@" >${JSON.stringify(argsFile)}
      echo "pwd:$(pwd) timeout:$CLAUDE_CALL_TIMEOUT_SEC" >>${JSON.stringify(events)}
      echo "issue=12 action=commented comment=https://github.com/x"
      return 0 ;;
    *) command node "$@" ;;
  esac
}
${fnBody("intest_reused_builds")}
${fnBody("intest_handoff")}
intest_handoff 12 34 '{}' https://drafto-x.vercel.app '' ${SHA} 'apps/web/x.ts' web '' ''
echo "rc=$?"
`;
    const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir };
    if (model !== undefined) env.FACTORY_INTEST_MODEL = model;
    if (factoryModel !== undefined) env.FACTORY_MODEL = factoryModel;
    const r = spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8", env });
    const args = existsSync(argsFile)
      ? readFileSync(argsFile, "utf8").split("\0").slice(0, -1)
      : null;
    const log = existsSync(events) ? readFileSync(events, "utf8") : "";
    rmSync(dir, { recursive: true, force: true });
    return { r, args, events: log, dir };
  }

  it("passes FACTORY_MODEL when FACTORY_INTEST_MODEL is unset or empty (ADR-0101)", () => {
    for (const [model, factoryModel, want] of [
      [undefined, undefined, "opus[1m]"],
      ["", undefined, "opus[1m]"],
      ["", "opus", "opus"],
    ]) {
      const { r, args, events, dir } = runHandoff({ model, factoryModel });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^rc=0$/m);
      assert.ok(args, "run-claude.mjs was not called");
      assert.deepEqual(args.slice(2), [
        "--dangerously-skip-permissions",
        "--effort",
        "xhigh",
        "--no-chrome",
        "--strict-mcp-config",
        "--model",
        want,
      ]);
      assert.equal(args[0], "-p");
      assert.match(args[1], /# In Test scenario prompt[\s\S]*"bundle":true/);
      assert.ok(
        r.stdout.includes(`In Test scenario, cap 600s, effort=xhigh, model=${want})`),
        r.stdout,
      );
      assert.match(events, new RegExp(`pwd:${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(events, /timeout:600/);
      assert.match(events, new RegExp(`recorded ${SHA}`));
      assert.doesNotMatch(events, /fallback/);
      assert.equal(r.stderr, "");
    }
  });

  it("passes --model right after --strict-mcp-config when FACTORY_INTEST_MODEL is set", () => {
    const { r, args } = runHandoff({ model: "claude-sonnet-5-5" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(args, "run-claude.mjs was not called");
    assert.deepEqual(args.slice(2), [
      "--dangerously-skip-permissions",
      "--effort",
      "xhigh",
      "--no-chrome",
      "--strict-mcp-config",
      "--model",
      "claude-sonnet-5-5",
    ]);
    assert.match(r.stdout, /effort=xhigh, model=claude-sonnet-5-5\)/);
  });

  it("drops an invalid FACTORY_INTEST_MODEL at startup, so it never reaches the call", () => {
    const { r, args } = runHandoff({ model: "--chrome" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /invalid FACTORY_INTEST_MODEL='--chrome'/);
    assert.ok(args, "run-claude.mjs was not called");
    assert.ok(!args.includes("--chrome"));
    // FACTORY_MODEL instead.
    assert.deepEqual(args.slice(-3), ["--strict-mcp-config", "--model", "opus[1m]"]);
  });
});

describe("intest_fallback_comment — always usable", () => {
  const body = fnBody("intest_fallback_comment");

  it("carries both markers so bash and the feedback sweep agree", () => {
    assert.match(body, /<!-- drafto-factory-in-test -->/);
    assert.match(body, /<!-- drafto-factory-test-scenario -->/);
  });

  it("shows the preview only for a web change", () => {
    assert.match(body, /if \[\[ "\$web" == "true" && -n "\$preview_url" \]\]; then/);
  });

  it("gives per-platform local build instructions, macOS from a worktree", () => {
    assert.match(body, /if \[\[ "\$mobile" == "true" \]\]; then/);
    assert.match(body, /if \[\[ "\$desktop" == "true" \]\]; then/);
    // ADR-0067: macOS installs and builds from a worktree like mobile, but
    // never in a factory build root, which the factory hard-resets.
    assert.match(
      body,
      /cd apps\/desktop && bundle install && DRAFTO_INTEST_ISSUE=\$issue_num pnpm release:beta/,
    );
    assert.match(body, /\*\*never\*\* build in a factory build root/);
  });

  it("never tells anyone to check the PR branch out in the primary checkout", () => {
    // factory-intest-prompt.md forbids it: /Users/jakub/code/drafto is the
    // operator's working tree. The macOS fallback points at the runbook's
    // pre-merge beta section, or a fresh worktree of the branch.
    assert.doesNotMatch(body, /git (?:-C \S+ )?(?:checkout|switch)\b[^\n]*factory\/issue-/);
    assert.match(body, /factory-runbook\.md#pre-merge-beta-dispatch-in-test/);
    // The primary checkout's path is configurable; the warning names the configured one.
    assert.match(body, /\$\{PRIMARY_CHECKOUT_ROOT:-\/Users\/jakub\/code\/drafto\}/);
    assert.doesNotMatch(body, /fossil/i);
  });

  it("names the gate's reason when the macOS beta was skipped", () => {
    // More than one switch gates the lane (FACTORY_INTEST_BETA, the phase, free
    // disk, FACTORY_INTEST_BETA_DESKTOP), so the reason is what's actionable.
    assert.match(body, /select\(\.id == "desktop"\) \| \.reason/);
    assert.match(body, /\$\{desktop_skip:\+/);
  });

  it("surfaces advisory reds", () => {
    assert.match(body, /Advisory \(non-required\) checks are not green: \$advisory/);
  });

  it("takes the CodeRabbit coverage note as its own argument, never out of $advisory", () => {
    // ADR-0036: the note is not a check. Rendering is covered behaviourally in
    // factory-agent-cr-cli.test.mjs; this pins the signature every caller uses.
    assert.match(body, /local beta="\$\{7:-\}" cr_note="\$\{8:-\}"/);
    assert.doesNotMatch(body, /CodeRabbit did not review|CodeRabbit coverage of/);
  });
});

describe("In Test sweep — dispatch and scenario are independent", () => {
  it("evaluates beta dispatch on every tick, not only when the scenario is stale", () => {
    // Regression: dispatch used to live INSIDE intest_handoff, which the sweep
    // gated on intestCommentSha != headRefOid. A lane blocked by a transient
    // condition (low disk, knob off) was therefore never retried — once the
    // scenario existed for that SHA the hand-off never ran again. Observed live
    // on #463: freeing disk changed nothing until the key was cleared by hand.
    const dispatchIdx = sweepBlock.indexOf("intest_dispatch_betas");
    const staleGuardIdx = sweepBlock.indexOf('"$INTEST_HEAD_SHA" != "$SCENARIO_SHA"');
    assert.ok(dispatchIdx !== -1, "sweep must dispatch");
    assert.ok(staleGuardIdx !== -1, "sweep must still gate the scenario on its own key");
    assert.ok(
      dispatchIdx < staleGuardIdx,
      "dispatch must be evaluated BEFORE (and outside) the scenario-staleness guard",
    );
  });

  it("passes the dispatch result into the scenario writer rather than re-dispatching", () => {
    assert.match(sweepBlock, /intest_handoff[\s\S]{0,200}"\$INTEST_BETA"/);
    const handoff = fnBody("intest_handoff");
    // No *call* — a comment naming the function is fine.
    assert.ok(
      !/\$\(\s*intest_dispatch_betas/.test(handoff),
      "the scenario writer must not dispatch — it receives the result",
    );
  });

  it("still keys each half on its own recorded SHA", () => {
    assert.match(sweepBlock, /\.intestCommentSha/);
    const dispatch = fnBody("intest_dispatch_betas");
    assert.match(dispatch, /\.intestBetaSha/);
  });
});

describe("In Test sweep — scenario backfill and refresh", () => {
  it("keys the refresh on the PR head SHA, not a monotonic marker", () => {
    // Idempotent within a SHA (no 5-minute comment spam) but re-armed by new
    // commits, so an In Test → revision → In Test round trip gets a new scenario.
    assert.match(
      sweepBlock,
      /SCENARIO_SHA=\$\(echo "\$ISSUE_STATE_JSON" \| jq -r '\.intestCommentSha/,
    );
    assert.match(sweepBlock, /"\$INTEST_HEAD_SHA" != "\$SCENARIO_SHA"/);
  });

  it("backfills a card that reached In Test before this stage existed", () => {
    // Empty recorded SHA != a real head SHA, so the same branch handles backfill.
    assert.match(sweepBlock, /have '\$\{SCENARIO_SHA:-none\}'/);
  });

  it("re-reads the comments after posting so the feedback baseline is not stale", () => {
    const handoffIdx = sweepBlock.indexOf("intest_handoff");
    const refetchIdx = sweepBlock.indexOf("COMMENTS_JSON=$(fetch_issue_comments", handoffIdx);
    const hwmIdx = sweepBlock.indexOf('\n    HWM=$(echo "$ISSUE_STATE_JSON"');
    assert.ok(
      handoffIdx !== -1 && refetchIdx > handoffIdx,
      "comments must be re-read after posting",
    );
    assert.ok(hwmIdx > handoffIdx, "the HWM check must come after the backfill");
  });

  it("still rolls a card back to In Progress on real feedback", () => {
    assert.match(sweepBlock, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "In Progress"/);
    assert.match(sweepBlock, /drafto-factory-revising/);
  });
});

// ADR-0078: the sweep ties migration-approved to the SQL too, so a voided label
// comes off before the card is dragged to Approved.
describe("In Test sweep — migration approval", () => {
  const at = (s) => {
    const i = sweepBlock.indexOf(s);
    assert.ok(i !== -1, `missing: ${s}`);
    return i;
  };

  it("reads the labels in the PR view it already fetches, not in a call of its own", () => {
    assert.match(sweepBlock, /--json statusCheckRollup,comments,headRefOid,mergeable,labels/);
    assert.equal(sweepBlock.split("gh pr view ").length - 1, 1);
    assert.match(
      sweepBlock,
      /if INTEST_PR_LABELS=\$\(jq -er '\.labels \| map\(\.name\) \| join\(","\)' <<<"\$\{INTEST_PR_VIEW:-\}" 2>\/dev\/null\); then/,
    );
  });

  it("vouches with the sweep's head and diff, after the conflict hand-back and before any beta", () => {
    const vouch = at(
      'migration_approval_vouch "$ISSUE_NUM" "$INTEST_PR_NUM" "$INTEST_HEAD_SHA" \\\n            "$INTEST_PR_LABELS" "$INTEST_FILES"',
    );
    assert.ok(at("INTEST_FILES=$(gh pr diff") < vouch);
    assert.ok(at('conflict_handback "$ITEM_ID" "$ISSUE_NUM" "$INTEST_PR_NUM"') < vouch);
    assert.ok(vouch < at("intest_check_lane_outcomes"));
    assert.ok(vouch < at("intest_dispatch_betas"));
    assert.equal(sweepBlock.split("migration_approval_vouch ").length - 1, 1);
  });

  it("skips it when the view has no labels, instead of reading them as removed", () => {
    const start = at("        if INTEST_PR_LABELS=");
    const end = sweepBlock.indexOf("        fi\n", start) + "        fi\n".length;
    const run = (view) => {
      const r = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
ISSUE_NUM=794; INTEST_PR_NUM=802; INTEST_HEAD_SHA=abc; INTEST_FILES=supabase/migrations/x.sql
INTEST_PR_VIEW=${JSON.stringify(view)}
migration_approval_vouch() { echo "VOUCH $1 $2 $3 [$4] $5"; }
${sweepBlock.slice(start, end)}`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(
      run('{"labels":[{"name":"status:in-test"},{"name":"migration-approved"}]}'),
      "VOUCH 794 802 abc [status:in-test,migration-approved] supabase/migrations/x.sql",
    );
    assert.equal(run('{"labels":[]}'), "VOUCH 794 802 abc [] supabase/migrations/x.sql");
    assert.equal(run('{"headRefOid":"abc"}'), "");
    assert.equal(run(""), "");
  });
});

describe("intest_beta_gate (extracted from factory-agent.sh)", () => {
  // Exercise the real function with the knob globals set per case. free_disk_gb
  // is stubbed so the matrix doesn't depend on the machine's actual free space.
  const gate = ({
    platforms,
    beta = "1",
    desktop = "1",
    phase = "C",
    freeGb = "50",
    minGb = "3",
  }) => {
    const snippet = `
set -euo pipefail
eval "$(awk '/^intest_beta_gate\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
free_disk_gb() { echo "${freeGb}"; }
FACTORY_INTEST_BETA=${beta}
FACTORY_INTEST_BETA_DESKTOP=${desktop}
PHASE=${phase}
FACTORY_MIN_FREE_DISK_GB=${minGb}
intest_beta_gate ${JSON.stringify(platforms)}
`;
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const native = '{"mobile":true,"desktop":true,"web":false}';

  it("dispatches nothing when the master knob is off", () => {
    const out = gate({ platforms: native, beta: "0" });
    assert.match(out, /^lanes= /);
    assert.match(out, /mobile:FACTORY_INTEST_BETA=0/);
    assert.match(out, /desktop:FACTORY_INTEST_BETA=0/);
  });

  it("dispatches mobile only while the desktop knob is off (desktop root not yet validated)", () => {
    const out = gate({ platforms: native, beta: "1", desktop: "0" });
    assert.match(out, /lanes=mobile /);
    assert.match(out, /desktop:FACTORY_INTEST_BETA_DESKTOP=0/);
  });

  it("dispatches both when both knobs are on", () => {
    const out = gate({ platforms: native, beta: "1", desktop: "1" });
    assert.match(out, /lanes=mobile,desktop/);
    assert.match(out, /skipped=$/);
  });

  it("dispatches nothing at Phase B (web-only by contract)", () => {
    const out = gate({ platforms: native, phase: "B" });
    assert.match(out, /^lanes= /);
    assert.match(out, /mobile:phase-B/);
  });

  it("skips on low disk rather than dying mid-build", () => {
    const out = gate({ platforms: native, freeGb: "2", minGb: "3" });
    assert.match(out, /^lanes= /);
    assert.match(out, /mobile:low-disk-2GB/);
  });

  it("is a silent no-op for a web-only change", () => {
    const out = gate({ platforms: '{"mobile":false,"desktop":false,"web":true}' });
    assert.equal(out, "lanes= skipped=");
  });

  it("dispatches only the platform the diff touched", () => {
    const out = gate({ platforms: '{"mobile":true,"desktop":false,"web":false}' });
    assert.match(out, /lanes=mobile/);
    assert.ok(!out.includes("desktop"), "must not dispatch a platform the diff didn't touch");
  });
});

describe("ensure_beta_build_root — working-tree safety", () => {
  const body = fnBody("ensure_beta_build_root", lib);

  it("refuses to use the factory checkout or the primary checkout as a build root", () => {
    // It hard-resets and cleans the root. The primary checkout IS the
    // operator's working tree, so resetting it would destroy any uncommitted
    // edits there.
    assert.match(body, /canon_root" == "\$canon_repo" \|\| "\$canon_root" == "\$canon_primary"/);
    assert.match(body, /refusing to use \$root as a \$platform beta build root/);
    assert.match(body, /return 1/);
  });

  it("resolves paths before comparing them (a symlink must not defeat the guard)", () => {
    assert.match(body, /pwd -P/);
  });

  it("normalises modes so the tree it hands the build is not owner-only", () => {
    // The factory runs at umask 077, so git/pnpm/CocoaPods write mode 600 here.
    // Those files are copied verbatim into the .app, and App Store Connect
    // rejects the pkg with ITMS-90255. Three macOS uploads died this way on #463.
    assert.match(body, /-exec chmod go\+rX \{\} \+/);
  });

  it("normalises AFTER the install, not before it", () => {
    // pnpm/bundle create files too; chmod-ing first would leave the newest — and
    // largest — set of files still owner-only.
    const chmodIdx = body.indexOf("chmod go+rX");
    const installIdx = body.indexOf("run_pnpm_install");
    assert.ok(installIdx !== -1 && chmodIdx > installIdx, "chmod must run after the installs");
  });

  it("PRUNES credentials from the traversal rather than widening then restoring", () => {
    // A build root is ~100k files. "chmod -R, then put the secrets back" leaves
    // them world-readable for the length of the walk — a window, on a machine
    // that also runs unattended agents. They must never be widened at all.
    const pruneIdx = body.indexOf("-prune");
    const widenIdx = body.indexOf("chmod go+rX");
    assert.ok(pruneIdx !== -1, "credentials must be pruned from the traversal");
    assert.ok(pruneIdx < widenIdx, "the prune must be evaluated BEFORE the chmod action");
  });

  it("covers every credential seeded into the root, not just .env*", () => {
    // worktree-bootstrap.sh also seeds google-play-service-account.json — a Play
    // publishing credential. Matching only `.env*` would leave it at 644
    // permanently, which is worse than the window this guard closes.
    for (const pat of [
      "'.env\\*'",
      "'google-play-service-account.json'",
      "'*.keystore'",
      "'*.p12'",
    ]) {
      assert.ok(
        body.includes(`-name ${pat}`.replace("\\*", "*")),
        `the credential set must cover ${pat}`,
      );
    }
  });

  it("still forces the credentials owner-only afterwards (defence in depth)", () => {
    assert.match(body, /-exec chmod go-rwx \{\} \+/);
    const widenIdx = body.indexOf("chmod go+rX");
    const restrictIdx = body.indexOf("chmod go-rwx");
    assert.ok(restrictIdx > widenIdx, "the restrictive pass must come last");
  });

  it("refuses an empty sha rather than resetting to something arbitrary", () => {
    assert.match(body, /-n "\$sha" \]\] \|\| \{ logerr "ERROR: ensure_beta_build_root: empty sha"/);
  });

  it("logs to stderr, since the caller captures its stdout for the root path", () => {
    // A log() line inside a captured function ends up inside the captured value.
    assert.ok(!/(?<![\w])log "/.test(body), "must use logerr, not log");
  });

  it("pins the log()-writing helpers it calls to stderr too", () => {
    // seed_worktree_node_modules / copy_worktree_env / run_pnpm_install all
    // report via log() → stdout. Without >&2 a single warning (a failed
    // clonefile seed, a missing .env) is captured as part of the returned path
    // and reaches --repo-root as a mangled multi-word argument.
    assert.match(body, /seed_worktree_node_modules "\$root" >&2/);
    assert.match(body, /copy_worktree_env "\$root" >&2/);
    assert.match(body, /run_pnpm_install "\$root" >&2/);
    // The ONLY unredirected stdout write must be the return value itself.
    const echoes = (body.match(/^[ \t]*echo [^|>\n]*$/gm) || []).filter(
      (l) => !/>&2/.test(l) && !/echo "\$root"$/.test(l.trim()),
    );
    assert.deepEqual(echoes, [], "no stdout write other than the returned path");
    assert.match(body, /\n  echo "\$root"\n/);
  });

  it("checks out detached (the branch is already checked out in the issue worktree)", () => {
    assert.match(body, /worktree add --detach "\$root" "\$sha"/);
  });

  it("anchors the clean excludes at the paths the build dirs actually live in", () => {
    // `-e` takes gitignore-style patterns: one containing a slash is anchored to
    // the repo root, so `-e macos/Pods` protects <root>/macos/Pods and NOT
    // apps/desktop/macos/Pods — silently nuking Pods and DerivedData on every
    // dispatch. Verified with `git clean -ndx` against a real checkout.
    assert.match(body, /-e apps\/desktop\/macos\/Pods -e apps\/desktop\/macos\/build/);
    assert.match(body, /-e apps\/mobile\/ios -e apps\/mobile\/android/);
    // The root-anchored form must be gone. Match the literal " -e macos/" so
    // the apps/desktop-prefixed excludes above don't satisfy it by substring.
    assert.ok(
      !/ -e macos\//.test(body),
      "root-anchored macos/* excludes do not protect apps/desktop/macos/*",
    );
  });

  it("checks the kept desktop Pods after the reset, before the root is seeded (#804)", () => {
    // After #791 a kept Pods still described hermes-engine 0.81.6 while the
    // committed Podfile.lock pinned 0.14.1, and every desktop `pod install`
    // failed until someone deleted Pods by hand. The check has to compare
    // against the Podfile.lock the reset just checked out, under the root lock,
    // before anything is built from the root.
    assert.match(
      body,
      /\n {2}if \[\[ "\$platform" == "desktop" \]\]; then\n {4}_beta_root_drop_stale_pods "\$root" "\$sha" >&2\n {2}fi\n/,
    );
    const lockIdx = body.indexOf('_beta_root_lock "$platform" "$root"');
    const cleanIdx = body.indexOf("clean -fdx");
    const dropIdx = body.indexOf('_beta_root_drop_stale_pods "$root"');
    const seedIdx = body.indexOf('seed_worktree_node_modules "$root"');
    assert.ok(
      lockIdx !== -1 && lockIdx < dropIdx,
      "the check must run while the root lock is held",
    );
    assert.ok(cleanIdx !== -1 && cleanIdx < dropIdx, "the check must run after the reset");
    assert.ok(seedIdx > dropIdx, "the check must run before the root is seeded and installed");
    const code = body
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.equal(
      code.split("_beta_root_drop_stale_pods").length,
      2,
      "one call site, covering both the create and the reset paths",
    );
  });

  it("compares Pods/Manifest.lock with Podfile.lock, like Xcode's [CP] check", () => {
    const helper = fnBody("_beta_root_drop_stale_pods", lib);
    assert.match(helper, /macos="\$root\/apps\/desktop\/macos"/);
    assert.match(helper, /\[\[ -e "\$macos\/Pods" \|\| -L "\$macos\/Pods" \]\] \|\| return 0/);
    assert.match(helper, /\[\[ ! -f "\$macos\/Pods\/Manifest\.lock" \]\]/);
    assert.match(helper, /cmp -s "\$macos\/Podfile\.lock" "\$macos\/Pods\/Manifest\.lock"/);
    assert.match(helper, /reason="missing manifest/);
    assert.match(helper, /reason="manifest mismatch/);
  });

  it("deletes exactly the desktop Pods and build folders, nothing broader", () => {
    const helper = fnBody("_beta_root_drop_stale_pods", lib);
    assert.match(helper, /\[\[ -n "\$root" && -d "\$root" \]\] \|\| return 0/);
    const rms = (helper.match(/^\s*rm .*$/gm) || []).map((l) => l.trim());
    assert.deepEqual(rms, ['rm -rf -- "$macos/Pods" "$macos/build" 2>>"$LOG_FILE" \\']);
  });

  it("reports the deletion through logerr only, and never fails its caller", () => {
    // It runs inside ensure_beta_build_root, whose stdout is the root path, and
    // both callers run under `set -e`.
    const helper = fnBody("_beta_root_drop_stale_pods", lib);
    assert.ok(!/(?<![\w])log "/.test(helper), "must use logerr, not log");
    assert.ok(!/^\s*(echo|printf)\b/m.test(helper), "no stdout writes");
    assert.match(helper, /logerr "Stale CocoaPods sandbox in desktop beta build root \$root/);
    assert.match(helper, /\|\| logerr "WARNING: could not fully delete/);
    assert.match(helper, /\n {2}return 0\n\}$/);
  });

  it("bounds bundle install — it runs synchronously inside the watch tick", () => {
    assert.match(body, /run-with-timeout\.mjs" "\$INSTALL_TIMEOUT_SEC" bundle install/);
  });

  it("bounds bundle check too — a wedged ruby must not hold the root lock", () => {
    // 2026-10-09: an uncapped `bundle check` blocked for 5 hours in getcwd().
    assert.match(
      body,
      /run-with-timeout\.mjs" "\$BETA_BUNDLE_CHECK_TIMEOUT_SEC" \\\n\s+bundle check/,
    );
    assert.ok(!/\(\s*bundle check\b/.test(body), "an uncapped bundle check is back");
  });

  it("seeds desktop from $REPO_ROOT and installs it like mobile (ADR-0067)", () => {
    assert.match(body, /desktop\) root="\$BETA_DESKTOP_ROOT" ;;/);
    assert.ok(!/FOSSIL/.test(body), "the fossil source root is gone");
    // The install and bundle steps run for every platform, not only mobile.
    assert.match(body, /\n  run_pnpm_install "\$root" >&2/);
    assert.match(body, /cd "\$root\/apps\/\$platform"/);
    assert.match(body, /checkout -- "apps\/\$platform\/Gemfile\.lock"/);
  });
});

describe("intest_dispatch_betas — idempotency and reporting", () => {
  const body = fnBody("intest_dispatch_betas");

  it("keys idempotency PER LANE on the head SHA, not a monotonic marker", () => {
    // A single shared SHA used to suppress every lane: mobile succeeding hid a
    // desktop failure completely. `intestBetaLanes` is now the set of lanes
    // confirmed started for `intestBetaSha`, and only those are suppressed.
    assert.match(body, /intestBetaSha/);
    assert.match(body, /intestBetaLanes/);
    // A different commit invalidates both the confirmed lanes and the budget.
    assert.match(body, /-z "\$sha" \|\| "\$prior_sha" != "\$sha"/);
    assert.match(body, /prior_lanes=""/);
    assert.match(body, /prior_attempts=""/);
    assert.match(body, /already dispatched for/);
    // A marker would suppress forever and break the In Test iteration loop.
    assert.ok(!body.includes("issue_has_marker"), "must not gate on a monotonic marker");
  });

  it("re-dispatches only the lanes missing from the confirmed set", () => {
    assert.match(body, /to_dispatch="\$\{to_dispatch:\+\$to_dispatch,\}\$want"/);
    assert.match(body, /re-dispatching only the missing lane\(s\)/);
    assert.match(body, /--only "\$lanes"/);
  });

  it("records ONLY lanes whose start was confirmed, and unions with prior", () => {
    // .dispatched is confirmed-started; .failed never suppresses a retry.
    assert.match(body, /\.dispatched\[\]\?\.id/);
    assert.match(body, /\[\.failed\[\]\?\.id\]/);
    assert.match(body, /merged_lanes=/);
    assert.match(body, /sort -u/);
  });

  it("records no SHA at all when nothing started, leaving the retry armed", () => {
    assert.match(body, /started no lanes for #\$issue_num; leaving retry armed/);
    // The state writes must sit inside the `dispatched non-empty` branch.
    const elseIdx = body.indexOf("leaving retry armed");
    const shaWrite = body.indexOf('intestBetaSha "$sha"');
    assert.ok(shaWrite !== -1 && shaWrite < elseIdx, "the SHA write must be in the success branch");
  });

  it("records what it dispatched, for triage", () => {
    for (const field of ["intestBetaSha", "intestBetaAt", "intestBetaLanes"]) {
      assert.ok(body.includes(field), `missing state field ${field}`);
    }
  });

  it("passes the issue/PR/sha through so the build is identifiable", () => {
    assert.match(body, /dispatch-premerge/);
    assert.match(body, /--issue "\$issue_num" --pr "\$pr_num" --sha "\$sha"/);
  });

  it("emits manual commands keyed by platform, for every lane it is not building", () => {
    // Unkeyed strings leave the scenario writer unable to say which command
    // belongs to which platform when both natives are skipped.
    assert.match(body, /manualCommands/);
    assert.match(body, /\{ id: \., command:/);
    // ADR-0067: desktop installs in a fresh worktree, like mobile.
    assert.match(body, /cd apps\/desktop && bundle install && DRAFTO_INTEST_ISSUE=/);
    assert.ok(!/NEVER pnpm install/.test(body), "the fossil caveat is retired");
  });

  it("never sends a human to the operator's working tree or a factory build root", () => {
    // Both manual commands build in one worktree of the PR branch ($setup).
    assert.equal(
      (body.match(/git worktree add --detach \.\.\/drafto-" \+ \$issue/g) || []).length,
      1,
    );
    assert.equal((body.match(/\(\$setup \+ " && cd apps\//g) || []).length, 2);
    assert.ok(
      !/\$desktopRoot|BETA_DESKTOP_ROOT/.test(body),
      "a build root is hard-reset by the factory",
    );
    assert.ok(
      !/cd \/Users\/jakub\/code\/drafto && git checkout/.test(body),
      "must not move the operator's working tree onto a PR branch",
    );
  });

  it("runs both manual commands in one shell, sharing a worktree at the PR head (real git)", () => {
    // With both natives skipped the tester runs both commands, the second from
    // wherever the first left the shell. A later In Test round must build the
    // new head, not whatever an earlier round's worktree held: also after a
    // rebase, and also when the shell sits in some other repo.
    const jq = body.match(/manual=\$\(jq -nc [\s\S]*?\|\| echo "\[\]"\)/);
    assert.ok(jq, "could not extract the manual-command jq");
    const gen = spawnSync(
      "bash",
      ["-c", `skipped='mobile:phase-B,desktop:knob-off'; issue_num=7\n${jq[0]}\necho "$manual"`],
      { encoding: "utf8" },
    );
    assert.equal(gen.status, 0, gen.stderr);
    const cmd = Object.fromEntries(JSON.parse(gen.stdout).map((c) => [c.id, c.command]));
    assert.match(cmd.mobile, /&& DRAFTO_INTEST_ISSUE=7 pnpm release:beta:all$/);
    assert.match(cmd.desktop, /&& DRAFTO_INTEST_ISSUE=7 pnpm release:beta$/);

    const dir = mkdtempSync(join(tmpdir(), "intest-manual-"));
    try {
      const git = (cwd, ...a) =>
        spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
          encoding: "utf8",
        });
      const origin = join(dir, "origin");
      for (const d of ["scripts", "apps/mobile", "apps/desktop"]) {
        mkdirSync(join(origin, d), { recursive: true });
      }
      writeFileSync(join(origin, "scripts", "worktree-bootstrap.sh"), "exit 0\n");
      writeFileSync(join(origin, "apps", "mobile", "keep"), "");
      writeFileSync(join(origin, "apps", "desktop", "keep"), "");
      git(origin, "init", "-q", "-b", "main");
      git(origin, "add", "-A");
      git(origin, "commit", "-q", "-m", "one");
      git(origin, "checkout", "-q", "-b", "factory/issue-7");
      git(origin, "commit", "-q", "--allow-empty", "-m", "pr head");
      git(origin, "checkout", "-q", "main");
      const code = join(dir, "code");
      mkdirSync(code);
      const primary = join(code, "primary");
      assert.equal(spawnSync("git", ["clone", "-q", origin, primary]).status, 0);
      // Fake pnpm / bundle record where they ran and the issue they were given.
      const bin = join(dir, "bin");
      const calls = join(dir, "calls");
      mkdirSync(bin);
      for (const tool of ["pnpm", "bundle"]) {
        writeFileSync(
          join(bin, tool),
          `#!/bin/sh\necho "${tool} $* @ $PWD issue=$DRAFTO_INTEST_ISSUE" >> "${calls}"\n`,
          { mode: 0o755 },
        );
      }
      const run = (script, from = primary) =>
        spawnSync("bash", ["-c", `cd ${JSON.stringify(from)} || exit 10\n${script}`], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });

      const both = run(`${cmd.mobile} || exit 11\n${cmd.desktop} || exit 12`);
      assert.equal(both.status, 0, both.stderr);
      const wt = join(realpathSync(code), "drafto-7");
      const ran = readFileSync(calls, "utf8").split("\n");
      assert.ok(ran.includes(`pnpm release:beta:all @ ${wt}/apps/mobile issue=7`), ran.join("\n"));
      assert.ok(ran.includes(`bundle install @ ${wt}/apps/desktop issue=`), ran.join("\n"));
      assert.ok(ran.includes(`pnpm release:beta @ ${wt}/apps/desktop issue=7`), ran.join("\n"));

      // The next round: the PR moved on, and the old worktree is still there.
      git(origin, "checkout", "-q", "factory/issue-7");
      git(origin, "commit", "-q", "--allow-empty", "-m", "feedback fix");
      const head = git(origin, "rev-parse", "HEAD").stdout.trim();
      const again = run(`${cmd.desktop} || exit 12`);
      assert.equal(again.status, 0, again.stderr);
      assert.equal(git(wt, "rev-parse", "HEAD").stdout.trim(), head);

      // Then the branch is rebased (no fast-forward), and the tester pastes the
      // command in another project's checkout next to the worktree.
      git(origin, "reset", "-q", "--hard", "main");
      git(origin, "commit", "-q", "--allow-empty", "-m", "rebased");
      const rebased = git(origin, "rev-parse", "HEAD").stdout.trim();
      const other = join(code, "other");
      mkdirSync(other);
      git(other, "init", "-q");
      const third = run(`${cmd.desktop} || exit 12`, other);
      assert.equal(third.status, 0, third.stderr);
      assert.equal(git(wt, "rev-parse", "HEAD").stdout.trim(), rebased);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges node-side lane refusals with bash-side gate skips", () => {
    // A desktop deps refusal must reach the comment, not vanish.
    assert.match(body, /\$gateSkipped \+ \$laneSkipped/);
  });

  it("dispatches nothing under --dry-run", () => {
    assert.match(body, /DRY_RUN" -eq 1/);
    const dry = body.slice(body.indexOf('DRY_RUN" -eq 1'));
    assert.match(dry.slice(0, 500), /would dispatch pre-merge beta lane/);
  });

  it("logs to stderr, since its stdout is the captured betaDispatch JSON", () => {
    // Found by a real dry run: log() tees to stdout, so a log line inside this
    // function landed inside beta_json and made the bundle build fail.
    assert.ok(!/(?<![\w])log "/.test(body), "must use logerr, not log");
  });

  it("drops a lane whose build root could not be prepared", () => {
    assert.match(body, /-z "\$\{mobile_root:-\}" \]\] && lanes=/);
    assert.match(body, /-z "\$\{desktop_root:-\}" \]\] && lanes=/);
  });
});

describe("intest_check_lane_outcomes (extracted, real bash)", () => {
  // Runs the REAL function against a temp log dir and a temp state file, so the
  // .exit-file contract is exercised rather than pattern-matched.
  const run = ({
    exitContent,
    lanes = "mobile",
    sha = "abc123",
    stateSha = "abc123",
    dryRun = 0,
    logAgeMin = 0,
    writeLog = true,
    dispatchedAgoMin = null,
    attempts = "mobile:1",
    attempt = 1,
    decoys = null,
    markers = [],
    holdLog = false,
    laneStartedAgoMin = null,
    path = process.env.PATH,
    env = {},
    extraState = {},
    exitMtime = null,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "drafto-outcome-"));
    const stateFile = join(dir, "state.json");
    writeFileSync(
      stateFile,
      JSON.stringify({
        issues: {
          463: {
            intestBetaSha: stateSha,
            intestBetaLanes: lanes,
            intestBetaAttempts: attempts,
            ...(laneStartedAgoMin === null
              ? {}
              : {
                  intestBetaLaneAt: `mobile:${Math.floor(Date.now() / 1000) - laneStartedAgoMin * 60}`,
                }),
            ...(dispatchedAgoMin === null
              ? {}
              : {
                  intestBetaAt: new Date(Date.now() - dispatchedAgoMin * 60_000)
                    .toISOString()
                    .replace(/\.\d+Z$/, "Z"),
                }),
            ...extraState,
          },
        },
      }),
    );
    const base = join(dir, `beta-lane-mobile-463-${sha.slice(0, 12)}-a${attempt}.log`);
    if (writeLog) writeFileSync(base, "build output\n");
    if (writeLog && logAgeMin > 0) {
      const old = new Date(Date.now() - logAgeMin * 60_000);
      utimesSync(base, old, old);
    }
    if (exitContent !== undefined) writeFileSync(`${base}.exit`, exitContent);
    if (exitContent !== undefined && exitMtime !== null) {
      utimesSync(`${base}.exit`, exitMtime, exitMtime);
    }
    for (const [name, body] of Object.entries(decoys ?? {})) writeFileSync(join(dir, name), body);
    const snippet = `
set -uo pipefail
eval "$(awk '/^iso_age_min\(\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
eval "$(awk '/^lane_attempt_of\(\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
eval "$(awk '/^lane_attempt_set\(\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
eval "$(awk '/^lane_exit_epoch\(\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
eval "$(awk '/^kill_lane_holding_log\(\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
eval "$(awk '/^intest_check_lane_outcomes\(\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
log() { echo "[log] $*"; }
# A stand-in for a hung lane, in its OWN process group as dispatch-release.mjs's
# detached spawn gives it (set -m). The leader holds this attempt's log; its
# child does not, like xcodebuild whose output fastlane pipes back to ruby.
HELD_PID= KID_PID=
${
  holdLog
    ? `set -m
bash -c 'sleep 30 >/dev/null 2>&1 & echo $! >"$0"; exec sleep 30' "${base}.kid" >>"${base}" &
HELD_PID=$!
set +m
sleep 0.3
KID_PID=$(cat "${base}.kid")`
    : ""
}
# Models markers already on the issue ($2 is the marker). Default: none present.
issue_has_marker() {
  case "$2" in
${markers.map((m) => `    ${JSON.stringify(m)}) return 0 ;;`).join("\n") || "    __none__) return 0 ;;"}
  esac
  return 1
}
# HARD STUB: these tests run with DRY_RUN=0 to exercise the state writes, which
# also reaches the gh-issue-comment call. Without this stub that hits the real
# GitHub API and posts to a live issue - it did, 464 times, before this landed.
# Any real network or gh use from a unit test is a bug.
gh() { echo "[gh-stub] $*"; return 0; }
node() { command node "$@"; }
SCRIPT_DIR="${resolve(HERE, "..", "lib")}/.."
STATE_FILE=${JSON.stringify(stateFile)}
LOG_DIR=${JSON.stringify(dir)}
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
FACTORY_LANE_STALE_MIN=120
FACTORY_LANE_MAX_MIN=240
FACTORY_LANE_KILL_GRACE_SEC=1
FACTORY_LANE_MAX_ATTEMPTS=3
FACTORY_INTEST_BETA=1
DRY_RUN=${dryRun}
intest_check_lane_outcomes 463 ${JSON.stringify(sha)} 591
if [[ -n "$HELD_PID" ]]; then
  sleep 0.3
  if kill -0 "$HELD_PID" 2>/dev/null; then echo "HELD_ALIVE"; kill "$HELD_PID"; else echo "HELD_DEAD"; fi
  if kill -0 "$KID_PID" 2>/dev/null; then echo "KID_ALIVE"; kill "$KID_PID"; else echo "KID_DEAD"; fi
fi
cat "$STATE_FILE"
`;
    // An operator's exported FACTORY_LSOF_BIN must not leak into every case; only
    // a test that sets it on purpose gets one.
    const childEnv = { ...process.env, PATH: path, ...env };
    if (!("FACTORY_LSOF_BIN" in env)) delete childEnv.FACTORY_LSOF_BIN;
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8", env: childEnv });
    // gh output is redirected into $LOG_FILE, so comment assertions must read it
    // there — pointing LOG_FILE at /dev/null (as this harness used to) silently
    // discards every comment the function makes.
    let agentLog = "";
    try {
      agentLog = readFileSync(join(dir, "agent.log"), "utf8");
    } catch {
      agentLog = "";
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, agentLog, dir, stateFile };
  };

  it("leaves a still-building lane alone (no .exit yet)", () => {
    const r = run({ exitContent: undefined });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/re-arming/.test(r.stdout), "a lane with no .exit must not be re-armed");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("leaves a succeeded lane suppressed (.exit = 0)", () => {
    const r = run({ exitContent: "0\n" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/re-arming/.test(r.stdout), "exit 0 must stay suppressed");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("retracts its own failure notice when the retry succeeds", () => {
    // GitHub comments are append-only. #463 ended up with "the mobile beta build
    // failed" as the last word on the issue while a working build sat on
    // TestFlight — the tester had no way to know.
    const r = run({ exitContent: "0\n", markers: ["drafto-factory-beta-failed:mobile:abc123"] });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.agentLog, /issue comment/, "a recovery notice must be posted");
    assert.match(r.agentLog, /succeeded on retry/);
    assert.match(r.agentLog, /drafto-factory-beta-recovered:mobile:abc123/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("stays silent on success when no failure was ever announced", () => {
    // The common case. A recovery notice here would be noise retracting nothing.
    const r = run({ exitContent: "0\n", markers: [] });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/issue comment/.test(r.agentLog), "nothing to retract, so nothing to say");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("posts the recovery notice at most once", () => {
    // Every tick re-reads the same exit=0; without the marker guard the issue
    // would collect one retraction per 5 minutes, forever.
    const r = run({
      exitContent: "0\n",
      markers: [
        "drafto-factory-beta-failed:mobile:abc123",
        "drafto-factory-beta-recovered:mobile:abc123",
      ],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/issue comment/.test(r.agentLog), "the recovery notice must not repeat");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("backfills a missing attempt number so the dispatcher agrees with the log", () => {
    // State predating intestBetaAttempts. This function clamped to 1 and logged
    // "re-arming attempt 2", but left the field unset — so the dispatcher read 0,
    // computed 0+1=1, and re-used the artefact paths of the attempt that had just
    // failed, where a stale .exit was waiting to be misread as the retry's result.
    const r = run({ exitContent: "1\n", attempts: "", dryRun: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /re-arming attempt 2/);
    const state = JSON.parse(readFileSync(r.stateFile, "utf8"));
    assert.equal(
      state.issues["463"].intestBetaAttempts,
      "mobile:1",
      "the attempt the log just referred to must be persisted",
    );
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("re-arms a failed lane (.exit non-zero)", () => {
    const r = run({ exitContent: "70\n" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /beta lane 'mobile' exited 70/);
    assert.match(r.stdout, /re-arming attempt 2/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("ACTUALLY WRITES the re-armed lane set when not dry-running", () => {
    // The other cases run DRY_RUN=1, which short-circuits the state write —
    // so without this the re-arm itself had zero coverage.
    const r = run({ exitContent: "1\n", lanes: "mobile,desktop", dryRun: 0 });
    assert.equal(r.status, 0, r.stderr);
    const state = JSON.parse(readFileSync(r.stateFile, "utf8"));
    assert.equal(
      state.issues["463"].intestBetaLanes,
      "desktop",
      "the failed lane must be dropped and the healthy sibling kept",
    );
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("declares a lane dead when its log went silent and no .exit ever arrived", () => {
    // A wrapper killed by SIGKILL/reboot never writes .exit; without a staleness
    // timeout the lane is suppressed forever.
    const r = run({ exitContent: undefined, logAgeMin: 500, dryRun: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /never recorded an exit code/);
    // lsof runs and finds nothing holding the log, the usual case for a lane
    // that already died. That is not worth a warning.
    assert.ok(!/WARNING/.test(r.stdout + r.stderr), `unexpected warning: ${r.stdout}${r.stderr}`);
    const state = JSON.parse(readFileSync(r.stateFile, "utf8"));
    // state-cli normalises an empty value to null.
    assert.ok(
      !state.issues["463"].intestBetaLanes,
      "a dead lane must be re-armed (lane set cleared)",
    );
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("kills and re-arms a lane that keeps logging past the wall-clock cap", () => {
    // #623's desktop lane logged "Waiting for App Store Connect to finish
    // processing" every 32 s for 3 days. Its log never went silent, so the
    // silence check never fired and it held the desktop build root throughout.
    const r = run({ exitContent: undefined, laneStartedAgoMin: 300, holdLog: true, dryRun: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /still running 240\+ min after dispatch/);
    assert.match(r.stdout, /HELD_DEAD/, "the process holding the lane's log must be terminated");
    assert.match(
      r.stdout,
      /KID_DEAD/,
      "its piped children must die too, or they outlive the retry",
    );
    const state = JSON.parse(readFileSync(r.stateFile, "utf8"));
    assert.ok(!state.issues["463"].intestBetaLanes, "a hung lane must be re-armed");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("kills a hung lane under the factory's launchd PATH, which has no /usr/sbin or /sbin", () => {
    // #659: macOS keeps lsof only in /usr/sbin and the PATH the factory plist
    // sets leaves sbin out, so a bare `lsof` was "command not found", silenced, and
    // the hung lane survived its re-arm. On Linux CI lsof is in /usr/bin and
    // this passes either way; the structural test below covers that.
    const r = run({
      exitContent: undefined,
      laneStartedAgoMin: 300,
      holdLog: true,
      dryRun: 0,
      path: pathWithoutSbin(),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /still running 240\+ min after dispatch/);
    assert.ok(!/WARNING/.test(r.stdout + r.stderr), `unexpected warning: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /HELD_DEAD/, "lsof must be found without sbin on PATH");
    assert.match(r.stdout, /KID_DEAD/);
    const state = JSON.parse(readFileSync(r.stateFile, "utf8"));
    assert.ok(!state.issues["463"].intestBetaLanes, "a hung lane must be re-armed");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("uses FACTORY_LSOF_BIN when it is set", () => {
    const realLsof = ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof"].find((p) => existsSync(p));
    assert.ok(realLsof, "this test needs lsof installed");
    // A wrapper that records the call, so the test proves the knob was used
    // rather than the PATH / /usr/sbin lookup.
    const binDir = mkdtempSync(join(tmpdir(), "drafto-lsof-bin-"));
    const wrapper = join(binDir, "lsof-wrapper");
    const calls = join(binDir, "calls");
    writeFileSync(wrapper, `#!/bin/sh\necho called >>"${calls}"\nexec "${realLsof}" "$@"\n`, {
      mode: 0o755,
    });
    const r = run({
      exitContent: undefined,
      laneStartedAgoMin: 300,
      holdLog: true,
      dryRun: 0,
      path: pathWithoutSbin(),
      env: { FACTORY_LSOF_BIN: wrapper },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(calls), "the FACTORY_LSOF_BIN binary must be the one run");
    assert.match(r.stdout, /HELD_DEAD/);
    assert.match(r.stdout, /KID_DEAD/);
    rmSync(r.dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("warns, kills nothing and still re-arms when no lsof can be found", () => {
    // An explicit FACTORY_LSOF_BIN has no fallback, so pointing it at nothing
    // is the one portable way to model a host without lsof. The 2>/dev/null
    // used to hide this failure entirely.
    const missing = "/nonexistent/drafto-test/lsof";
    assert.ok(!existsSync(missing));
    const r = run({
      exitContent: undefined,
      laneStartedAgoMin: 300,
      holdLog: true,
      dryRun: 0,
      env: { FACTORY_LSOF_BIN: missing },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /WARNING: no usable lsof \(FACTORY_LSOF_BIN=\/nonexistent\/drafto-test\/lsof\)/,
    );
    assert.match(
      r.stdout,
      /WARNING: .*beta-lane-mobile-463-abc123-a1\.log/,
      "the warning must name the lane's log",
    );
    assert.match(r.stdout, /HELD_ALIVE/, "no fallback to PATH or /usr/sbin when the knob is set");
    // The callers' flow is unchanged: the lane is still reported and re-armed.
    assert.match(r.stdout, /still running 240\+ min after dispatch/);
    const state = JSON.parse(readFileSync(r.stateFile, "utf8"));
    assert.ok(!state.issues["463"].intestBetaLanes, "the lane must still be re-armed");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("treats a FACTORY_LSOF_BIN that is a directory as no lsof", () => {
    // A directory passes `-x`; running it would fail inside the silenced call.
    const r = run({
      exitContent: undefined,
      laneStartedAgoMin: 300,
      holdLog: true,
      dryRun: 0,
      env: { FACTORY_LSOF_BIN: tmpdir() },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /WARNING: no usable lsof/);
    assert.match(r.stdout, /HELD_ALIVE/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("leaves a chatty lane alone while it is under the wall-clock cap", () => {
    const r = run({ exitContent: undefined, laneStartedAgoMin: 30, holdLog: true, dryRun: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/re-arming/.test(r.stdout), "a 30-minute-old lane is still building");
    assert.match(r.stdout, /HELD_ALIVE/, "a healthy lane must not be killed");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("clocks the cap per lane, so a sibling's re-dispatch cannot reset it", () => {
    // intestBetaAt is shared and restamped by every dispatch. A mobile retry 5
    // minutes ago must not buy a desktop lane hung for 300 minutes more time.
    const r = run({
      exitContent: undefined,
      dispatchedAgoMin: 5,
      laneStartedAgoMin: 300,
      holdLog: true,
      dryRun: 0,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /HELD_DEAD/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("does not kill a young lane just because the shared dispatch stamp is old", () => {
    const r = run({
      exitContent: undefined,
      dispatchedAgoMin: 300,
      laneStartedAgoMin: 10,
      holdLog: true,
      dryRun: 0,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /HELD_ALIVE/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("falls back to the shared dispatch stamp for state predating intestBetaLaneAt", () => {
    const r = run({ exitContent: undefined, dispatchedAgoMin: 300, holdLog: true, dryRun: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /HELD_DEAD/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("does not kill anything on a dry run", () => {
    const r = run({ exitContent: undefined, laneStartedAgoMin: 300, holdLog: true, dryRun: 1 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /HELD_ALIVE/, "DRY_RUN must never terminate a process");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("declares a lane dead when it left NO log and NO exit code (openSync fell back)", () => {
    // Log missing AND wrapper killed: without the intestBetaAt fallback this
    // lane would be "still building" for ever — the same silent non-delivery
    // the whole mechanism exists to end.
    const r = run({ exitContent: undefined, writeLog: false, dispatchedAgoMin: 300, dryRun: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /left no log and no exit code/);
    const state = JSON.parse(readFileSync(r.stateFile, "utf8"));
    assert.ok(!state.issues["463"].intestBetaLanes, "a traceless lane must be re-armed");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("uses the per-lane clock for a traceless lane too", () => {
    // A sibling's re-dispatch restamps the shared intestBetaAt; it must not
    // keep a lane with no log and no exit code alive for ever.
    const r = run({
      exitContent: undefined,
      writeLog: false,
      dispatchedAgoMin: 5,
      laneStartedAgoMin: 300,
      dryRun: 0,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /left no log and no exit code/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("does NOT declare a traceless lane dead while it is still young", () => {
    const r = run({ exitContent: undefined, writeLog: false, dispatchedAgoMin: 5, dryRun: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/re-arming/.test(r.stdout), "a 5-minute-old dispatch is still building");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("stops retrying once the attempt cap is reached, and says so", () => {
    // Without a cap a deterministically-broken lane rebuilds every 5 minutes
    // for ever while the marker keeps the issue quiet about it.
    const r = run({ exitContent: "1\n", attempts: "mobile:3", attempt: 3, dryRun: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /attempt 3 of 3 — giving up/);
    const state = JSON.parse(readFileSync(r.stateFile, "utf8"));
    assert.equal(
      state.issues["463"].intestBetaLanes,
      "mobile",
      "a spent lane stays in the confirmed set so nothing re-dispatches it",
    );
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("still retries while under the cap", () => {
    const r = run({ exitContent: "1\n", attempts: "mobile:2", attempt: 2, dryRun: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /re-arming attempt 3/);
    const state = JSON.parse(readFileSync(r.stateFile, "utf8"));
    assert.ok(!state.issues["463"].intestBetaLanes, "an under-cap failure must re-arm");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("treats an empty or non-numeric .exit as STILL BUILDING, not as a failure", () => {
    // The wrapper writes the code with `echo $? > file`; a reader can catch it
    // mid-write. An empty read is not evidence of failure — declaring one would
    // re-dispatch a healthy build. The staleness timeout still catches a file
    // that never resolves.
    for (const content of ["", "not-a-number\n", "\n"]) {
      const r = run({ exitContent: content, dryRun: 0 });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        !/re-arming|giving up/.test(r.stdout),
        `content ${JSON.stringify(content)} must not be read as a failure`,
      );
      const state = JSON.parse(readFileSync(r.stateFile, "utf8"));
      assert.equal(state.issues["463"].intestBetaLanes, "mobile", "lane stays pending");
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("treats a readable non-zero .exit as a failure", () => {
    const r = run({ exitContent: "70\n", dryRun: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /exited 70/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("reads only ITS OWN attempt's outcome, not another card's or another attempt's", () => {
    // Decoys must land in the SAME dir the run reads from — an earlier version
    // of this test made a fresh temp dir for the second run, so it asserted
    // nothing at all. `decoys` writes them into that run's own directory.
    const r = run({
      exitContent: undefined,
      dryRun: 0,
      decoys: {
        // old unscoped name, another card, another commit, another ATTEMPT
        "beta-lane-mobile.log.exit": "1\n",
        "beta-lane-mobile-999-deadbeef1234-a1.log.exit": "1\n",
        "beta-lane-mobile-463-ffffffffffff-a1.log.exit": "1\n",
        "beta-lane-mobile-463-abc123-a9.log.exit": "1\n",
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      !/re-arming|giving up/.test(r.stdout),
      `no other dispatch's .exit may be read; stdout was: ${r.stdout}`,
    );
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("ignores outcomes recorded for a different commit", () => {
    // A .exit from an older SHA must not re-arm the current one.
    const r = run({ exitContent: "1\n", sha: "newsha", stateSha: "oldsha" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/re-arming/.test(r.stdout), "a stale SHA's outcome must be ignored");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("tolerates a garbage .exit file without crashing", () => {
    const r = run({ exitContent: "not-a-number\n" });
    assert.equal(r.status, 0, r.stderr);
    rmSync(r.dir, { recursive: true, force: true });
  });

  // ADR-0081: the last successful build per lane is what a later head reuses.
  it("records a succeeded lane's commit as its last successful build", () => {
    const finished = 1_700_000_000;
    const r = run({
      exitContent: "0\n",
      exitMtime: finished,
      extraState: { intestBetaBuilt: "desktop:old", intestBetaBuiltAt: "desktop:5" },
    });
    assert.equal(r.status, 0, r.stderr);
    const issue = JSON.parse(readFileSync(r.stateFile, "utf8")).issues["463"];
    assert.equal(issue.intestBetaBuilt, "desktop:old,mobile:abc123");
    // When it finished (its .exit's mtime): reuse stops once it is too old.
    assert.equal(issue.intestBetaBuiltAt, `desktop:5,mobile:${finished}`);
    assert.equal(issue.intestBetaLanes, "mobile", "still suppressed");
    rmSync(r.dir, { recursive: true, force: true });
    for (const [exitContent, dryRun] of [
      ["1\n", 0],
      [undefined, 0],
      ["0\n", 1],
    ]) {
      const no = run({ exitContent, dryRun });
      const st = JSON.parse(readFileSync(no.stateFile, "utf8")).issues["463"];
      assert.equal(st.intestBetaBuilt ?? null, null, `${exitContent} dry=${dryRun}`);
      rmSync(no.dir, { recursive: true, force: true });
    }
  });

  it("skips a lane reused from an earlier build: it has no log for this head", () => {
    // Without the skip, a reused lane with no log and an old dispatch stamp
    // reads as killed before it could write, and is rebuilt.
    const r = run({
      exitContent: undefined,
      writeLog: false,
      dispatchedAgoMin: 500,
      dryRun: 0,
      attempts: "",
      extraState: { intestBetaReused: "mobile:abc123" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /re-arming|left no log/);
    assert.doesNotMatch(r.agentLog, /issue comment/);
    const issue = JSON.parse(readFileSync(r.stateFile, "utf8")).issues["463"];
    assert.equal(issue.intestBetaLanes, "mobile");
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("still reads the outcome of a lane dispatched for this head, whatever intestBetaReused says", () => {
    // A lane with an attempt on record was really built here; a stale reuse
    // entry must not hide its failure.
    const r = run({
      exitContent: "1\n",
      dryRun: 0,
      extraState: { intestBetaReused: "mobile:abc123" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /re-arming attempt 2/);
    rmSync(r.dir, { recursive: true, force: true });
  });
});

describe("intest_check_lane_outcomes — wiring and reporting", () => {
  const body = fnBody("intest_check_lane_outcomes");

  it("runs BEFORE the dispatch decision in the sweep", () => {
    const checkIdx = sweepBlock.indexOf("intest_check_lane_outcomes");
    const dispatchIdx = sweepBlock.indexOf("intest_dispatch_betas");
    assert.ok(checkIdx !== -1, "the sweep must check outcomes");
    assert.ok(
      checkIdx < dispatchIdx,
      "outcomes must be learned before deciding what to dispatch, or the re-arm lands a tick late",
    );
  });

  it("posts a marker-guarded failure comment naming the log", () => {
    assert.match(body, /drafto-factory-beta-failed:\$\{lane\}:\$\{sha:0:12\}/);
    assert.match(body, /issue_has_marker/);
    // Per ATTEMPT: a retry must never share artefacts with the attempt it
    // replaces — a lane declared stale may still be alive and writing.
    assert.match(
      body,
      /beta-lane-\$\{lane\}-\$\{issue_num\}-\$\{sha:0:12\}-a\$\{lane_attempt\}\.log/,
    );
  });

  it("writes nothing under --dry-run", () => {
    assert.match(body, /DRY_RUN" -eq 0 \]\][\s\S]{0,20}issue_has_marker/);
    assert.match(body, /changed" -eq 1 && "\$DRY_RUN" -eq 0/);
  });
});

describe("kill_lane_holding_log — lsof resolution", () => {
  // Every `lsof` word that is not the /usr/sbin/lsof fallback or the
  // `command -v lsof` lookup. Comments and plain log messages are prose, not
  // calls; a log line with a command substitution is still checked.
  const bareLsofCalls = (fn) => {
    const code = fn
      .split("\n")
      .filter((l) => !/^\s*#/.test(l) && !/^\s*log "(?:[^$`]|\$(?!\())*"\s*$/.test(l))
      .map((l) => l.replace(/\s#\s.*$/, ""))
      .join("\n");
    return [...code.matchAll(/(?<![\w/.])lsof(?![\w-])/g)]
      .filter((m) => !/command -v $/.test(code.slice(0, m.index)))
      .map((m) =>
        code
          .slice(code.lastIndexOf("\n", m.index) + 1)
          .split("\n")[0]
          .trim(),
      );
  };

  it("flags the pre-#659 bare call, so the check below can fail", () => {
    const before = `kill_lane_holding_log() {
  for pid in $(lsof -t -- "$log_path" 2>/dev/null || true); do
}`;
    assert.equal(bareLsofCalls(before).length, 1);
    // Other bare forms: a bare-name default, and a call inside a log message.
    assert.equal(bareLsofCalls('  lsof_bin="${FACTORY_LSOF_BIN:-lsof}"').length, 1);
    assert.equal(bareLsofCalls('  log "holders: $(lsof -t -- "$log_path")"').length, 1);
  });

  it("never calls lsof by bare name", () => {
    // The factory's launchd PATH has no /usr/sbin, the only place macOS keeps
    // lsof. On Linux CI lsof is in /usr/bin, so the PATH-filtered run above
    // cannot catch a regression there; this does.
    const body = fnBody("kill_lane_holding_log");
    assert.deepEqual(bareLsofCalls(body), []);
    assert.match(body, /\$\{FACTORY_LSOF_BIN:-\}/, "the knob must be read safely under set -u");
    assert.match(body, /command -v lsof/);
    assert.match(body, /lsof_bin=\/usr\/sbin\/lsof/);
    assert.match(body, /\$\("\$lsof_bin" -t -- "\$log_path"/);
  });

  it("warns, rather than hides, a missing lsof and still returns 0", () => {
    const body = fnBody("kill_lane_holding_log");
    assert.match(body, /log "WARNING: no usable lsof[^"]*\$log_path"\s*\n\s*return 0/);
  });
});

describe("factory-agent.sh PATH", () => {
  it("appends sbin, so it adds commands without shadowing any", () => {
    assert.match(script, /^export PATH="\$HOME\/\.local\/bin:\$PATH:\/usr\/sbin:\/sbin"$/m);
  });
});

describe("pre-merge beta knobs", () => {
  it("defaults both knobs off", () => {
    assert.match(script, /FACTORY_INTEST_BETA="\$\{FACTORY_INTEST_BETA:-0\}"/);
    assert.match(script, /FACTORY_INTEST_BETA_DESKTOP="\$\{FACTORY_INTEST_BETA_DESKTOP:-0\}"/);
  });

  it("points the build roots at dedicated paths, not the primary or this checkout", () => {
    // The plist's explicit knobs win. Both: the factory's build volume when it
    // is mounted, else ~/code. The volume's name is ASCII (ADR-0060), because
    // the mobile root's iOS pods cannot build from a non-ASCII path.
    assert.match(
      lib,
      /BETA_MOBILE_ROOT="\$\{DRAFTO_BETA_MOBILE_ROOT:-\$parent\/drafto-beta-mobile\}"/,
    );
    assert.match(
      lib,
      /BETA_BUILDS_VOLUME_DIR="\$\{DRAFTO_BUILDS_VOLUME_DIR:-\/Volumes\/DraftoFactory\}"/,
    );
    assert.match(
      lib,
      /BETA_DESKTOP_ROOT="\$\{DRAFTO_DESKTOP_BUILD_ROOT:-\$parent\/drafto-beta-desktop\}"/,
    );
    // The old knob name still works, so an older launchd plist keeps the rail.
    assert.match(
      lib,
      /PRIMARY_CHECKOUT_ROOT="\$\{DRAFTO_PRIMARY_CHECKOUT_ROOT:-\$\{DRAFTO_DESKTOP_FOSSIL_ROOT:-\/Users\/jakub\/code\/drafto\}\}"/,
    );
    assert.match(lib, /parent="\/Users\/jakub\/code"/, "~/code fallback kept");
    assert.match(lib, /-d "\$BETA_BUILDS_VOLUME_DIR"/, "volume used only when mounted");
    // The factory must not shadow the lib's defaults with its own.
    assert.doesNotMatch(
      script,
      /^\s*(BETA_MOBILE_ROOT|BETA_DESKTOP_ROOT|PRIMARY_CHECKOUT_ROOT|DESKTOP_FOSSIL_ROOT)=/m,
    );
  });

  it("dispatches betas before writing the scenario (the build takes 20-40 min)", () => {
    const handoff = fnBody("intest_handoff");
    const dispatchIdx = handoff.indexOf("intest_dispatch_betas");
    const bundleIdx = handoff.indexOf("build_intest_bundle");
    assert.ok(dispatchIdx !== -1 && dispatchIdx < bundleIdx, "dispatch must precede the bundle");
  });

  it("never lets a failed dispatch stop the scenario from being written", () => {
    // The property moved to the call sites when dispatch was decoupled: each one
    // falls back to an empty betaDispatch payload, and intest_handoff defaults
    // the parameter, so a failed dispatch still yields a usable comment.
    const sites = script.match(/INTEST_BETA=\$\(intest_dispatch_betas[\s\S]{0,240}?\)\n/g) || [];
    assert.ok(sites.length >= 2, "both the advance path and the sweep must dispatch");
    for (const site of sites) {
      assert.match(site, /\|\| echo '\{"dispatched":\[\],"skipped":\[\],"manualCommands":\[\]\}'/);
    }
    const handoff = fnBody("intest_handoff");
    assert.match(handoff, /local beta_json="\$\{9:-/, "handoff must default the payload");
  });

  it("copies the Play service-account key into build roots (Android lane needs it)", () => {
    assert.match(lib, /apps\/mobile\/google-play-service-account\.json/);
  });
});

describe("logerr", () => {
  it("writes to $LOG_FILE only — never via log(), never to bare stderr", () => {
    // log() tees to stdout, which corrupted values the caller captures. Bare
    // stderr was double-logged where the caller redirects it into $LOG_FILE and
    // LOST entirely where it doesn't — --release's ensure_beta_build_root call
    // had no redirect, so those lines vanished from the factory log.
    const m = script.match(/^logerr\(\) \{.*$/m);
    assert.ok(m, "logerr not found");
    assert.ok(
      !/\blog\b/.test(m[0]),
      "logerr must not route through log() — that double-writes the file",
    );
    assert.match(m[0], />>"\$LOG_FILE"/);
    assert.ok(!/>&2/.test(m[0]), "bare stderr loses messages at non-redirecting call sites");
  });
});

describe("iso_age_min (extracted, real bash)", () => {
  const age = (iso) => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        `eval "$(awk '/^iso_age_min\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"\niso_age_min ${JSON.stringify(iso)}`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    return Number(r.stdout.trim());
  };

  it("measures whole minutes since an ISO-8601 UTC stamp", () => {
    const threeHoursAgo = new Date(Date.now() - 180 * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
    const m = age(threeHoursAgo);
    assert.ok(m >= 179 && m <= 181, `expected ~180, got ${m}`);
  });

  it("returns a huge number for anything not a well-formed UTC stamp", () => {
    // Must NOT read as "just dispatched" — that would suppress the lane for
    // ever. The shape is validated in-shell rather than delegated to date(1),
    // because BSD and GNU disagree about what they accept: relying on the tool
    // to reject garbage made this platform-dependent and it failed on CI.
    for (const bad of [
      "not-a-date",
      "",
      "12345",
      "2026-08-07T04:00:00", // no trailing Z
      "2026-08-07 04:00:00Z", // space instead of T
      "2026-13-99T99:99:99Z", // right shape, impossible values
    ]) {
      assert.ok(age(bad) > 100000, `"${bad}" must not read as recent`);
    }
  });
});

describe("In Test knobs", () => {
  it("defines a validated timeout knob for the scenario stage", () => {
    assert.match(script, /FACTORY_INTEST_TIMEOUT_SEC="\$\{FACTORY_INTEST_TIMEOUT_SEC:-600\}"/);
    assert.match(script, /invalid FACTORY_INTEST_TIMEOUT_SEC/);
  });

  it("degrades to the fallback when the prompt file is missing, rather than exiting", () => {
    // The fix loop must keep running even if this stage's prompt is absent.
    assert.match(script, /INTEST_PROMPT_FILE="\$SCRIPT_DIR\/factory-intest-prompt\.md"/);
    const body = fnBody("intest_handoff");
    assert.match(body, /! -f "\$INTEST_PROMPT_FILE"/);
  });
});

// ADR-0081: a new PR head reuses a lane's last successful pre-merge beta when
// nothing that lane builds from changed since. The real functions run in bash
// with state-cli and dispatch-release.mjs real; gh answers the compare API from
// canned responses, through the caller's own --jq.
describe("beta reuse across heads (ADR-0081, real bash)", () => {
  const OLD = "a".repeat(40);
  const PREV = "b".repeat(40);
  const HEAD = "c".repeat(40);
  const STUBS = `
logerr() { echo "$*" >> "$LOG_FILE"; }
log() { echo "$*" >> "$LOG_FILE"; }
gh() {
  echo "gh $*" >> "$CALLS"
  [[ "$1" == "api" ]] || return 0
  local expr="" prev="" a key
  for a in "$@"; do [[ "$prev" == "--jq" ]] && expr="$a"; prev="$a"; done
  key="\${2##*/compare/}"
  [[ -f "$RESP_DIR/$key.json" ]] || { echo "gh: Not Found (HTTP 404)" >&2; return 1; }
  jq -r "$expr" < "$RESP_DIR/$key.json"
}
intest_beta_gate() { echo "lanes=$GATE_LANES skipped="; }
hosted_config_gate_pr() { return 0; }
ensure_beta_build_root() { echo "root $1" >> "$CALLS"; echo "/tmp/root-$1"; }
claim_beta_build_root() { :; }
release_beta_build_root() { :; }
node() {
  if [[ "$1" == */dispatch-release.mjs && "$2" == dispatch-premerge ]]; then
    local only="" prev="" a
    for a in "$@"; do [[ "$prev" == "--only" ]] && only="$a"; prev="$a"; done
    echo "dispatch-premerge --only $only" >> "$CALLS"
    jq -nc --arg o "$only" '{dispatched: [$o | split(",")[] | {id: ., pid: 4242}], failed: [], skipped: []}'
    return 0
  fi
  command node "$@"
}
`;
  const FNS = [
    "lane_attempt_of",
    "lane_attempt_set",
    "lane_exit_epoch",
    "intest_reuse_fresh",
    "intest_reused_json",
    "intest_beta_reuse_decide",
    "intest_reused_valid",
    "intest_reused_drop_stale",
    "intest_dispatch_betas",
  ];
  // "mobile:<sha>,…" → the same lanes, finished <daysAgo> days ago.
  const builtAt = (csv, daysAgo = 0.05) =>
    csv
      .split(",")
      .map((p) => `${p.split(":")[0]}:${Math.floor(Date.now() / 1000 - daysAgo * 86400)}`)
      .join(",");

  // compare: {"<from>...<to>": response JSON}; exits: {"<file name>": content}.
  function run(
    call,
    {
      state = {},
      compare = {},
      exits = {},
      exitTimes = {},
      lanes = "mobile",
      knob = "1",
      maxDays = "60",
      dryRun = 0,
      ticks = 1,
      lockState = false,
    } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "drafto-reuse-"));
    // Its own directory, so lockState can make every save fail.
    const stateDir = join(dir, "st");
    mkdirSync(stateDir);
    const stateFile = join(stateDir, "state.json");
    const respDir = join(dir, "resp");
    mkdirSync(respDir);
    // A recorded build is a fresh one unless the case says otherwise.
    const issue =
      state.intestBetaBuilt && !("intestBetaBuiltAt" in state)
        ? { ...state, intestBetaBuiltAt: builtAt(state.intestBetaBuilt) }
        : state;
    writeFileSync(stateFile, JSON.stringify({ issues: { 463: issue } }));
    if (lockState) chmodSync(stateDir, 0o555);
    for (const [key, body] of Object.entries(compare)) {
      writeFileSync(join(respDir, `${key}.json`), JSON.stringify(body));
    }
    for (const [name, body] of Object.entries(exits)) {
      writeFileSync(join(dir, name), body);
      if (exitTimes[name]) utimesSync(join(dir, name), exitTimes[name], exitTimes[name]);
    }
    const snippet = `
set -euo pipefail
${FNS.map((f) => `eval "$(awk '/^${f}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`).join("\n")}
${STUBS}
SCRIPT_DIR="${resolve(HERE, "..")}"
STATE_FILE=${JSON.stringify(stateFile)}
LOG_DIR=${JSON.stringify(dir)}
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
CALLS=${JSON.stringify(join(dir, "calls"))}
RESP_DIR=${JSON.stringify(respDir)}
GATE_LANES=${JSON.stringify(lanes)}
DRY_RUN=${dryRun}
REPO_ROOT=${JSON.stringify(dir)}
FACTORY_INTEST_BETA_REUSE=${JSON.stringify(knob)}
FACTORY_INTEST_BETA_REUSE_MAX_DAYS=${JSON.stringify(maxDays)}
touch "$CALLS" "$LOG_FILE"
state() { command node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 463 --state-file "$STATE_FILE"; }
for _tick in $(seq ${ticks}); do
${call}
done
`;
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
    const out = {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      log: read("agent.log"),
      calls: read("calls"),
      issue: JSON.parse(readFileSync(stateFile, "utf8")).issues["463"],
    };
    chmodSync(stateDir, 0o755);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(out.status, 0, `${out.stderr}\n--- log ---\n${out.log}`);
    return out;
  }
  const decide = (lanes = "mobile") =>
    `echo "RESULT=$(intest_beta_reuse_decide 463 ${HEAD} ${lanes} "$(state)")"`;
  const result = (r) => r.stdout.match(/^RESULT=(.*)$/m)?.[1];
  const ahead = (...files) => ({
    status: "ahead",
    files: files.map((f) => (typeof f === "string" ? { filename: f } : f)),
  });
  const compares = (r) => r.calls.split("\n").filter((l) => /^gh api .*\/compare\//.test(l));

  describe("intest_beta_reuse_decide", () => {
    it("reuses a lane when nothing it builds from changed, and records the decision", () => {
      const r = run(decide(), {
        state: { intestBetaBuilt: `mobile:${OLD}`, intestBetaSha: PREV, intestBetaLanes: "mobile" },
        compare: { [`${OLD}...${HEAD}`]: ahead("docs/a.md", "apps/web/b.ts", "supabase/x.sql") },
      });
      assert.equal(result(r), `mobile:${OLD}`);
      assert.match(r.log, new RegExp(`beta lane mobile reused from ${OLD.slice(0, 12)}`));
      assert.equal(r.issue.intestBetaSha, HEAD);
      assert.equal(r.issue.intestBetaReused, `mobile:${OLD}`);
      // The previous head's lanes and budget go with it.
      assert.equal(r.issue.intestBetaLanes ?? null, null);
      assert.equal(r.issue.intestBetaAttempts ?? null, null);
    });

    it("rebuilds on a change to the lane's inputs, and records that too", () => {
      const r = run(decide(), {
        state: { intestBetaBuilt: `mobile:${OLD}`, intestBetaSha: PREV },
        compare: { [`${OLD}...${HEAD}`]: ahead("docs/a.md", "pnpm-lock.yaml") },
      });
      assert.equal(result(r), "");
      assert.match(r.log, /beta lane mobile needs a new build .*\(rebuild pnpm-lock\.yaml\)/);
      assert.equal(r.issue.intestBetaSha, HEAD, "decided once for this head");
      assert.equal(r.issue.intestBetaReused ?? null, null);
    });

    it("counts a file renamed out of the lane's app", () => {
      const r = run(decide(), {
        state: { intestBetaBuilt: `mobile:${OLD}` },
        compare: {
          [`${OLD}...${HEAD}`]: ahead({
            filename: "docs/old-screen.md",
            previous_filename: "apps/mobile/src/old-screen.md.tsx",
          }),
        },
      });
      assert.equal(result(r), "");
    });

    it("falls back to a rebuild on a rebase, too many files or an API error", () => {
      const many = ahead(...Array.from({ length: 300 }, (_, i) => `docs/${i}.md`));
      for (const [name, compare, why] of [
        ["diverged", { [`${OLD}...${HEAD}`]: { status: "diverged", files: [] } }, /'diverged'/],
        ["behind", { [`${OLD}...${HEAD}`]: { status: "behind", files: [] } }, /'behind'/],
        ["300 files", { [`${OLD}...${HEAD}`]: many }, /with 300 file\(s\)/],
        ["404", {}, /couldn't compare/],
      ]) {
        const r = run(decide(), { state: { intestBetaBuilt: `mobile:${OLD}` }, compare });
        assert.equal(result(r), "", name);
        assert.match(r.log, why, name);
        assert.equal(r.issue.intestBetaSha, HEAD, `${name}: decided once`);
      }
      // 299 docs files are still a reuse.
      const ok = run(decide(), {
        state: { intestBetaBuilt: `mobile:${OLD}` },
        compare: {
          [`${OLD}...${HEAD}`]: ahead(...Array.from({ length: 299 }, (_, i) => `docs/${i}.md`)),
        },
      });
      assert.equal(result(ok), `mobile:${OLD}`);
    });

    it("accepts an identical tree, and a build of the head itself without calling the API", () => {
      const r = run(decide(), {
        state: { intestBetaBuilt: `mobile:${OLD}` },
        compare: { [`${OLD}...${HEAD}`]: { status: "identical", files: [] } },
      });
      assert.equal(result(r), `mobile:${OLD}`);
      const self = run(decide(), {
        state: { intestBetaBuilt: `mobile:${HEAD}`, intestBetaSha: PREV },
      });
      assert.equal(result(self), `mobile:${HEAD}`);
      assert.deepEqual(compares(self), []);
    });

    it("decides each lane on its own", () => {
      const r = run(decide("mobile,desktop"), {
        state: { intestBetaBuilt: `mobile:${OLD},desktop:${PREV}` },
        compare: {
          [`${OLD}...${HEAD}`]: ahead("apps/desktop/src/a.ts"),
          [`${PREV}...${HEAD}`]: ahead("apps/desktop/src/a.ts"),
        },
      });
      assert.equal(result(r), `mobile:${OLD}`);
      assert.match(r.log, /beta lane desktop needs a new build .*apps\/desktop\/src\/a\.ts/);
    });

    it("adopts the previous head's lane that finished after the last outcome check", () => {
      const finished = Math.floor(Date.now() / 1000) - 3600;
      const r = run(decide(), {
        state: {
          intestBetaSha: PREV,
          intestBetaLanes: "mobile",
          intestBetaAttempts: "mobile:2",
        },
        exits: { [`beta-lane-mobile-463-${PREV.slice(0, 12)}-a2.log.exit`]: "0\n" },
        exitTimes: { [`beta-lane-mobile-463-${PREV.slice(0, 12)}-a2.log.exit`]: finished },
        compare: { [`${PREV}...${HEAD}`]: ahead("docs/a.md") },
      });
      assert.equal(result(r), `mobile:${PREV}`);
      assert.equal(r.issue.intestBetaBuilt, `mobile:${PREV}`);
      assert.equal(r.issue.intestBetaBuiltAt, `mobile:${finished}`, "when its .exit was written");
      // A failed or unfinished one is not a build.
      for (const exits of [
        { [`beta-lane-mobile-463-${PREV.slice(0, 12)}-a2.log.exit`]: "1\n" },
        {},
      ]) {
        const no = run(decide(), {
          state: { intestBetaSha: PREV, intestBetaLanes: "mobile", intestBetaAttempts: "mobile:2" },
          exits,
        });
        assert.equal(result(no), "");
        assert.equal(no.issue.intestBetaBuilt ?? null, null);
        assert.deepEqual(compares(no), []);
        assert.equal(no.issue.intestBetaSha, PREV, "nothing compared, nothing recorded");
      }
    });

    it("does nothing without a successful build, with the knob off, or for a bad SHA", () => {
      for (const [opts, call] of [
        [{ state: {} }, decide()],
        [{ state: { intestBetaBuilt: `mobile:${OLD}` }, knob: "0" }, decide()],
        [{ state: { intestBetaBuilt: `desktop:${OLD}` } }, decide()],
        [
          { state: { intestBetaBuilt: `mobile:${OLD}` } },
          `echo "RESULT=$(intest_beta_reuse_decide 463 abc mobile "$(state)")"`,
        ],
      ]) {
        const r = run(call, opts);
        assert.equal(result(r), "", JSON.stringify(opts));
        assert.deepEqual(compares(r), [], JSON.stringify(opts));
        assert.equal(r.issue.intestBetaSha ?? null, null, JSON.stringify(opts));
      }
    });

    it("never reuses a build past FACTORY_INTEST_BETA_REUSE_MAX_DAYS, or of unknown age", () => {
      const docsOnly = { [`${OLD}...${HEAD}`]: ahead("docs/a.md") };
      for (const [why, opts] of [
        [
          "61 days old",
          {
            state: {
              intestBetaBuilt: `mobile:${OLD}`,
              intestBetaBuiltAt: builtAt(`mobile:${OLD}`, 61),
            },
          },
        ],
        ["unknown age", { state: { intestBetaBuilt: `mobile:${OLD}`, intestBetaBuiltAt: null } }],
        [
          "another lane's age",
          {
            state: {
              intestBetaBuilt: `mobile:${OLD}`,
              intestBetaBuiltAt: builtAt(`desktop:${OLD}`),
            },
          },
        ],
        [
          "8 days old, limit 7",
          {
            state: {
              intestBetaBuilt: `mobile:${OLD}`,
              intestBetaBuiltAt: builtAt(`mobile:${OLD}`, 8),
            },
            maxDays: "7",
          },
        ],
      ]) {
        const r = run(decide(), { ...opts, compare: docsOnly });
        assert.equal(result(r), "", why);
        assert.match(
          r.log,
          /beta from aaaaaaaaaaaa is over \d+ days old, or of unknown age; building it again/,
          why,
        );
        assert.deepEqual(compares(r), [], `${why}: no API call for a build it won't reuse`);
        assert.equal(r.issue.intestBetaSha, HEAD, `${why}: decided once`);
      }
      for (const [why, opts] of [
        [
          "59 days old",
          {
            state: {
              intestBetaBuilt: `mobile:${OLD}`,
              intestBetaBuiltAt: builtAt(`mobile:${OLD}`, 59),
            },
          },
        ],
        [
          "6 days old, limit 7",
          {
            state: {
              intestBetaBuilt: `mobile:${OLD}`,
              intestBetaBuiltAt: builtAt(`mobile:${OLD}`, 6),
            },
            maxDays: "7",
          },
        ],
      ]) {
        assert.equal(result(run(decide(), { ...opts, compare: docsOnly })), `mobile:${OLD}`, why);
      }
    });

    it("records nothing, and says so, when its one state write fails", () => {
      const r = run(
        `if intest_beta_reuse_decide 463 ${HEAD} mobile "$(state)" >/dev/null; then echo RC=0; else echo RC=1; fi`,
        {
          state: {
            intestBetaBuilt: `mobile:${OLD}`,
            intestBetaSha: PREV,
            intestBetaLanes: "mobile",
          },
          compare: { [`${OLD}...${HEAD}`]: ahead("docs/a.md") },
          lockState: true,
        },
      );
      assert.match(r.stdout, /^RC=1$/m);
      assert.match(
        r.log,
        /couldn't record the beta reuse decision for cccccccccccc; dispatching nothing this tick/,
      );
      // All or nothing: the previous head's record is untouched.
      assert.equal(r.issue.intestBetaSha, PREV);
      assert.equal(r.issue.intestBetaLanes, "mobile");
      assert.equal(r.issue.intestBetaReused ?? null, null);
    });

    it("writes nothing under --dry-run", () => {
      const r = run(decide(), {
        state: { intestBetaBuilt: `mobile:${OLD}`, intestBetaSha: PREV },
        compare: { [`${OLD}...${HEAD}`]: ahead("docs/a.md") },
        dryRun: 1,
      });
      assert.equal(result(r), `mobile:${OLD}`);
      assert.equal(r.issue.intestBetaSha, PREV);
      assert.equal(r.issue.intestBetaReused ?? null, null);
    });
  });

  describe("intest_dispatch_betas", () => {
    const dispatch = `echo "OUT=$(intest_dispatch_betas 463 802 ${HEAD} '{"mobile":true,"desktop":true}')"`;
    const out = (r) => [...r.stdout.matchAll(/^OUT=(.*)$/gm)].map((m) => JSON.parse(m[1]));

    it("builds nothing when every lane is reused, and asks the API once per head", () => {
      const r = run(dispatch, {
        state: { intestBetaBuilt: `mobile:${OLD}`, intestBetaSha: PREV, intestBetaLanes: "mobile" },
        compare: { [`${OLD}...${HEAD}`]: ahead("docs/a.md") },
        ticks: 3,
      });
      const outs = out(r);
      assert.equal(outs.length, 3);
      for (const o of outs) {
        assert.deepEqual(o.dispatched, []);
        assert.deepEqual(o.reused, [{ id: "mobile", fromSha: OLD, builds: [] }]);
      }
      assert.equal(compares(r).length, 1, "later ticks read the decision back");
      assert.doesNotMatch(r.calls, /^root |dispatch-premerge/m);
      assert.equal(r.issue.intestBetaReused, `mobile:${OLD}`);
      assert.equal(r.issue.intestBetaLanes ?? null, null);
    });

    it("dispatches only the lane that changed, and keeps the reuse on record", () => {
      const r = run(dispatch, {
        lanes: "mobile,desktop",
        state: { intestBetaBuilt: `mobile:${OLD},desktop:${OLD}`, intestBetaSha: PREV },
        compare: { [`${OLD}...${HEAD}`]: ahead("apps/desktop/src/a.ts") },
        ticks: 2,
      });
      const [first, second] = out(r);
      assert.deepEqual(
        first.dispatched.map((d) => d.id),
        ["desktop"],
      );
      assert.deepEqual(
        first.reused.map((d) => d.id),
        ["mobile"],
      );
      assert.match(r.calls, /^dispatch-premerge --only desktop$/m);
      assert.equal((r.calls.match(/dispatch-premerge/g) || []).length, 1);
      assert.deepEqual(second.dispatched, [{ id: "desktop", alreadyRunning: true }]);
      assert.deepEqual(
        second.reused.map((d) => d.id),
        ["mobile"],
      );
      assert.equal(r.issue.intestBetaLanes, "desktop");
      assert.equal(r.issue.intestBetaReused, `mobile:${OLD}`);
      assert.equal(r.issue.intestBetaSha, HEAD);
      assert.equal(compares(r).length, 1);
    });

    it("rebuilds as before with the knob off, and clears a stale reuse", () => {
      const r = run(dispatch, {
        knob: "0",
        state: {
          intestBetaBuilt: `mobile:${OLD}`,
          intestBetaSha: HEAD,
          intestBetaReused: `mobile:${OLD}`,
        },
        compare: { [`${OLD}...${HEAD}`]: ahead("docs/a.md") },
      });
      const [o] = out(r);
      assert.deepEqual(
        o.dispatched.map((d) => d.id),
        ["mobile"],
      );
      assert.deepEqual(o.reused, []);
      assert.deepEqual(compares(r), []);
      assert.equal(r.issue.intestBetaReused ?? null, null);
      assert.equal(r.issue.intestBetaLanes, "mobile");
    });

    it("starts nothing when the reuse decision couldn't be recorded", () => {
      const r = run(dispatch, {
        lanes: "mobile,desktop",
        state: { intestBetaBuilt: `mobile:${OLD}`, intestBetaSha: PREV },
        compare: { [`${OLD}...${HEAD}`]: ahead("docs/a.md") },
        lockState: true,
      });
      const [o] = out(r);
      assert.deepEqual(o.dispatched, []);
      assert.deepEqual(
        o.reused.map((d) => d.id),
        ["mobile"],
      );
      assert.deepEqual(o.skipped, [
        { id: "desktop", reason: "state-write-failed, retrying next tick" },
      ]);
      assert.doesNotMatch(r.calls, /^root |dispatch-premerge/m);
      assert.equal(r.issue.intestBetaSha, PREV);
    });

    it("rebuilds a reused lane once its build grows too old, or stops being the last one", () => {
      for (const [why, state] of [
        [
          "61 days old",
          { intestBetaBuilt: `mobile:${OLD}`, intestBetaBuiltAt: builtAt(`mobile:${OLD}`, 61) },
        ],
        ["a newer build since", { intestBetaBuilt: `mobile:${PREV}` }],
      ]) {
        const r = run(dispatch, {
          state: {
            ...state,
            intestBetaSha: HEAD,
            intestBetaReused: `mobile:${OLD}`,
            intestBetaLanes: "",
          },
        });
        const [o] = out(r);
        assert.deepEqual(
          o.dispatched.map((d) => d.id),
          ["mobile"],
          why,
        );
        assert.deepEqual(o.reused, [], why);
        assert.match(
          r.log,
          /reused mobile beta from aaaaaaaaaaaa is over 60 days old or no longer its last build/,
          why,
        );
        assert.equal(r.issue.intestBetaReused ?? null, null, why);
        assert.equal(r.issue.intestBetaLanes, "mobile", why);
      }
      // Still fresh: kept, nothing built.
      const kept = run(dispatch, {
        state: {
          intestBetaBuilt: `mobile:${OLD}`,
          intestBetaSha: HEAD,
          intestBetaReused: `mobile:${OLD}`,
          intestBetaLanes: "",
        },
      });
      assert.deepEqual(
        out(kept)[0].reused.map((d) => d.id),
        ["mobile"],
      );
      assert.doesNotMatch(kept.calls, /dispatch-premerge/);
    });

    it("reports a reused lane only while the gate still lets it through", () => {
      const r = run(dispatch, {
        lanes: "mobile",
        state: {
          intestBetaSha: HEAD,
          intestBetaReused: `mobile:${OLD},desktop:${OLD}`,
          intestBetaBuilt: `mobile:${OLD},desktop:${OLD}`,
          intestBetaLanes: "",
        },
      });
      const [o] = out(r);
      assert.deepEqual(
        o.reused.map((d) => d.id),
        ["mobile"],
      );
      assert.deepEqual(o.dispatched, []);
    });
  });
});

describe("reused beta build numbers and the fallback line (ADR-0081, real bash)", () => {
  const FROM = "9248da9a0c630a0836ff781b224dc1d2a34faff7";
  const S12 = FROM.slice(0, 12);
  // The lane's own notice, from comment-intest-build.mjs, so a change to its
  // wording that the parser below can't read fails here.
  const notice = (platform, build, sha12 = S12, authorAssociation = "OWNER") => ({
    authorAssociation,
    body: buildBody({
      platform,
      build,
      track: "TestFlight",
      pr: 802,
      sha: `${sha12}${"0".repeat(28)}`,
    }),
  });
  const bash = (script, env = {}) => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
${["intest_reused_json", "intest_reused_builds", "intest_fallback_comment"]
  .map((f) => `eval "$(awk '/^${f}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`)
  .join("\n")}
LOG_FILE=/dev/null
# The comment body is gh's last argument; its output goes to $LOG_FILE.
gh() { local last=""; for last in "$@"; do :; done; printf '%s' "$last" >"$BODY_FILE"; }
BODY_FILE=$(mktemp)
${script}
if [[ -s "$BODY_FILE" ]]; then cat "$BODY_FILE"; fi
rm -f "$BODY_FILE"`,
      ],
      { encoding: "utf8", env: { ...process.env, ...env } },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const builds = (beta, comments) =>
    JSON.parse(
      bash('intest_reused_builds "$BETA" "$COMMENTS"', {
        BETA: JSON.stringify(beta),
        COMMENTS: JSON.stringify(comments),
      }),
    );

  it("fills each reused lane's build numbers from the factory's own notices", () => {
    const beta = {
      dispatched: [],
      reused: [
        { id: "mobile", fromSha: FROM, builds: [] },
        { id: "desktop", fromSha: FROM, builds: [] },
      ],
    };
    const out = builds(beta, [
      notice("ios", 146),
      notice("android", 151),
      notice("ios", 147), // the retry's notice wins
      notice("android", 152),
      notice("macos", 80),
      notice("android", 999, "ffffffffffff"), // another commit
      notice("ios", 666, S12, "NONE"), // not the factory: anyone can comment
      { authorAssociation: "OWNER", body: `iOS build 5 @ \`${S12}\`, no marker` },
    ]);
    assert.deepEqual(out.reused, [
      {
        id: "mobile",
        fromSha: FROM,
        builds: [
          { platform: "android", build: "152" },
          { platform: "ios", build: "147" },
        ],
      },
      { id: "desktop", fromSha: FROM, builds: [{ platform: "macos", build: "80" }] },
    ]);
    assert.deepEqual(out.dispatched, []);
  });

  it("leaves the payload alone without reused lanes, or when the comments are bad", () => {
    const plain = { dispatched: [{ id: "mobile" }], skipped: [], manualCommands: [] };
    assert.deepEqual(builds(plain, [notice("ios", 1)]), plain);
    const out = bash('intest_reused_builds "$BETA" "not json"', {
      BETA: JSON.stringify({ reused: [{ id: "mobile", fromSha: FROM, builds: [] }] }),
    });
    assert.deepEqual(JSON.parse(out).reused[0].builds, []);
  });

  it("hands the scenario writer the build numbers (real intest_handoff, dry run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drafto-reuse-handoff-"));
    try {
      const promptFile = join(dir, "prompt.md");
      writeFileSync(promptFile, "prompt");
      const comments = JSON.stringify([notice("ios", 147), notice("android", 152)]);
      const beta = JSON.stringify({
        dispatched: [],
        skipped: [],
        manualCommands: [],
        reused: [{ id: "mobile", fromSha: FROM, builds: [] }],
      });
      const r = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
${["build_intest_bundle", "intest_reused_builds", "intest_handoff"]
  .map((f) => `eval "$(awk '/^${f}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`)
  .join("\n")}
SCRIPT_DIR="${resolve(HERE, "..")}"
LOG_FILE=/dev/null
REPO_ROOT="${dir}"
DRY_RUN=1
INTEST_PROMPT_FILE="${promptFile}"
SUPPORT_ALLOWLIST="a@example.com"
OAUTH_USER_EMAIL="support@example.com"
PHASE="C"
log() { :; }
fetch_issue_record() { echo '{"number":794,"title":"t","body":"","labels":[]}'; }
fetch_issue_comments() { printf '%s' "$COMMENTS"; }
extract_plan_comment() { echo null; }
gh() { :; }
intest_handoff 794 802 '{"number":802,"url":"u","headRef":"h","state":"OPEN"}' "" "" ${"c".repeat(40)} "apps/mobile/a.ts" '{"mobile":true}' "$BETA" ""`,
        ],
        { encoding: "utf8", env: { ...process.env, COMMENTS: comments, BETA: beta } },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout).betaDispatch.reused, [
        {
          id: "mobile",
          fromSha: FROM,
          builds: [
            { platform: "android", build: "152" },
            { platform: "ios", build: "147" },
          ],
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns intestBetaReused into the reused list, keeping only the gated lanes", () => {
    const csv = `mobile:${FROM},desktop:${FROM},bogus`;
    assert.deepEqual(JSON.parse(bash(`intest_reused_json "${csv}"`)), [
      { id: "mobile", fromSha: FROM, builds: [] },
      { id: "desktop", fromSha: FROM, builds: [] },
    ]);
    assert.deepEqual(JSON.parse(bash(`intest_reused_json "${csv}" desktop`)), [
      { id: "desktop", fromSha: FROM, builds: [] },
    ]);
    assert.deepEqual(JSON.parse(bash(`intest_reused_json "${csv}" ""`)), []);
    assert.deepEqual(JSON.parse(bash('intest_reused_json ""')), []);
  });

  it("renders the same line as the scenario bundle and the verification report", async () => {
    const { reusedBetaNote } = await import("../lib/factory-bundle.mjs");
    // Every shape of build list, so the jq and JS sentences, the Android caveat
    // included, can't drift apart.
    for (const builds of [
      [
        { platform: "android", build: "152" },
        { platform: "ios", build: "147" },
      ],
      [{ platform: "ios", build: "147" }],
      [{ platform: "android", build: "152" }],
      [],
    ]) {
      const variants = [
        { id: "mobile", fromSha: FROM, builds },
        {
          id: "desktop",
          fromSha: FROM,
          builds: builds.length ? [{ platform: "macos", build: "80" }] : [],
        },
      ];
      const out = bash(
        `intest_fallback_comment 794 802 "" "" ${"c".repeat(40)} '{"web":false,"mobile":true,"desktop":true}' "$BETA"`,
        { BETA: JSON.stringify({ dispatched: [], reused: variants }) },
      );
      assert.ok(out.includes(`- **iOS / Android** — ${reusedBetaNote(variants[0])}\n`), out);
      assert.ok(out.includes(`- **macOS** — ${reusedBetaNote(variants[1])}\n`), out);
      assert.match(
        out,
        /\*\*iOS \/ Android\*\* — .*Play's internal track serves only its newest upload/,
      );
      assert.doesNotMatch(out.split("- **macOS** — ")[1], /Play/);
    }
    const reused = [
      {
        id: "mobile",
        fromSha: FROM,
        builds: [
          { platform: "android", build: "152" },
          { platform: "ios", build: "147" },
        ],
      },
      { id: "desktop", fromSha: FROM, builds: [] },
    ];
    const body = bash(
      `intest_fallback_comment 794 802 "" "" ${"c".repeat(40)} '{"web":false,"mobile":true,"desktop":true}' "$BETA"`,
      { BETA: JSON.stringify({ dispatched: [], skipped: [], manualCommands: [], reused }) },
    );
    assert.ok(body.includes(`- **iOS / Android** — ${reusedBetaNote(reused[0])}\n`), body);
    assert.ok(body.includes(`- **macOS** — ${reusedBetaNote(reused[1])}\n`), body);
    assert.match(body, /No macOS change since the beta built from `9248da9a0c63`/);
    assert.doesNotMatch(
      body,
      /building now|no TestFlight build was dispatched|run the branch locally/,
    );
    // A lane built for this commit still reads as building now.
    const dispatched = bash(
      `intest_fallback_comment 794 802 "" "" ${"c".repeat(40)} '{"web":false,"mobile":true,"desktop":true}' "$BETA"`,
      {
        BETA: JSON.stringify({ dispatched: [{ id: "mobile" }], reused: [reused[1]] }),
      },
    );
    assert.match(dispatched, /\*\*iOS \/ Android\*\* — beta builds are building now/);
    assert.ok(dispatched.includes(`- **macOS** — ${reusedBetaNote(reused[1])}\n`));
  });
});

describe("beta reuse wiring (ADR-0081)", () => {
  it("defines a validated kill switch, on by default, that fails off", () => {
    assert.match(script, /^FACTORY_INTEST_BETA_REUSE="\$\{FACTORY_INTEST_BETA_REUSE:-1\}"$/m);
    assert.match(script, /invalid FACTORY_INTEST_BETA_REUSE='[^']*'; turning beta reuse off/);
    for (const fn of ["intest_beta_reuse_decide", "intest_dispatch_betas"]) {
      assert.match(fnBody(fn), /\$\{FACTORY_INTEST_BETA_REUSE:-1\}/, fn);
    }
  });

  it("decides reuse only for a new head, before choosing what to dispatch", () => {
    const body = fnBody("intest_dispatch_betas");
    const reset = body.indexOf('if [[ -z "$sha" || "$prior_sha" != "$sha" ]]; then');
    const decideAt = body.indexOf("intest_beta_reuse_decide");
    const fi = body.indexOf("\n  fi\n", reset);
    const loop = body.indexOf('for want in $(echo "$lanes"');
    assert.ok(reset !== -1 && reset < decideAt && decideAt < fi && fi < loop);
    assert.match(body, /\[\[ ",\$reused_csv," == \*",\$want:"\* \]\]/);
  });

  it("rewrites intestBetaReused with every dispatch it records", () => {
    const body = fnBody("intest_dispatch_betas");
    const shaWrite = body.indexOf('intestBetaSha "$sha"');
    const reusedWrite = body.indexOf('intestBetaReused "$reused_csv"');
    const elseIdx = body.indexOf("leaving retry armed");
    // Before the SHA: the field is only read under a matching SHA.
    assert.ok(reusedWrite !== -1 && reusedWrite < shaWrite && shaWrite < elseIdx);
  });

  it("records a reuse decision in one state write, all of it or none", () => {
    const body = fnBody("intest_beta_reuse_decide");
    assert.equal(body.split("state-cli.mjs").length - 1, 1, "exactly one state-cli call");
    assert.match(body, /factory:set-issue-fields "\$issue_num" "\$\{fields\[@\]\}"/);
    assert.match(
      body,
      /fields\+=\(intestBetaLanes "" intestBetaAttempts "" intestBetaReused "\$reused" intestBetaSha "\$sha"\)/,
    );
    // Its failure is acted on, never swallowed.
    assert.doesNotMatch(body, /--state-file "\$STATE_FILE" >>"\$LOG_FILE" 2>&1 \|\| true/);
    // The dispatch's own record of what it started is one write too.
    const dispatch = fnBody("intest_dispatch_betas");
    assert.equal(
      (dispatch.match(/factory:set-issue-fields? /g) || []).length,
      1,
      "the success branch writes once",
    );
    assert.match(
      dispatch,
      /factory:set-issue-fields "\$issue_num" \\\n\s+intestBetaReused "\$reused_csv"/,
    );
  });

  it("defines a validated maximum age for a reused build, 60 days by default", () => {
    assert.match(
      script,
      /^FACTORY_INTEST_BETA_REUSE_MAX_DAYS="\$\{FACTORY_INTEST_BETA_REUSE_MAX_DAYS:-60\}"$/m,
    );
    const block = script.slice(
      script.indexOf('FACTORY_INTEST_BETA_REUSE_MAX_DAYS="'),
      script.indexOf("fi\n", script.indexOf('FACTORY_INTEST_BETA_REUSE_MAX_DAYS="')) + 3,
    );
    for (const [value, want] of [
      ["", "60"],
      ["7", "7"],
      ["0", "60"],
      ["-3", "60"],
      ["sixty", "60"],
    ]) {
      const r = spawnSync(
        "bash",
        ["-c", `set -u\n${block}\necho "$FACTORY_INTEST_BETA_REUSE_MAX_DAYS"`],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH, FACTORY_INTEST_BETA_REUSE_MAX_DAYS: value },
        },
      );
      assert.equal(r.stdout.trim(), want, value);
      if (want !== value && value !== "")
        assert.match(r.stderr, /invalid FACTORY_INTEST_BETA_REUSE_MAX_DAYS/);
    }
  });

  it("reports the reused lanes on every path that reports a dispatch", () => {
    const body = fnBody("intest_dispatch_betas");
    // Every jq that prints the payload after the decision carries them.
    const after = body.slice(body.indexOf("reused_json=$(intest_reused_json"));
    const outputs = after.match(/manualCommands: (?:\$manual|\[\])[^}]*\}/g) || [];
    assert.equal(outputs.length, 6, outputs.join("\n"));
    for (const o of outputs) assert.match(o, /reused: \$reused/);
  });

  it("gives the scenario writer and the report the build numbers", () => {
    const handoff = fnBody("intest_handoff");
    const fetchAt = handoff.indexOf("comments_json=$(fetch_issue_comments");
    const fillAt = handoff.indexOf(
      'beta_json=$(intest_reused_builds "$beta_json" "$comments_json")',
    );
    const bundleAt = handoff.indexOf("build_intest_bundle");
    assert.ok(fetchAt !== -1 && fetchAt < fillAt && fillAt < bundleAt);
    const report = fnBody("verify_compose_report");
    assert.match(report, /intest_reused_builds/);
    assert.match(report, /--beta-reused "\$beta_reused"/);
  });
});

// ── Incremental scenario rewrite (ADR-0082) ────────────────────────────────

describe("scenario knobs (ADR-0082)", () => {
  const block = (() => {
    const start = script.indexOf(
      'FACTORY_SCENARIO_INCREMENTAL="${FACTORY_SCENARIO_INCREMENTAL:-1}"',
    );
    const endMarker = "  FACTORY_SCENARIO_FULL_EVERY=4\nfi\n";
    const end = script.indexOf(endMarker, start);
    assert.ok(start !== -1 && end !== -1, "could not find the scenario knobs");
    return script.slice(start, end + endMarker.length);
  })();
  const knobs = (env) => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        `set -u\n${block}\necho "$FACTORY_SCENARIO_INCREMENTAL $FACTORY_SCENARIO_DELTA_MAX_LINES $FACTORY_SCENARIO_FULL_EVERY"`,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
    );
    assert.equal(r.status, 0, r.stderr);
    return { values: r.stdout.trim(), warnings: r.stderr };
  };

  it("defaults to incremental, 800 lines, a full rewrite every 4 rounds", () => {
    assert.deepEqual(knobs({}), { values: "1 800 4", warnings: "" });
  });

  it("takes valid overrides, 0 switching the incremental mode off", () => {
    const r = knobs({
      FACTORY_SCENARIO_INCREMENTAL: "0",
      FACTORY_SCENARIO_DELTA_MAX_LINES: "1500",
      FACTORY_SCENARIO_FULL_EVERY: "2",
    });
    assert.equal(r.values, "0 1500 2");
  });

  it("warns and falls back to the default on an invalid value", () => {
    const r = knobs({
      FACTORY_SCENARIO_INCREMENTAL: "yes",
      FACTORY_SCENARIO_DELTA_MAX_LINES: "0",
      FACTORY_SCENARIO_FULL_EVERY: "-1",
    });
    assert.equal(r.values, "1 800 4");
    for (const name of [
      "FACTORY_SCENARIO_INCREMENTAL",
      "FACTORY_SCENARIO_DELTA_MAX_LINES",
      "FACTORY_SCENARIO_FULL_EVERY",
    ]) {
      assert.match(r.warnings, new RegExp(`WARNING: invalid ${name}=`));
    }
  });

  it("keeps the stored diffs under the log dir, reaped at 30 days and with a merged card", () => {
    assert.match(script, /^SCENARIO_DIFF_DIR="\$LOG_DIR\/scenario"$/m);
    assert.match(
      script,
      /find "\$SCENARIO_DIFF_DIR" -maxdepth 1 -type f \\\( -name '\*\.diff' -o -name '\*\.json' -o -name '\*\.json\.tmp' \\\) -mtime \+30 -delete/,
    );
    assert.match(
      fnBody("release_slot_and_worktree"),
      /\[\[ "\$known_state" == "MERGED" \]\] && scenario_diff_prune "\$issue_num"/,
    );
  });
});

describe("intest_handoff — exact-SHA check, writer skip and incremental mode (real bash, ADR-0082)", () => {
  const SHA_OLD = "1".repeat(40);
  const HEAD = "2".repeat(40);
  const ISSUE = 794;
  const extract = (name) => {
    const m = script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
    assert.ok(m, `could not extract ${name}`);
    return m[0];
  };
  const FNS = [
    "build_intest_bundle",
    "intest_fallback_comment",
    "intest_record_comment_sha",
    "scenario_comment_state",
    "scenario_diff_store",
    "scenario_diff_prune",
    "pr_head_oid",
    "intest_reused_builds",
    "intest_handoff",
  ];
  const scenarioBody = (sha, steps = "1. Open /notes — expected: the list loads.") =>
    `🏭 **Ready to test — In Test.**\n\n## Test scenario\n\n### Web\n\n${steps}\n\n<!-- drafto-factory-in-test -->\n<!-- drafto-factory-test-scenario -->\n<!-- drafto-factory-scenario-sha:${sha} -->`;
  const owner = (id, body, createdAt = "2026-11-10T00:00:00Z") => ({
    id,
    user: { login: "JakubAnderwald" },
    body,
    createdAt,
    authorAssociation: "OWNER",
  });
  const fileDiff = (file, line) =>
    `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,3 @@\n keep\n+${line}\n keep`;

  // Runs the real intest_handoff. gh, the issue reads and run-claude.mjs are
  // stubbed; factory-bundle.mjs and state-cli.mjs are real.
  function run({
    comments = [],
    prDiff = fileDiff("apps/web/a.ts", "v2"),
    claude = "post",
    stored = {},
    rounds = null,
    incremental = "1",
    fullEvery = "4",
    maxLines = "800",
    dryRun = 0,
    platforms = '{"mobile":false,"desktop":false,"web":true}',
    headAfterDiff = HEAD,
    commentsFailAfterRun = false,
  } = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "factory-scenario-delta-")));
    const logDir = join(dir, "logs", "factory");
    const scenarioDir = join(logDir, "scenario");
    mkdirSync(scenarioDir, { recursive: true });
    for (const [sha, { diff, plats }] of Object.entries(stored)) {
      const base = join(scenarioDir, `${ISSUE}-${sha.slice(0, 12)}`);
      writeFileSync(`${base}.diff`, diff);
      writeFileSync(`${base}.json`, JSON.stringify({ headSha: sha, platforms: plats }));
    }
    const commentsFile = join(dir, "comments.json");
    writeFileSync(commentsFile, JSON.stringify(comments));
    const stateFile = join(dir, "state.json");
    writeFileSync(
      stateFile,
      JSON.stringify({
        issues: { [ISSUE]: rounds === null ? {} : { intestScenarioRounds: rounds } },
      }),
    );
    writeFileSync(join(dir, "pr.diff"), prDiff);
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "prompt");
    const harness = `
set -euo pipefail
SCRIPT_DIR=${JSON.stringify(resolve(HERE, ".."))}
REPO_ROOT=${JSON.stringify(dir)}
LOG_DIR=${JSON.stringify(logDir)}
SCENARIO_DIFF_DIR=${JSON.stringify(scenarioDir)}
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
STATE_FILE=${JSON.stringify(stateFile)}
CALLS=${JSON.stringify(join(dir, "calls.log"))}
COMMENTS_FILE=${JSON.stringify(commentsFile)}
DRY_RUN=${dryRun}
INTEST_PROMPT_FILE=${JSON.stringify(promptFile)}
INTEST_TIMEOUT_SEC=60
FACTORY_PLAN_EFFORT=xhigh
FACTORY_SCENARIO_INCREMENTAL=${incremental}
FACTORY_SCENARIO_DELTA_MAX_LINES=${maxLines}
FACTORY_SCENARIO_FULL_EVERY=${fullEvery}
SUPPORT_ALLOWLIST="a@example.com"
OAUTH_USER_EMAIL="support@example.com"
PHASE=C
HEAD=${HEAD}
HEAD_AFTER_DIFF=${JSON.stringify(headAfterDiff)}
COMMENTS_FAIL_AFTER_RUN=${commentsFailAfterRun ? 1 : 0}
CLAUDE_MODE=${claude}
touch "$CALLS"
log() { echo "LOG: $*" >>"$LOG_FILE"; }
logerr() { echo "ERR: $*" >>"$LOG_FILE"; }
fetch_issue_record() { echo '{"number":${ISSUE},"title":"quota","body":"","labels":[]}'; }
fetch_issue_comments() {
  [[ "$COMMENTS_FAIL_AFTER_RUN" == 1 && -f "$REPO_ROOT/claude.input" ]] && return 1
  cat "$COMMENTS_FILE"
}
extract_plan_comment() { echo null; }
check_session_limit() { return 1; }
pause_for_session_limit() { :; }
gh() {
  echo "gh $1 $2" >>"$CALLS"
  case "$1 $2" in
    "pr diff") cat ${JSON.stringify(join(dir, "pr.diff"))} ;;
    "pr view") echo "$HEAD_AFTER_DIFF" ;;
    "issue comment")
      local body="" prev="" a
      for a in "$@"; do [[ "$prev" == "--body" ]] && body="$a"; prev="$a"; done
      jq -c --arg b "$body" '. + [{id: (length + 100), user: {login: "JakubAnderwald"}, body: $b,
        createdAt: "2026-11-16T00:00:00Z", authorAssociation: "OWNER"}]' "$COMMENTS_FILE" \\
        >"$COMMENTS_FILE.tmp" && mv "$COMMENTS_FILE.tmp" "$COMMENTS_FILE"
      ;;
  esac
}
node() {
  if [[ "\${1:-}" == */run-claude.mjs ]]; then
    echo "claude" >>"$CALLS"
    printf '%s' "$3" >"$REPO_ROOT/claude.input"
    case "$CLAUDE_MODE" in
      silent) return 0 ;;
      post|post-then-timeout)
        gh issue comment ${ISSUE} --body "$(printf '## Test scenario\\n\\n### Web\\n\\n1. new step\\n\\n<!-- drafto-factory-in-test -->\\n<!-- drafto-factory-test-scenario -->\\n<!-- drafto-factory-scenario-sha:%s -->' "$HEAD")"
        [[ "$CLAUDE_MODE" == "post" ]] || return 124
        echo "issue=${ISSUE} action=commented comment=https://example.invalid/c"
        return 0 ;;
      timeout) return 124 ;;
      *) return 1 ;;
    esac
  fi
  command node "$@"
}
${FNS.map(extract).join("\n")}
intest_handoff ${ISSUE} 802 '{"number":802,"url":"u","headRef":"factory/issue-${ISSUE}","state":"OPEN"}' "https://preview.example" "" "$HEAD" "apps/web/a.ts" '${platforms}' "" ""
`;
    try {
      const r = spawnSync("bash", ["-c", harness], { encoding: "utf8", env: { ...process.env } });
      const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
      const input = read(join(dir, "claude.input"));
      const json = /```json\n([\s\S]*)\n```/.exec(input);
      const files = readdirSafe(scenarioDir);
      const stored = Object.fromEntries(
        files.map((name) => [
          name,
          {
            mode: (statSync(join(scenarioDir, name)).mode & 0o777).toString(8),
            text: readFileSync(join(scenarioDir, name), "utf8"),
          },
        ]),
      );
      return {
        status: r.status,
        stderr: r.stderr,
        stdout: r.stdout,
        calls: read(join(dir, "calls.log")),
        log: read(join(dir, "agent.log")),
        comments: JSON.parse(read(commentsFile)),
        state: JSON.parse(read(stateFile)).issues[ISSUE],
        bundle: json ? JSON.parse(json[1]) : null,
        files,
        modeOf: (name) => stored[name]?.mode,
        readStored: (name) => stored[name]?.text,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const readdirSafe = (d) => (existsSync(d) ? readdirSync(d).sort() : []);
  const fallbacks = (r) =>
    r.comments.filter((c) => c.body.includes("drafto-factory-scenario-fallback"));

  it("posts the fallback when a clean run posts nothing, though an older scenario exists", () => {
    // The bug: issue_has_marker matched the older scenario's test-scenario
    // marker, so the head was left with no scenario and no fallback.
    const r = run({ comments: [owner(1, scenarioBody(SHA_OLD))], claude: "silent" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.calls, /^claude$/m);
    assert.equal(fallbacks(r).length, 1);
    assert.ok(fallbacks(r)[0].body.includes(`<!-- drafto-factory-scenario-sha:${HEAD} -->`));
    assert.match(
      r.log,
      /no test scenario for 222222222222 found \(action=none\); posting fallback/,
    );
    assert.equal(r.state.intestCommentSha, HEAD);
  });

  it("doesn't post a second fallback for a head that already has one", () => {
    const prior = owner(
      1,
      `fallback\n<!-- drafto-factory-scenario-fallback -->\n<!-- drafto-factory-scenario-sha:${HEAD} -->`,
    );
    const r = run({ comments: [prior], claude: "silent" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.calls, /^claude$/m, "a fallback-only head still gets the writer");
    assert.equal(fallbacks(r).length, 1);
    assert.match(r.log, /its fallback comment is already posted/);
  });

  it("skips the writer when a real scenario for exactly this head is posted", () => {
    const r = run({ comments: [owner(1, scenarioBody(HEAD))] });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.calls, /claude|pr diff|issue comment/);
    assert.match(
      r.log,
      /a test scenario for 222222222222 is already posted; not invoking the writer/,
    );
    assert.equal(r.state.intestCommentSha, HEAD);
    assert.equal(r.comments.length, 1);
  });

  it("doesn't skip for someone else's comment that copies the marker", () => {
    const spoof = { ...owner(1, scenarioBody(HEAD)), authorAssociation: "NONE" };
    const r = run({ comments: [spoof] });
    assert.match(r.calls, /^claude$/m);
  });

  it("writes the first scenario in full mode and stores the diff (mode 600) for the next head", () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.bundle.prDiffMode, "full");
    assert.equal(r.bundle.prDiffModeReason, "no-prior-scenario");
    assert.match(r.bundle.prDiffEnveloped, /\+v2/);
    assert.deepEqual(r.files, [`${ISSUE}-222222222222.diff`, `${ISSUE}-222222222222.json`]);
    assert.equal(r.modeOf(`${ISSUE}-222222222222.diff`), "600");
    assert.equal(r.modeOf(`${ISSUE}-222222222222.json`), "600");
    assert.match(r.readStored(`${ISSUE}-222222222222.diff`), /\+v2/);
    assert.deepEqual(JSON.parse(r.readStored(`${ISSUE}-222222222222.json`)), {
      headSha: HEAD,
      platforms: { mobile: false, desktop: false, web: true },
    });
    assert.equal(r.state.intestScenarioRounds, null);
    assert.equal(fallbacks(r).length, 0);
  });

  const webPlats = { mobile: false, desktop: false, web: true };
  const prior = () => ({
    comments: [owner(1, scenarioBody(SHA_OLD))],
    stored: { [SHA_OLD]: { diff: fileDiff("apps/web/a.ts", "v1"), plats: webPlats } },
  });

  it("sends only the delta and the prior scenario when the head moves, and counts the round", () => {
    const r = run({ ...prior(), rounds: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.bundle.prDiffMode, "delta");
    assert.equal(r.bundle.prDiffEnveloped, "");
    assert.equal(r.bundle.priorScenarioSha, SHA_OLD);
    assert.match(r.bundle.priorScenarioEnveloped, /^<prior-scenario>[\s\S]*### Web/);
    assert.deepEqual(r.bundle.deltaFiles, [{ path: "apps/web/a.ts", status: "changed" }]);
    assert.match(r.bundle.deltaDiffEnveloped, /\+v2/);
    assert.match(r.log, /scenario for 222222222222 in delta mode \(1 file\(s\)/);
    assert.equal(r.state.intestScenarioRounds, "2");
    // The new scenario builds on this head's diff only.
    assert.deepEqual(r.files, [`${ISSUE}-222222222222.diff`, `${ISSUE}-222222222222.json`]);
  });

  it("rewrites from the whole diff every FACTORY_SCENARIO_FULL_EVERY rounds, and resets the count", () => {
    const r = run({ ...prior(), rounds: "4", fullEvery: "4" });
    assert.equal(r.bundle.prDiffMode, "full");
    assert.equal(r.bundle.prDiffModeReason, "full-every-4");
    assert.equal(r.state.intestScenarioRounds, null);
  });

  it("uses the whole diff when the platforms changed or the delta is too large", () => {
    const plat = run({ ...prior(), platforms: '{"mobile":true,"desktop":false,"web":true}' });
    assert.equal(plat.bundle.prDiffModeReason, "platforms-changed");
    const big = run({ ...prior(), maxLines: "3" });
    assert.equal(big.bundle.prDiffModeReason, "delta-over-3-lines");
  });

  it("is the full mode, with nothing stored, when switched off", () => {
    const r = run({ ...prior(), incremental: "0", rounds: "2" });
    assert.equal(r.bundle.prDiffMode, "full");
    assert.equal(r.bundle.prDiffModeReason, "");
    assert.deepEqual(r.files, [`${ISSUE}-111111111111.diff`, `${ISSUE}-111111111111.json`]);
    assert.equal(r.state.intestScenarioRounds, "2", "the count is left alone while off");
  });

  it("keeps the prior diff when the run falls back, so the next head can still use it", () => {
    const r = run({ ...prior(), claude: "silent", rounds: "1" });
    assert.equal(fallbacks(r).length, 1);
    assert.equal(r.state.intestScenarioRounds, "1");
    assert.ok(r.files.includes(`${ISSUE}-111111111111.diff`));
  });

  it("treats a run that posted and then timed out as posted: no fallback, the round counts", () => {
    const r = run({ ...prior(), claude: "post-then-timeout", rounds: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fallbacks(r).length, 0);
    assert.match(r.log, /claude timed out writing the In Test scenario/);
    assert.match(r.log, /test scenario posted \(action=exit-124, delta mode\)/);
    assert.equal(r.state.intestScenarioRounds, "2");
    assert.equal(r.state.intestCommentSha, HEAD);
  });

  it("still posts the fallback after a timeout that posted nothing, but only once per head", () => {
    const first = run({ claude: "timeout" });
    assert.equal(fallbacks(first).length, 1);
    assert.match(
      first.log,
      /no test scenario for 222222222222 found \(action=exit-124\); posting fallback/,
    );
    const again = run({ comments: first.comments, claude: "timeout" });
    assert.equal(fallbacks(again).length, 1, "no second fallback for the same head");
  });

  it("keeps no diff, and runs in full mode, when the head moved while the diff was read", () => {
    // gh pr diff reads whatever the head is then: a newer head's diff must
    // never be filed under this head's SHA, nor compared as if it were.
    for (const headAfterDiff of ["3".repeat(40), ""]) {
      const r = run({ ...prior(), headAfterDiff, rounds: "1" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.bundle.prDiffMode, "full");
      assert.match(r.log, /after reading its diff, not 2{40}; not keeping the diff \(full mode\)/);
      assert.deepEqual(r.files, [`${ISSUE}-111111111111.diff`, `${ISSUE}-111111111111.json`]);
      assert.equal(
        r.state.intestScenarioRounds,
        "1",
        "a full run that wasn't counted leaves the count",
      );
    }
  });

  it("leaves the head unrecorded, with no fallback, when the comments can't be read after the run", () => {
    const r = run({ ...prior(), commentsFailAfterRun: true, rounds: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.calls, /^claude$/m);
    assert.equal(fallbacks(r).length, 0);
    assert.match(r.log, /leaving 222222222222 unrecorded so the next tick looks again/);
    assert.equal(r.state.intestCommentSha ?? null, null);
    assert.equal(r.state.intestScenarioRounds, "1");
  });

  it("prints the delta bundle under --dry-run without storing anything", () => {
    const r = run({ ...prior(), dryRun: 1 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).prDiffMode, "delta");
    assert.doesNotMatch(r.calls, /claude/);
    assert.deepEqual(r.files, [`${ISSUE}-111111111111.diff`, `${ISSUE}-111111111111.json`]);
  });
});

describe("scenario_diff_prune (real bash)", () => {
  it("removes an issue's stored diffs, keeping one head's, and never another issue's", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-scenario-prune-"));
    try {
      for (const name of [
        "794-111111111111.diff",
        "794-111111111111.json",
        "794-222222222222.diff",
        "794-222222222222.json",
        "79-333333333333.diff",
        "7940-444444444444.diff",
      ]) {
        writeFileSync(join(dir, name), "x");
      }
      const fn = script.match(/^scenario_diff_prune\(\) \{[\s\S]*?\n\}/m)[0];
      const prune = (args) => {
        const r = spawnSync(
          "bash",
          [
            "-c",
            `set -euo pipefail\nSCENARIO_DIFF_DIR=${JSON.stringify(dir)}\n${fn}\nscenario_diff_prune ${args}`,
          ],
          {
            encoding: "utf8",
          },
        );
        assert.equal(r.status, 0, r.stderr);
        return readdirSync(dir).sort();
      };
      assert.deepEqual(prune(`794 ${"2".repeat(40)}`), [
        "79-333333333333.diff",
        "794-222222222222.diff",
        "794-222222222222.json",
        "7940-444444444444.diff",
      ]);
      assert.deepEqual(prune("794"), ["79-333333333333.diff", "7940-444444444444.diff"]);
      assert.deepEqual(prune("not-a-number"), ["79-333333333333.diff", "7940-444444444444.diff"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
