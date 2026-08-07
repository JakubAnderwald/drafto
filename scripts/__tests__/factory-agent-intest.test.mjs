import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
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

  it("normalises modes so the tree it hands the build is not owner-only", () => {
    // The factory runs at umask 077, so git/pnpm/CocoaPods write mode 600 here.
    // Those files are copied verbatim into the .app, and App Store Connect
    // rejects the pkg with ITMS-90255. Three macOS uploads died this way on #463.
    assert.match(body, /chmod -R go\+rX "\$root"/);
  });

  it("normalises AFTER the install, not before it", () => {
    // pnpm/bundle create files too; chmod-ing first would leave the newest — and
    // largest — set of files still owner-only.
    const chmodIdx = body.indexOf("chmod -R go+rX");
    const installIdx = body.indexOf("run_pnpm_install");
    assert.ok(installIdx !== -1 && chmodIdx > installIdx, "chmod must run after the installs");
  });

  it("does NOT widen the env files it just seeded", () => {
    // copy_worktree_env brings real credentials into the root (the web
    // .env.local carries SUPABASE_SERVICE_ROLE_KEY). A blanket go+rX would
    // publish them to every account on the machine, and none of them belong in
    // an .app anyway.
    assert.match(body, /-name '\.env\*' -exec chmod go-rwx/);
    const chmodIdx = body.indexOf("chmod -R go+rX");
    const envIdx = body.indexOf("chmod go-rwx");
    assert.ok(envIdx > chmodIdx, "the env re-restriction must come after the blanket chmod");
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
            ...(dispatchedAgoMin === null
              ? {}
              : {
                  intestBetaAt: new Date(Date.now() - dispatchedAgoMin * 60_000)
                    .toISOString()
                    .replace(/\.\d+Z$/, "Z"),
                }),
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
    for (const [name, body] of Object.entries(decoys ?? {})) writeFileSync(join(dir, name), body);
    const snippet = `
set -uo pipefail
eval "$(awk '/^iso_age_min\(\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
eval "$(awk '/^lane_attempt_of\(\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
eval "$(awk '/^lane_attempt_set\(\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
eval "$(awk '/^intest_check_lane_outcomes\(\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
log() { echo "[log] $*"; }
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
FACTORY_LANE_MAX_ATTEMPTS=3
FACTORY_INTEST_BETA=1
DRY_RUN=${dryRun}
intest_check_lane_outcomes 463 ${JSON.stringify(sha)} 591
cat "$STATE_FILE"
`;
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
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
    const state = JSON.parse(readFileSync(r.stateFile, "utf8"));
    // state-cli normalises an empty value to null.
    assert.ok(
      !state.issues["463"].intestBetaLanes,
      "a dead lane must be re-armed (lane set cleared)",
    );
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
    assert.match(script, /apps\/mobile\/google-play-service-account\.json/);
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
