import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
function fnBody(name) {
  const re = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m");
  const m = script.match(re);
  assert.ok(m, `could not find ${name}()`);
  return m[0];
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
    // non-zero exit, session limit, and a missing marker after a clean exit.
    const calls = body.match(/intest_fallback_comment/g) || [];
    assert.ok(calls.length >= 6, `expected a fallback on every failure path, got ${calls.length}`);
    assert.match(body, /exit_code -eq 124/);
    assert.match(body, /check_session_limit/);
  });

  it("trusts the posted marker over the model's directive line", () => {
    assert.match(body, /issue_has_marker "\$issue_num" "drafto-factory-test-scenario"/);
  });

  it("records the head SHA it wrote the scenario for", () => {
    assert.match(
      body,
      /factory:set-issue-field "\$issue_num" \\?\s*\n?\s*intestCommentSha "\$head_sha"/,
    );
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
    const dryRunSection = body.slice(body.indexOf('DRY_RUN" -eq 1'));
    assert.match(dryRunSection.slice(0, 400), /echo "\$bundle"/);
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

  it("gives per-platform local build instructions, fossil rule included", () => {
    assert.match(body, /if \[\[ "\$mobile" == "true" \]\]; then/);
    assert.match(body, /if \[\[ "\$desktop" == "true" \]\]; then/);
    assert.match(body, /never\*\*[^\n]*pnpm install/);
  });

  it("surfaces advisory reds", () => {
    assert.match(body, /Advisory \(non-required\) checks are not green: \$advisory/);
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
    const hwmIdx = sweepBlock.indexOf('HWM=$(echo "$ISSUE_STATE_JSON"');
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
