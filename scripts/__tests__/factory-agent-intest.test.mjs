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

  it("records the head SHA on EVERY path that posts a comment", () => {
    // The watch refresh re-fires the hand-off whenever intestCommentSha !=
    // headRefOid, so a posting path that returns without recording would
    // re-post the same comment every 5-minute tick — issue spam.
    const posts = (body.match(/intest_fallback_comment/g) || []).length;
    const records = (body.match(/intest_record_comment_sha/g) || []).length;
    assert.ok(posts >= 6, `expected a fallback on every failure path, got ${posts}`);
    // Five early-return paths pair 1:1 with a recorder; the sixth (marker
    // missing after a clean exit) falls through to the recorder at the tail,
    // which also covers the success path.
    assert.equal(
      records,
      posts,
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

  it("dispatches mobile only while the desktop knob is off (fossil not yet validated)", () => {
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
  const body = fnBody("ensure_beta_build_root");

  it("refuses to use the factory checkout or the fossil as a build root", () => {
    // It hard-resets and cleans the root. The fossil IS the operator's working
    // tree (permanently dirty — the desktop lane mutates Info.plist and
    // project.pbxproj), so resetting it would destroy real work.
    assert.match(body, /canon_root" == "\$canon_repo" \|\| "\$canon_root" == "\$canon_fossil"/);
    assert.match(body, /refusing to use \$root as a \$platform beta build root/);
    assert.match(body, /return 1/);
  });

  it("resolves paths before comparing them (a symlink must not defeat the guard)", () => {
    assert.match(body, /pwd -P/);
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
    assert.match(body, /seed_worktree_node_modules "\$root" "\$src_root" >&2/);
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

  it("bounds bundle install — it runs synchronously inside the watch tick", () => {
    assert.match(body, /run-with-timeout\.mjs" "\$INSTALL_TIMEOUT_SEC" bundle install/);
  });

  it("seeds desktop from the fossil and never installs into it", () => {
    assert.match(body, /desktop\) root="\$BETA_DESKTOP_ROOT"; src_root="\$DESKTOP_FOSSIL_ROOT"/);
    // The install/bundle step is mobile-only.
    const installIdx = body.indexOf("run_pnpm_install");
    const mobileGuardIdx = body.indexOf('platform" == "mobile"');
    assert.ok(
      mobileGuardIdx !== -1 && mobileGuardIdx < installIdx,
      "pnpm install must be gated to the mobile platform",
    );
  });
});

describe("intest_dispatch_betas — idempotency and reporting", () => {
  const body = fnBody("intest_dispatch_betas");

  it("keys idempotency on the head SHA, not a monotonic marker", () => {
    assert.match(body, /intestBetaSha/);
    assert.match(body, /"\$prior_sha" == "\$sha"/);
    assert.match(body, /beta already dispatched for/);
    // A marker would suppress forever and break the In Test iteration loop.
    assert.ok(!body.includes("issue_has_marker"), "must not gate on a monotonic marker");
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
    assert.match(body, /NEVER pnpm install here \(desktop fossil\)/);
  });

  it("never sends a human to git-checkout the fossil / operator working tree", () => {
    // The desktop manual command targets the dedicated build root, detached.
    assert.match(body, /\$desktopRoot/);
    assert.ok(
      !/cd \/Users\/jakub\/code\/drafto && git checkout/.test(body),
      "must not move the operator's working tree onto a PR branch",
    );
  });

  it("merges node-side lane refusals with bash-side gate skips", () => {
    // A fossil-assertion refusal must reach the comment, not vanish.
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

describe("pre-merge beta knobs", () => {
  it("defaults both knobs off", () => {
    assert.match(script, /FACTORY_INTEST_BETA="\$\{FACTORY_INTEST_BETA:-0\}"/);
    assert.match(script, /FACTORY_INTEST_BETA_DESKTOP="\$\{FACTORY_INTEST_BETA_DESKTOP:-0\}"/);
  });

  it("points the build roots at dedicated paths, not the fossil or this checkout", () => {
    assert.match(
      script,
      /BETA_MOBILE_ROOT="\$\{DRAFTO_BETA_MOBILE_ROOT:-\/Users\/jakub\/code\/drafto-beta-mobile\}"/,
    );
    assert.match(
      script,
      /BETA_DESKTOP_ROOT="\$\{DRAFTO_DESKTOP_BUILD_ROOT:-\/Users\/jakub\/code\/drafto-beta-desktop\}"/,
    );
    assert.match(
      script,
      /DESKTOP_FOSSIL_ROOT="\$\{DRAFTO_DESKTOP_FOSSIL_ROOT:-\/Users\/jakub\/code\/drafto\}"/,
    );
  });

  it("dispatches betas before writing the scenario (the build takes 20-40 min)", () => {
    const handoff = fnBody("intest_handoff");
    const dispatchIdx = handoff.indexOf("intest_dispatch_betas");
    const bundleIdx = handoff.indexOf("build_intest_bundle");
    assert.ok(dispatchIdx !== -1 && dispatchIdx < bundleIdx, "dispatch must precede the bundle");
  });

  it("never lets a failed dispatch stop the scenario from being written", () => {
    const handoff = fnBody("intest_handoff");
    assert.match(
      handoff,
      /beta_json=\$\(intest_dispatch_betas[\s\S]{0,200}\|\| echo '\{"dispatched"/,
    );
  });

  it("copies the Play service-account key into build roots (Android lane needs it)", () => {
    assert.match(script, /apps\/mobile\/google-play-service-account\.json/);
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
