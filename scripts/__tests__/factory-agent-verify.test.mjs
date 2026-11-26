import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isTerminalLaneState } from "../lib/verify-decide.mjs";

// The pre-In-Test verification stage's bash wiring, the Testing column
// (ADR-0053). The decisions live in scripts/lib/verify-decide.mjs (its own
// matrix test); what factory-agent.sh must guarantee is what these lock in:
//   1. the settings parse under the Mac mini's /bin/bash 3.2, bad values fall
//      back, and the switch is off by default;
//   2. with FACTORY_VERIFY=0 the In Review promotion is today's, and nothing is
//      looked up; with the column missing, or the move failing, the card falls
//      through to that same promotion;
//   3. entry sits after the CodeRabbit gate and before the In Test promotion;
//      it advances first, writes the Testing-stage scenario, dispatches betas
//      and never resets the fix budget;
//   4. the Testing sweep sits between the In Review loop and the In Test sweep,
//      honours the per-card kill switches and survives a failed query;
//   5. a hand-back comments once per commit and reason, and counts the bounce;
//   6. promotion composes first, moves the card, then posts once (an OWNER
//      marker means already posted), and resets like today's promotion;
//   7. a report that couldn't be posted is retried by the In Test sweep, at
//      most VERIFY_REPORT_POST_MAX times, and only if the promotion wrote one;
//   8. the revision no-op path routes through verify_target_status and keeps
//      its literal In Test move, but only for the head shown at In Test; any
//      other head goes through the parity gate to In Review (#759);
//   9. the Web lane's screenshots (ADR-0096) are published only for a browser
//      lane that reported, whose dry render withheld neither its text nor the
//      body, and only after that render; the report is then composed again
//      with them inside the lane's <details>, and any failure posts the dry
//      render, with the promotion unchanged.
// Two layers, like the CodeRabbit lane's tests: static lock-ins over the
// source, and the real functions run in bash with gh, the board and the beta
// and scenario helpers stubbed (state-cli, verify-decide and verify-report are
// the real modules, on a temp state file; evidence-upload.mjs is a stub that
// records its argv and writes the upload record a test gives it).

const HERE = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(HERE, "..");
const scriptPath = resolve(scriptsDir, "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function extract(name) {
  const fn = script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(fn, `could not extract ${name}`);
  return fn[0];
}

function slice(startNeedle, endNeedle, from = 0) {
  const start = script.indexOf(startNeedle, from);
  assert.ok(start !== -1, `could not find ${startNeedle}`);
  const end = script.indexOf(endNeedle, start);
  assert.ok(end !== -1, `could not find ${endNeedle}`);
  return script.slice(start, end);
}

const watchStart = script.indexOf('\nif [[ "$MODE_WATCH" -eq 1 ]]; then');
const reviewLoop = slice("  # ── 2. In Review → In Test ──", "  # ── 2b. Testing sweep");
const verifyFns = [...script.matchAll(/^(verify_[a-z_]+)\(\) \{/gm)].map((m) => m[1]);

// Every verify_* function plus the real helpers they lean on. Everything that
// talks to GitHub, the board or claude is stubbed in the harness instead.
const REAL_HELPERS = [
  // The factory-device-run label (ADR-0106 decision 7).
  "device_run_label",
  "device_run_label_remove",
  "device_run_label_refuse",
  "device_ondemand_request",
  "device_ondemand_wait",
  "device_ondemand_cutoff_notice",
  // A ci-red hand-back forgets the no-op record (ADR-0102).
  "clear_ci_noop",
  "card_opted_out",
  "support_forward_filter",
  "gate_support_forwards",
  "owner_comments_since",
  "is_noise_comment",
  "has_actionable_feedback",
  "issue_has_marker",
  "pr_preview_url",
  "pr_failing_advisory",
  "pr_failing_required",
  "pr_pending_required",
  "ci_required_green",
  "browser_kind_enabled",
  "scenario_platforms",
  // The Web lane's screenshots (verify_publish_screenshots, ADR-0096).
  "evidence_ocr_bin",
  "evidence_ocr_provision",
  "evidence_ocr_spawn",
  "browser_guard_log",
  "evidence_upload",
  "comments_have_marker",
  "issue_marker_check",
  "migration_approval_vouch",
  "migration_approval_vouch_view",
  "intest_reused_json",
  "intest_reused_builds",
  "intest_reused_valid",
  "intest_reuse_fresh",
  "lane_attempt_of",
  // The device lane (ADR-0106): its follow-up comment.
  "device_card_column",
  "device_pr_head_is",
  "device_post_followup",
  "iso_age_min",
];

const STUBS = `
LANE_START_DEFAULT='{"started":false,"reason":"busy"}'
LANE_STOP_DEFAULT='{"state":"idle"}'
LANE_HK_DEFAULT='{"state":"idle","reaped":{}}'
LANE_GAPS_DEFAULT='{"gaps":[],"bypassUsed":false}'
DEVICE_START_DEFAULT='{"started":false,"reason":"deferred:busy"}'
DEVICE_STOP_DEFAULT='{"state":"idle"}'
DEVICE_HK_DEFAULT='{"state":"idle","reaped":null}'
log() { echo "LOG: $*" >> "$LOG_FILE"; }
logerr() { echo "ERR: $*" >> "$LOG_FILE"; }
call() { printf '%s\\n' "$*" >> "$CALLS"; }
# stub_flag <--flag> <argv…> — the value after <--flag> in <argv>.
stub_flag() {
  local want="$1" prev="" a
  shift
  for a in "$@"; do
    [[ "$prev" != "$want" ]] || { printf '%s\\n' "$a"; return 0; }
    prev="$a"
  done
  return 1
}
transition_status() { call "transition $3"; [[ "\${FAIL_TRANSITION:-}" != "$3" ]]; }
intest_check_lane_outcomes() { call "outcomes $*"; }
intest_dispatch_betas() { call "dispatch $1 $2 $3 $(echo "$4" | jq -c . 2>/dev/null || echo "$4")"; echo '{"dispatched":[],"skipped":[],"manualCommands":[]}'; }
intest_handoff() {
  call "handoff stage=\${INTEST_STAGE:-unset} cr_note=\${10:-}"
  call "handoff-platforms $(echo "$8" | jq -c . 2>/dev/null || echo "$8")"
}
fetch_issue_comments() { [[ -z "\${COMMENTS_FAIL:-}" ]] || return 1; cat "$COMMENTS_FILE"; }
find_prior_pr() { [[ -z "\${FIND_PR_FAIL:-}" ]] || return 0; echo "\${PR_OBJ_STUB:-null}"; }
fetch_review_threads() { call "threads $1"; [[ -z "\${THREADS_FAIL:-}" ]] || return 1; echo "\${THREADS_STUB:-[]}"; }
cr_coverage_note() { echo "\${CR_NOTE_STUB:-}"; }
gh() {
  call "gh $*"
  case "$1 $2" in
    "pr view") echo "$PR_VIEW_STUB" ;;
    "pr diff") [[ -z "\${DIFF_FAIL:-}" ]] || return 1; printf '%s\\n' "\${DIFF_STUB:-apps/web/a.ts}" ;;
    "issue comment")
      [[ -z "\${FAIL_COMMENT:-}" ]] || return 1
      # Post it, so a later fetch sees it (OWNER, like the Mac mini's identity).
      local body="" f="" a prev=""
      for a in "$@"; do
        [[ "$prev" == "--body" ]] && body="$a"
        [[ "$prev" == "--body-file" ]] && f="$a"
        prev="$a"
      done
      [[ -n "$f" ]] && body=$(cat "$f")
      jq -c --arg b "$body" '. + [{id: 99, user: {login: "JakubAnderwald"}, body: $b,
        createdAt: "2026-10-21T00:00:00Z", authorAssociation: "OWNER"}]' "$COMMENTS_FILE" \\
        > "$COMMENTS_FILE.tmp" && mv "$COMMENTS_FILE.tmp" "$COMMENTS_FILE"
      ;;
    "api repos/JakubAnderwald/drafto/labels/status:testing") [[ -z "\${NO_LABEL:-}" ]] ;;
    "issue edit") [[ -z "\${FAIL_LABEL_EDIT:-}" ]] ;;
    "issue view") printf '%s\\n' "\${ISSUE_VIEW_STUB:-}" ;;
  esac
}
node() {
  case "$1" in
    */factory-project.mjs)
      call "project $2 $3 $4"
      case "$2" in
        has-status-option) [[ -z "\${NO_OPTION:-}" ]] ;;
        query-status-items) [[ -z "\${QUERY_FAIL:-}" ]] || return 1; echo "\${TESTING_ITEMS:-[]}" ;;
        # The card's board column (device_card_column).
        item-status) [[ -z "\${ITEM_STATUS_FAIL:-}" ]] || return 1; printf '%s\\n' "\${ITEM_STATUS_STUB:-}" ;;
      esac
      ;;
    # dispatch-release.mjs is the real module: derive-platforms (and --verify)
    # reads the stubbed diff on stdin.
    # Never the real worktree CLI: it would remove a git worktree.
    */worktree-cli.mjs) call "worktree \${*:2}" ;;
    # Never the real hash CLI: it would fetch into REPO_ROOT (ADR-0078).
    */migration-approval.mjs)
      call "hash \${*:2}"
      [[ -n "\${HASH_STUB:-}" ]] || return 1
      echo "$HASH_STUB" ;;
    */verify-report.mjs)
      [[ -z "\${REPORT_FAIL:-}" ]] || return 1
      if [[ " $* " == *" --browser-images "* ]]; then
        [[ -z "\${TRACE_REPORT:-}" ]] || call "report images $(stub_flag --browser-images "$@")"
        [[ -z "\${REPORT_IMAGES_FAIL:-}" ]] || return 1
      elif [[ " $* " == *" --device-images "* ]]; then
        [[ -z "\${TRACE_REPORT:-}" ]] || call "report device-images $(stub_flag --device-images "$@")"
      else
        [[ -z "\${TRACE_REPORT:-}" ]] || call "report dry"
      fi
      command node "$@" ;;
    # The Web lane's screenshots: the argv, one JSON array per call, beside the
    # call log; UPLOAD_STUB is the record written to --out (none when unset).
    */evidence-upload.mjs)
      call "upload \${*:2}"
      printf '%s\\n' "\${@:2}" | jq -Rsc 'split("\\n")[:-1]' >> "$CALLS.uploads"
      [[ -z "\${UPLOAD_FAIL:-}" ]] || return 1
      [[ -z "\${UPLOAD_STUB:-}" ]] || printf '%s\\n' "$UPLOAD_STUB" > "$(stub_flag --out "$@")"
      echo '{"ok":true,"reason":null,"images":1}'
      ;;
    # The device lane's CLI (ADR-0106): its argv, and a canned JSON line.
    */device-lane.mjs)
      call "device \${*:2}"
      [[ -z "\${DEVICE_FAIL:-}" ]] || return 1
      case "$2" in
        start)
          # The scenario file as start saw it (bash removes it afterwards).
          if f=$(stub_flag --scenario-file "$@"); then
            { if [[ "$(uname)" == Darwin ]]; then stat -f '%Lp' "$f"; else stat -c '%a' "$f"; fi; cat "$f"; } > "$CALLS.scenario"
          fi
          printf '%s\\n' "\${DEVICE_START_STUB:-$DEVICE_START_DEFAULT}" ;;
        stop) printf '%s\\n' "\${DEVICE_STOP_STUB:-$DEVICE_STOP_DEFAULT}" ;;
        housekeeping) printf '%s\\n' "\${DEVICE_HK_STUB:-$DEVICE_HK_DEFAULT}" ;;
        # The real module: it reads the stubbed comments on stdin.
        scenario-file) command node "$@" ;;
      esac
      ;;
    */verify-lane.mjs)
      call "lane \${*:2}"
      [[ -z "\${LANE_FAIL:-}" ]] || return 1
      case "$2" in
        start) printf '%s\\n' "\${LANE_START_STUB:-$LANE_START_DEFAULT}" ;;
        stop) printf '%s\\n' "\${LANE_STOP_STUB:-$LANE_STOP_DEFAULT}" ;;
        housekeeping) printf '%s\\n' "\${LANE_HK_STUB:-$LANE_HK_DEFAULT}" ;;
        gaps) printf '%s\\n' "\${LANE_GAPS_STUB:-$LANE_GAPS_DEFAULT}" ;;
      esac
      ;;
    *) command node "$@" ;;
  esac
}
pause_for_session_limit() { call "pause until=$SESSION_LIMIT_RESET_AT reason=$SESSION_LIMIT_REASON"; }
`;

// Run <body> in /bin/bash (3.2 on the Mac mini, which launchd runs) with the
// verify functions loaded. Returns the exit
// status, stdout, the call log, the factory log, the state file's issue #7 and
// the comments as posted.
function runBash(body, { env = {}, state = {}, comments = [], bash = "/bin/bash" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "factory-verify-"));
  const files = {
    calls: join(dir, "calls.log"),
    log: join(dir, "factory.log"),
    state: join(dir, "factory-state.json"),
    comments: join(dir, "comments.json"),
  };
  writeFileSync(files.calls, "");
  writeFileSync(files.log, "");
  writeFileSync(files.state, JSON.stringify({ issues: { 7: state } }));
  writeFileSync(files.comments, JSON.stringify(comments));
  const harness = [
    "set -euo pipefail",
    `SCRIPT_DIR="${scriptsDir}"`,
    `REPO_ROOT="${dir}"`,
    `LOG_DIR="${dir}"`,
    'VERIFY_PROMPT_FILE="$SCRIPT_DIR/factory-verify-prompt.md"',
    "INSTALL_TIMEOUT_SEC=600",
    "FACTORY_PLAN_EFFORT=xhigh",
    "FACTORY_MIN_FREE_DISK_GB=3",
    `LOG_FILE="${files.log}"`,
    `STATE_FILE="${files.state}"`,
    `CALLS="${files.calls}"`,
    `COMMENTS_FILE="${files.comments}"`,
    "DRY_RUN=${DRY_RUN:-0}",
    "FACTORY_VERIFY=${FACTORY_VERIFY:-1}",
    'FACTORY_VERIFY_LANES="${FACTORY_VERIFY_LANES-shell,browser}"',
    'FACTORY_VERIFY_ONLY_LABEL="${FACTORY_VERIFY_ONLY_LABEL:-}"',
    "FACTORY_VERIFY_HOLD_MAX_MIN=${FACTORY_VERIFY_HOLD_MAX_MIN:-60}",
    "FACTORY_VERIFY_BOUNCE_MAX=${FACTORY_VERIFY_BOUNCE_MAX:-2}",
    `FACTORY_VERIFY_BYPASS_FILE="${join(dir, "no-bypass.env")}"`,
    `FACTORY_BROWSER_ACCOUNT_FILE="${join(dir, "account.env")}"`,
    `FACTORY_BROWSER_SIGNIN_KEY_FILE="${join(dir, "signin.env")}"`,
    `SIGNIN_LEASE_FILE="${join(dir, "factory-signin.lease")}"`,
    "FACTORY_CR_CLI=${FACTORY_CR_CLI:-0}",
    "FACTORY_BROWSER=${FACTORY_BROWSER:-1}",
    "FACTORY_EVIDENCE_UPLOAD=${FACTORY_EVIDENCE_UPLOAD:-1}",
    'FACTORY_BROWSER_KINDS="${FACTORY_BROWSER_KINDS-intest,verify}"',
    'VERIFY_BROWSER_CANDIDATES="${VERIFY_BROWSER_CANDIDATES_STUB:-}"',
    "REQUIRED_CONTEXTS_JSON='[\"Lint\"]'",
    script.match(/^VERIFY_REPORT_POST_MAX=.*$/m)[0],
    script.match(/^VERIFY_REPORT_RETRY_STEP_MIN=.*$/m)[0],
    script.match(/^VERIFY_DIR=.*$/m)[0],
    'VERIFY_BUILT_LANES="${VERIFY_BUILT_LANES_STUB:-}"',
    'VERIFY_COLUMN_READY=""',
    STUBS,
    ...REAL_HELPERS.map(extract),
    ...verifyFns.map(extract),
    body,
  ].join("\n");
  try {
    const r = spawnSync(bash, ["-c", harness], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
    const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
    let stateOut = {};
    try {
      stateOut = JSON.parse(read(files.state) || "{}");
    } catch {
      stateOut = {}; // a test that corrupts the state file on purpose
    }
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      calls: read(files.calls),
      log: read(files.log),
      issue: stateOut.issues?.["7"] ?? {},
      comments: JSON.parse(read(files.comments) || "[]"),
      dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

// runBash, cleaned up after the assertions in <fn>.
function withBash(body, opts, fn) {
  const r = runBash(body, opts);
  try {
    assert.equal(r.status, 0, `${r.stderr}\n--- log ---\n${r.log}`);
    fn(r);
  } finally {
    r.cleanup();
  }
}

const greenRollup = [{ name: "Lint", conclusion: "SUCCESS", status: "COMPLETED" }];
const prView = (over = {}) =>
  JSON.stringify({
    state: "OPEN",
    headRefOid: HEAD,
    statusCheckRollup: greenRollup,
    comments: [],
    ...over,
  });
const PR_OBJ = JSON.stringify({ number: 70, url: "u", headRef: "factory/issue-7", state: "OPEN" });

describe("factory-agent.sh verification stage: static wiring", () => {
  it("passes bash -n under both bashes", () => {
    for (const bash of ["bash", "/bin/bash"]) {
      const r = spawnSync(bash, ["-n", scriptPath], { encoding: "utf8" });
      assert.equal(r.status, 0, `${bash}: ${r.stderr}`);
    }
  });

  it("is off by default and declares every setting with its default", () => {
    assert.match(script, /^FACTORY_VERIFY="\$\{FACTORY_VERIFY:-0\}"$/m);
    assert.match(script, /^FACTORY_VERIFY_LANES="\$\{FACTORY_VERIFY_LANES-shell,browser\}"$/m);
    assert.match(script, /^FACTORY_VERIFY_ONLY_LABEL="\$\{FACTORY_VERIFY_ONLY_LABEL:-\}"$/m);
    for (const [knob, def] of [
      ["FACTORY_VERIFY_HOLD_MAX_MIN", "60"],
      ["FACTORY_VERIFY_SHELL_TIMEOUT_MIN", "30"],
      ["FACTORY_VERIFY_MAX_ATTEMPTS", "2"],
      ["FACTORY_VERIFY_BOUNCE_MAX", "2"],
      ["FACTORY_VERIFY_PREVIEW_WAIT_MIN", "10"],
    ]) {
      assert.match(script, new RegExp(`^${knob}="\\$\\{${knob}:-${def}\\}"$`, "m"), knob);
    }
    assert.match(
      script,
      /^FACTORY_VERIFY_BYPASS_FILE="\$\{FACTORY_VERIFY_BYPASS_FILE:-\$HOME\/drafto-secrets\/vercel-bypass\.env\}"$/m,
    );
  });

  it("enters Testing after the CodeRabbit gate and before the In Test promotion", () => {
    const gateIdx = reviewLoop.indexOf('cr_lane_gate "$ISSUE_NUM" "$PR_NUM" "$HEAD_SHA"');
    const entryIdx = reviewLoop.indexOf(
      'if verify_target_status "$ISSUE_NUM" "$HEAD_SHA" "$ITEM_LABELS"',
    );
    const promoteIdx = reviewLoop.indexOf(') → In Test"');
    assert.ok(gateIdx !== -1 && entryIdx !== -1 && promoteIdx !== -1);
    assert.ok(gateIdx < entryIdx && entryIdx < promoteIdx);
    // Continue ONLY when the card is really in Testing (or a dry run logged it);
    // anything else falls through to the unchanged promotion below.
    assert.match(
      reviewLoop,
      /if verify_target_status "\$ISSUE_NUM" "\$HEAD_SHA" "\$ITEM_LABELS" \\\n\s*&& verify_enter "\$ITEM_ID" "\$ISSUE_NUM" "\$PR_NUM" "\$PR_OBJ" "\$PR_VIEW" "\$HEAD_SHA" \\\n\s*"\$INTEST_DIFF_FILES" "\$INTEST_PLATFORMS" "\$CR_NOTE"; then\n\s*continue\n\s*fi\n/,
    );
  });

  it("leaves the In Test promotion itself as it was (the off path)", () => {
    const promotion = slice(
      'log "Issue #$ISSUE_NUM: required CI green (platforms:',
      "  # ── 2b. Testing sweep",
    );
    assert.doesNotMatch(promotion, /verify_|Testing/);
    assert.match(promotion, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "In Test" \|\| true/);
    assert.match(promotion, /factory:reset-attempts/);
    assert.match(promotion, /crCliRuns ""/);
  });

  it("runs the Testing sweep between the In Review loop and the In Test sweep", () => {
    const sweepCall = script.indexOf("\n  verify_sweep\n", watchStart);
    const reviewEnd = script.indexOf("  # ── 2b. Testing sweep", watchStart);
    const intestSweep = script.indexOf("  # ── In Test feedback sweep", watchStart);
    assert.ok(reviewEnd !== -1 && sweepCall > reviewEnd && sweepCall < intestSweep);
    // Not behind the switch: with verification off it drains the column.
    assert.doesNotMatch(script.slice(reviewEnd, intestSweep), /FACTORY_VERIFY/);
  });

  it("keeps every hand-off out of the sweep body, inside named functions", () => {
    // factory-agent-cr-cli.test.mjs counts the In Test promotion's hand-offs
    // from the → In Test log line to the In Test sweep: exactly two.
    const between = slice("  # ── 2b. Testing sweep", "  # ── In Test feedback sweep");
    assert.doesNotMatch(between, /intest_handoff|transition_status/);
  });

  it("writes the Testing-stage scenario through the INTEST_STAGE prefix only", () => {
    assert.match(
      extract("verify_prepare"),
      /INTEST_STAGE=testing intest_handoff "\$issue_num" "\$pr_num" "\$pr_obj"/,
    );
    assert.equal((script.match(/INTEST_STAGE=testing intest_handoff/g) || []).length, 1);
    assert.match(extract("build_intest_bundle"), /--arg stage "\$\{INTEST_STAGE:-intest\}"/);
    assert.match(extract("build_intest_bundle"), /stage: \$stage,/);
  });

  it("retries an unposted report from the In Test sweep, after the scenario refresh", () => {
    const sweep = slice("  # ── In Test feedback sweep", "# ── --browser mode");
    const refresh = sweep.indexOf('"$INTEST_HEAD_SHA" != "$SCENARIO_SHA"');
    const retry = sweep.indexOf(
      'verify_report_retry "$ISSUE_NUM" "$INTEST_HEAD_SHA" "$ISSUE_STATE_JSON" || true',
    );
    assert.ok(refresh !== -1 && retry > refresh);
  });

  it("routes the revision no-op through verify_target_status, keeping the In Test arm", () => {
    const noopArm = slice('      noop)\n        if [[ "$IS_REVISION"', "      blocked)");
    assert.match(
      noopArm,
      /revision_noop_route "\$ISSUE_NUM" "\$ITEM_ID" "\$SLOT" "\$PRE_HEAD_OID" "\$ITEM_LABELS" \\\n[\s\S]*?"\$REPLY_MARKERS" "\$FEEDBACK_MARK" "\$AFFECTED" "\$PARITY_OVERRIDE"\n/,
    );
    // Only the head shown at In Test reaches revision_return_to_test (#759).
    const route = extract("revision_noop_route");
    assert.match(
      route,
      /if \[\[ -n "\$shown" && "\$shown" == "\$pr_head" \]\]; then\n\s*revision_return_to_test "\$issue_num" "\$item_id" "\$pr_head" "\$labels" "\$pr_num" \\\n\s*"\$markers" "\$mark" noop\n/,
    );
    assert.match(route, /\n\s*revision_noop_to_review "\$issue_num" /);
    const back = extract("revision_return_to_test");
    assert.match(
      back,
      // A failed move to Testing falls back to In Test; in_test records that
      // the card got there, so only then are its slot and worktree freed.
      /target="In Test" state in_test=0\n\s*if verify_target_status "\$issue_num" "\$pr_head" "\$labels" \\\n\s*&& transition_status "\$item_id" "\$issue_num" "Testing"; then\n\s*target="Testing"\n[\s\S]*?\n\s*elif transition_status "\$item_id" "\$issue_num" "In Test"; then\n\s*in_test=1\n\s*fi/,
    );
    assert.match(back, /returned to \$target/);
    // The no-op path starts the commit's round itself, as verify_enter does, so
    // a round left in state can't read as "head moved" or an expired clock.
    assert.match(
      back,
      /target="Testing"\n[\s\S]*?verify_begin_round "\$issue_num" "\$pr_head"[\s\S]*?\n\s*elif /,
    );
  });

  it("reuses the In Test sweep's feedback filter rather than a copy", () => {
    const sweep = slice("  # ── In Test feedback sweep", "# ── --browser mode");
    // The trailing issue argument feeds the support-forward gate (ADR-0066).
    assert.match(
      sweep,
      /if has_actionable_feedback "\$COMMENTS_JSON" "\$INTEST_HWM" "\$ISSUE_NUM"; then/,
    );
    assert.match(
      extract("verify_sweep_card"),
      /has_actionable_feedback "\$comments_json" "\$hwm" "\$issue_num"/,
    );
  });

  it("stops the lanes on every exit from Testing, promotion included", () => {
    const promote = extract("verify_promote");
    const stopIdx = promote.indexOf('verify_stop_lanes "$issue_num" "$head_sha" "$reason"');
    const composeIdx = promote.indexOf("verify_compose_report ");
    assert.ok(stopIdx !== -1 && stopIdx < composeIdx, "stopped before composing");
    assert.match(
      extract("verify_hand_back"),
      /verify_stop_lanes "\$issue_num" "\$head_sha" "\$reason"/,
    );
  });

  it("never resets attempts or the CodeRabbit run cap on the way into Testing", () => {
    for (const name of [
      "verify_enter",
      "verify_begin_round",
      "verify_prepare",
      "verify_hand_back",
    ]) {
      assert.doesNotMatch(extract(name), /reset-attempts|crCliRuns/, name);
    }
    assert.match(extract("verify_promote"), /factory:reset-attempts/);
    assert.match(extract("verify_promote"), /crCliRuns ""/);
  });

  it("marks every comment the stage posts as the factory's own", () => {
    for (const name of ["verify_hand_back", "verify_minimal_report"]) {
      assert.match(extract(name), /<!-- (\$marker|drafto-factory-verify-report) -->/, name);
    }
    assert.match(
      extract("verify_hand_back"),
      /marker="drafto-factory-verify-handback:\$\{head_sha:0:12\}:\$reason"/,
    );
  });

  it("starts no claude call of its own and never passes --chrome", () => {
    for (const name of verifyFns) {
      assert.doesNotMatch(extract(name), /run-claude\.mjs|--chrome/, name);
    }
  });
});

describe("settings under /bin/bash 3.2", () => {
  const block = script.match(
    /FACTORY_VERIFY="\$\{FACTORY_VERIFY:-0\}"[\s\S]*?VERIFY_REPORT_RETRY_STEP_MIN=10\n/,
  );

  function parse(env) {
    assert.ok(block, "settings block not found");
    const r = spawnSync(
      "/bin/bash",
      ["-c", `set -euo pipefail\n${block[0]}\nenv | grep '^FACTORY_VERIFY' | sort`],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/home/op", ...env } },
    );
    assert.equal(r.status, 0, r.stderr);
    const vars = Object.fromEntries(
      r.stdout
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return { vars, stderr: r.stderr };
  }

  it("exports the defaults", () => {
    const { vars, stderr } = parse({});
    assert.equal(stderr, "");
    assert.deepEqual(vars, {
      FACTORY_VERIFY: "0",
      FACTORY_VERIFY_BOUNCE_MAX: "2",
      FACTORY_VERIFY_BYPASS_FILE: "/home/op/drafto-secrets/vercel-bypass.env",
      FACTORY_VERIFY_HOLD_MAX_MIN: "60",
      FACTORY_VERIFY_LANES: "shell,browser",
      FACTORY_VERIFY_LIVE_TESTS: "0",
      FACTORY_VERIFY_MAX_ATTEMPTS: "2",
      FACTORY_VERIFY_ONLY_LABEL: "",
      FACTORY_VERIFY_PREVIEW_WAIT_MIN: "10",
      FACTORY_VERIFY_SHELL_TIMEOUT_MIN: "30",
    });
  });

  it("falls back on bad values, with a warning each", () => {
    const { vars, stderr } = parse({
      FACTORY_VERIFY: "yes",
      FACTORY_VERIFY_HOLD_MAX_MIN: "abc",
      FACTORY_VERIFY_SHELL_TIMEOUT_MIN: "0",
      FACTORY_VERIFY_MAX_ATTEMPTS: "08",
      FACTORY_VERIFY_BOUNCE_MAX: "-1",
      FACTORY_VERIFY_PREVIEW_WAIT_MIN: "5m",
    });
    assert.equal(vars.FACTORY_VERIFY, "0");
    assert.equal(vars.FACTORY_VERIFY_HOLD_MAX_MIN, "60");
    assert.equal(vars.FACTORY_VERIFY_SHELL_TIMEOUT_MIN, "30");
    assert.equal(vars.FACTORY_VERIFY_MAX_ATTEMPTS, "2");
    assert.equal(vars.FACTORY_VERIFY_BOUNCE_MAX, "2");
    assert.equal(vars.FACTORY_VERIFY_PREVIEW_WAIT_MIN, "10");
    for (const knob of [
      "FACTORY_VERIFY",
      "FACTORY_VERIFY_HOLD_MAX_MIN",
      "FACTORY_VERIFY_SHELL_TIMEOUT_MIN",
      "FACTORY_VERIFY_MAX_ATTEMPTS",
      "FACTORY_VERIFY_BOUNCE_MAX",
      "FACTORY_VERIFY_PREVIEW_WAIT_MIN",
    ]) {
      assert.match(stderr, new RegExp(`invalid ${knob}=`), knob);
    }
  });

  it("keeps valid overrides, a zero bounce cap included", () => {
    const { vars, stderr } = parse({
      FACTORY_VERIFY: "1",
      FACTORY_VERIFY_HOLD_MAX_MIN: "45",
      FACTORY_VERIFY_BOUNCE_MAX: "0",
      FACTORY_VERIFY_ONLY_LABEL: "factory-verify",
      FACTORY_VERIFY_BYPASS_FILE: "~/secrets/bypass.env",
    });
    assert.equal(stderr, "");
    assert.equal(vars.FACTORY_VERIFY, "1");
    assert.equal(vars.FACTORY_VERIFY_HOLD_MAX_MIN, "45");
    assert.equal(vars.FACTORY_VERIFY_BOUNCE_MAX, "0");
    assert.equal(vars.FACTORY_VERIFY_ONLY_LABEL, "factory-verify");
    assert.equal(vars.FACTORY_VERIFY_BYPASS_FILE, "/home/op/secrets/bypass.env");
  });

  it("parses the lane list: unknown words dropped, duplicates folded, empty kept empty", () => {
    assert.equal(
      parse({ FACTORY_VERIFY_LANES: " browser, bogus ,shell,browser" }).vars.FACTORY_VERIFY_LANES,
      "browser,shell",
    );
    const empty = parse({ FACTORY_VERIFY_LANES: "" });
    assert.equal(empty.vars.FACTORY_VERIFY_LANES, "");
    assert.equal(empty.stderr, "");
    assert.match(
      parse({ FACTORY_VERIFY_LANES: "x" }).stderr,
      /unknown FACTORY_VERIFY_LANES entry 'x'/,
    );
  });

  it("turns verification off for a canary label it can't match exactly", () => {
    for (const label of ["a,b", " lead", "trail ", "two\nlines"]) {
      const { vars, stderr } = parse({ FACTORY_VERIFY: "1", FACTORY_VERIFY_ONLY_LABEL: label });
      assert.equal(vars.FACTORY_VERIFY, "0", JSON.stringify(label));
      assert.match(stderr, /invalid FACTORY_VERIFY_ONLY_LABEL/);
    }
    const spaced = parse({ FACTORY_VERIFY: "1", FACTORY_VERIFY_ONLY_LABEL: "verify me" });
    assert.equal(spaced.vars.FACTORY_VERIFY, "1", "a label with an inner space is fine");
  });
});

describe("verify_target_status / verify_wanted (real helpers)", () => {
  const target =
    'if verify_target_status 7 "$HEAD" "$LABELS"; then echo "RC=0 Testing"; else echo "RC=1 In Test"; fi';

  it("does nothing at all with the switch off (the off path costs no lookup)", () => {
    withBash(target, { env: { FACTORY_VERIFY: "0", HEAD, LABELS: "" } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=1 In Test");
      assert.equal(r.calls, "", "no board, label or state lookup");
    });
  });

  it("targets Testing when wanted and the head has no report yet", () => {
    withBash(target, { env: { HEAD, LABELS: "status:in-review" } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=0 Testing");
      assert.match(r.calls, /project has-status-option --name Testing/);
      assert.match(r.calls, /gh api repos\/JakubAnderwald\/drafto\/labels\/status:testing/);
    });
  });

  it("targets In Test once this head's report is posted", () => {
    withBash(target, { env: { HEAD, LABELS: "" }, state: { verifyReportSha: HEAD } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=1 In Test");
    });
    withBash(target, { env: { HEAD, LABELS: "" }, state: { verifyReportSha: OLD } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=0 Testing", "an older commit's report doesn't count");
    });
  });

  it("honours the canary label, before any lookup", () => {
    const env = { HEAD, FACTORY_VERIFY_ONLY_LABEL: "factory-verify" };
    withBash(target, { env: { ...env, LABELS: "status:in-review,factory-verify-later" } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=1 In Test");
      assert.equal(r.calls, "");
    });
    withBash(target, { env: { ...env, LABELS: "status:in-review,factory-verify" } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=0 Testing");
    });
    withBash(target, { env: { ...env, LABELS: '["factory-verify"]' } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=0 Testing", "a JSON label array works too");
    });
  });

  it("falls through to In Test while the column isn't ready, checking and logging once per tick", () => {
    const twice = `${target}\n${target}`;
    withBash(twice, { env: { HEAD, LABELS: "", NO_OPTION: "1" } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=1 In Test\nRC=1 In Test");
      assert.equal((r.calls.match(/has-status-option/g) || []).length, 1, "cached");
      assert.equal((r.log.match(/no Testing column/g) || []).length, 1, "logged once");
    });
    withBash(twice, { env: { HEAD, LABELS: "", NO_LABEL: "1" } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=1 In Test\nRC=1 In Test");
      assert.equal((r.log.match(/no status:testing label/g) || []).length, 1);
    });
  });

  it("never targets Testing without a head SHA", () => {
    withBash(target, { env: { HEAD: "", LABELS: "" } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=1 In Test");
    });
  });
});

describe("revision_noop_route (real helpers): back to In Test only for the head shown there", () => {
  // A revision noop re-presents the PR only when its head is the one the
  // reporter was shown (intestCommentSha). Any other head never went through In
  // Review's gates (an earlier attempt pushed it and died, or someone else
  // pushed), so it gets the parity post-check a pushed revision gets and goes
  // to In Review (#759). The reply check is stubbed: its own tests are in
  // factory-intest-iteration.test.mjs, and here only its kind matters. Back in
  // In Test the card frees its slot and worktree (ADR-0070), through the real
  // release helpers (worktree-cli itself is stubbed).
  const ROUTE_FNS = [
    "revision_noop_route",
    "revision_noop_to_review",
    "revision_return_to_test",
    "implement_parity_gate",
    "parity_violation",
    "release_slot_and_worktree",
    "slot_held_by_issue",
    "remove_worktree_for",
    "branch_keep_reason",
    "log_removed_worktree_leftovers",
  ];
  const MARKERS = JSON.stringify([{ commentId: "123", marker: "drafto-factory-revise-reply-123" }]);
  const MARK = "2026-11-01T00:00:00Z";
  const EARLIER = "2026-10-01T00:00:00Z";
  // branchUpdates: a behind-main budget spent in an earlier In Review stint
  // (ADR-0070), as on a card dragged back out of Blocked.
  const base = { attempts: 2, lastFeedbackAt: EARLIER, branchUpdates: "3" };
  const route = ({ affected = "", override = "infra-only" } = {}) =>
    [
      ...ROUTE_FNS.map(extract),
      'revise_replies_check() { call "replies issue=$1 pr=$2 kind=$4"; }',
      // No detached implement run holds the card (ADR-0085).
      "implement_lane_stop() { return 0; }",
      "PHASE=C",
      'node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-acquire 1 7 4242 --state-file "$STATE_FILE" >/dev/null',
      `revision_noop_route 7 ITEM 1 "$HEAD" "" 70 '${MARKERS}' "${MARK}" "${affected}" "${override}"`,
      `echo "slot=$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-status 1 --state-file "$STATE_FILE" | jq -r '.issueNumber // "free"')"`,
    ].join("\n");
  const moves = (r) => (r.calls.match(/^transition .*$/gm) || []).join(" | ");
  const SCRIPTS_DIFF = "scripts/factory-agent.sh";

  for (const [name, shown] of [
    ["a head that wasn't the one shown", { intestCommentSha: OLD }],
    ["no shown head on record", {}],
    ["an empty shown head", { intestCommentSha: "" }],
    ["a null shown head", { intestCommentSha: null }],
  ]) {
    it(`sends ${name} through the parity gate to In Review, keeping the slot`, () => {
      withBash(
        route(),
        { env: { HEAD, DIFF_STUB: SCRIPTS_DIFF }, state: { ...base, ...shown } },
        (r) => {
          assert.equal(moves(r), "transition In Review");
          assert.match(r.calls, /^gh pr diff 70 --repo JakubAnderwald\/drafto --name-only$/m);
          assert.match(r.calls, /^replies issue=7 pr=70 kind=noop-review$/m);
          assert.equal(r.issue.lastFeedbackAt, MARK, "the feedback is consumed");
          assert.equal(r.issue.attempts, 0, "attempts reset");
          assert.equal(r.issue.branchUpdates, null, "a fresh behind-main budget");
          assert.match(r.stdout, /^slot=7$/m, "the slot stays for --watch");
          assert.doesNotMatch(r.calls, /^worktree /m, "and so does the worktree");
          assert.equal(r.comments.length, 0);
          assert.match(r.log, /routing through In Review/);
          assert.match(r.log, /revision noop on an unshown head → In Review/);
        },
      );
    });
  }

  it("never reads an empty head as matching an empty shown SHA", () => {
    // Unreachable today (an unreadable head takes the PRE_HEAD_KNOWN=0 exit),
    // so this pins the guard itself: "" == "" must not count as shown.
    for (const shown of [{}, { intestCommentSha: "" }]) {
      withBash(
        route(),
        { env: { HEAD: "", DIFF_STUB: SCRIPTS_DIFF }, state: { ...base, ...shown } },
        (r) => {
          assert.equal(moves(r), "transition In Review");
          assert.match(r.calls, /^replies issue=7 pr=70 kind=noop-review$/m);
        },
      );
    }
  });

  it("returns the shown head to Testing while it owes a report, with no parity re-check", () => {
    // An app diff on an infra-only card would fail the gate, so a Testing move
    // here also proves the shown head skips it: it passed In Review already.
    withBash(
      route(),
      { env: { HEAD, DIFF_STUB: "apps/web/a.ts" }, state: { ...base, intestCommentSha: HEAD } },
      (r) => {
        assert.equal(moves(r), "transition Testing");
        assert.doesNotMatch(r.calls, /gh pr diff/);
        assert.match(r.calls, /^replies issue=7 pr=70 kind=noop$/m);
        assert.equal(r.issue.verifySha, HEAD, "the commit's round starts");
        assert.equal(r.issue.lastFeedbackAt, MARK);
        assert.equal(r.issue.attempts, 0);
        assert.match(r.stdout, /^slot=7$/m);
        assert.match(r.log, /revision noop; returned to Testing/);
      },
    );
  });

  it("returns the shown head to In Test with verification off, freeing its slot", () => {
    withBash(
      route(),
      {
        env: { HEAD, FACTORY_VERIFY: "0", DIFF_STUB: "apps/web/a.ts", PR_OBJ_STUB: PR_OBJ },
        state: { ...base, intestCommentSha: HEAD },
      },
      (r) => {
        assert.equal(moves(r), "transition In Test");
        assert.doesNotMatch(r.calls, /gh pr diff/);
        assert.match(r.calls, /^replies issue=7 pr=70 kind=noop$/m);
        assert.equal(r.issue.lastFeedbackAt, MARK);
        assert.equal(r.issue.attempts, 0);
        assert.match(r.stdout, /^slot=free$/m, "In Test holds no slot (ADR-0070)");
        // The PR is open, so its branch stays; only the worktree goes.
        assert.match(r.calls, /^worktree remove --issue 7 --root \S+ --force$/m);
        assert.match(r.log, /revision noop; returned to In Test/);
      },
    );
  });

  it("parks an unshown head that fails the parity check in Blocked, the feedback unconsumed", () => {
    withBash(
      route(),
      { env: { HEAD, DIFF_STUB: "apps/web/a.ts" }, state: { ...base, intestCommentSha: OLD } },
      (r) => {
        assert.equal(moves(r), "transition Blocked");
        const posted = r.comments.filter((c) =>
          c.body.includes("<!-- drafto-factory-parity-violation -->"),
        );
        assert.equal(posted.length, 1);
        assert.match(posted[0].body, /parity:infra-only but the PR changes app code/);
        assert.match(r.stdout, /^slot=free$/m, "the slot is released");
        assert.match(r.calls, /^worktree remove --issue 7 --root \S+ --force$/m);
        // Nothing consumed or reset, and no replies: a human looks at it first.
        assert.equal(r.issue.lastFeedbackAt, EARLIER);
        assert.equal(r.issue.attempts, 2);
        assert.equal(r.issue.branchUpdates, "3");
        assert.doesNotMatch(r.calls, /^replies /m);
      },
    );
  });

  it("checks the card's claimed platforms, not only infra-only", () => {
    withBash(
      route({ affected: "web,mobile", override: "" }),
      { env: { HEAD, DIFF_STUB: "apps/web/a.ts" }, state: { ...base, intestCommentSha: OLD } },
      (r) => {
        assert.equal(moves(r), "transition Blocked");
        assert.match(r.comments[0].body, /claimed platform 'mobile' has no apps\/mobile changes/);
      },
    );
  });

  it("still goes to In Review when the diff can't be read, as a pushed revision does", () => {
    withBash(
      route(),
      { env: { HEAD, DIFF_FAIL: "1" }, state: { ...base, intestCommentSha: OLD } },
      (r) => {
        assert.equal(moves(r), "transition In Review");
        assert.match(r.log, /gh pr diff failed for PR #70; skipping parity post-check this tick/);
        assert.equal(r.issue.lastFeedbackAt, MARK);
      },
    );
  });
});

describe("verify_enter (real helper)", () => {
  const enter = `if verify_enter ITEM 7 70 '${PR_OBJ}' '${prView()}' "$HEAD" "apps/web/a.ts" '{"web":true}' "$NOTE"; then echo RC=0; else echo RC=1; fi`;

  it("advances first, starts the round, dispatches betas and writes the Testing scenario", () => {
    withBash(enter, { env: { HEAD, NOTE: "CodeRabbit did not review aaaaaaaaaaaa (x)" } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=0");
      const calls = r.calls.trim().split("\n");
      assert.equal(calls[0], "transition Testing", "the move comes first");
      assert.ok(calls.some((c) => c.startsWith("dispatch 7 70 " + HEAD)));
      assert.ok(
        calls.includes("handoff stage=testing cr_note=CodeRabbit did not review aaaaaaaaaaaa (x)"),
      );
      assert.equal(r.issue.verifySha, HEAD);
      assert.match(r.issue.verifyStartedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.equal(r.issue.verifyCrNote, `${HEAD}:CodeRabbit did not review aaaaaaaaaaaa (x)`);
      assert.ok(r.issue.lastFeedbackAt, "a baseline when there was none");
      assert.ok(r.issue.lastWatchAt);
    });
  });

  it("never moves the feedback mark that is already there, nor resets the fix budget", () => {
    const state = { lastFeedbackAt: "2026-01-01T00:00:00Z", attempts: 3, crCliRuns: "2" };
    withBash(enter, { env: { HEAD, NOTE: "" }, state }, (r) => {
      assert.equal(r.issue.lastFeedbackAt, "2026-01-01T00:00:00Z");
      assert.equal(r.issue.attempts, 3);
      assert.equal(r.issue.crCliRuns, "2");
      assert.equal(r.issue.verifyCrNote, `${HEAD}:`);
    });
  });

  it("scopes INTEST_STAGE to that one hand-off (later In Test hand-offs keep their wording)", () => {
    withBash(`${enter}\necho "after=\${INTEST_STAGE:-unset}"`, { env: { HEAD, NOTE: "" } }, (r) => {
      assert.match(r.calls, /^handoff stage=testing /m);
      assert.match(r.stdout, /^after=unset$/m);
    });
  });

  it("skips the scenario writer when this head already has a scenario", () => {
    withBash(enter, { env: { HEAD, NOTE: "" }, state: { intestCommentSha: HEAD } }, (r) => {
      assert.doesNotMatch(r.calls, /^handoff/m);
      assert.match(r.calls, /^dispatch /m, "betas are still checked");
    });
  });

  it("returns 1 and touches nothing when the move to Testing fails", () => {
    withBash(enter, { env: { HEAD, NOTE: "", FAIL_TRANSITION: "Testing" } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=1");
      assert.equal(r.calls.trim(), "transition Testing");
      assert.equal(r.issue.verifySha ?? null, null);
      assert.match(r.log, /promoting it straight to In Test as before/);
    });
  });

  it("only logs under --dry-run", () => {
    withBash(enter, { env: { HEAD, NOTE: "", DRY_RUN: "1" } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=0");
      assert.equal(r.calls, "");
      assert.match(r.log, /DRY-RUN: would move #7 to Testing/);
    });
  });
});

describe("verify_hand_back (real helper)", () => {
  const back = (reason, threads = "") =>
    `verify_hand_back ITEM 7 70 "$HEAD" ${reason} "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "${threads}"`;

  it("moves the card back, counts the bounce and comments once per commit and reason", () => {
    withBash(`${back("threads", "2")}\n${back("threads", "2")}`, { env: { HEAD } }, (r) => {
      assert.equal((r.calls.match(/^transition In Review$/gm) || []).length, 2);
      assert.equal(r.issue.verifyBounces, `${HEAD}:2`);
      const posted = r.comments.filter((c) => c.body.includes("drafto-factory-verify-handback"));
      assert.equal(posted.length, 1, "the second hand-back finds the marker");
      assert.match(posted[0].body, /PR #70 has 2 unresolved review thread\(s\)/);
      assert.match(
        posted[0].body,
        new RegExp(`<!-- drafto-factory-verify-handback:${HEAD.slice(0, 12)}:threads -->`),
      );
    });
  });

  it("starts a new count for a new commit", () => {
    withBash(back("threads", "1"), { env: { HEAD }, state: { verifyBounces: `${OLD}:2` } }, (r) => {
      assert.equal(r.issue.verifyBounces, `${HEAD}:1`);
    });
  });

  it("counts only thread hand-backs against the bounce cap", () => {
    // The others are bounded already (a new commit, the fix loop's attempts, a
    // once-per-commit review); counting them would eat the thread budget.
    for (const reason of ["head-moved", "ci-red", "not-reviewed"]) {
      withBash(back(reason), { env: { HEAD }, state: { verifyBounces: `${HEAD}:1` } }, (r) => {
        assert.equal(r.issue.verifyBounces, `${HEAD}:1`, reason);
        assert.match(r.calls, /^transition In Review$/m, reason);
        assert.equal(r.comments.length, 1, reason);
      });
    }
    withBash(back("head-moved"), { env: { HEAD } }, (r) => {
      assert.match(r.comments[0].body, /head moved to `aaaaaaaaaaaa`/);
    });
  });

  // The hand-back promises the fix loop; a stale ciNoop on the same head
  // would send the card straight to Blocked instead (ADR-0102).
  it("a ci-red hand-back clears ciNoop; the others keep it", () => {
    const rec = `${HEAD}:Lint`;
    withBash(back("ci-red"), { env: { HEAD }, state: { ciNoop: rec } }, (r) => {
      assert.equal(r.issue.ciNoop ?? null, null);
    });
    withBash(back("head-moved"), { env: { HEAD }, state: { ciNoop: rec } }, (r) => {
      assert.equal(r.issue.ciNoop, rec);
    });
  });

  it("leaves everything alone when the move fails", () => {
    withBash(
      `${back("ci-red")} || echo RC=$?`,
      { env: { HEAD, FAIL_TRANSITION: "In Review" } },
      (r) => {
        assert.equal(r.stdout.trim(), "RC=1");
        assert.equal(r.issue.verifyBounces ?? null, null);
        assert.equal(r.comments.length, 0);
      },
    );
  });
});

describe("verify_post_report / verify_report_retry (real helpers)", () => {
  const BODY_SETUP = `mkdir -p "$VERIFY_DIR"; printf 'report <!-- drafto-factory-verify-sha:%s -->\\n' "$HEAD" > "$VERIFY_DIR/report-7-$HEAD.md"`;
  const post = `${BODY_SETUP}\nif verify_post_report 7 "$HEAD" "$VERIFY_DIR/report-7-$HEAD.md"; then echo RC=0; else echo RC=1; fi`;
  const retryCall = `verify_report_retry 7 "$HEAD" "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")"`;
  // The report was composed long ago, so every spaced retry is due.
  const retry = `${BODY_SETUP}\ntouch -t 202601010000 "$VERIFY_DIR/report-7-$HEAD.md"\n${retryCall}`;
  const retryFresh = `${BODY_SETUP}\n${retryCall}`;
  const marked = (assoc) => [
    {
      id: 1,
      body: `x <!-- drafto-factory-verify-sha:${HEAD} -->`,
      createdAt: "t",
      authorAssociation: assoc,
    },
  ];

  it("posts once and records the commit", () => {
    withBash(post, { env: { HEAD } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=0");
      assert.equal(r.comments.length, 1);
      assert.equal(r.issue.verifyReportSha, HEAD);
    });
  });

  it("does not post again when the factory's own comment already carries the marker", () => {
    withBash(post, { env: { HEAD }, comments: marked("OWNER") }, (r) => {
      assert.equal(r.stdout.trim(), "RC=0");
      assert.equal(r.comments.length, 1, "nothing new posted");
      assert.doesNotMatch(r.calls, /gh issue comment/);
      assert.equal(r.issue.verifyReportSha, HEAD);
    });
  });

  it("ignores a marker pasted by anyone else", () => {
    withBash(post, { env: { HEAD }, comments: marked("NONE") }, (r) => {
      assert.equal(r.comments.length, 2);
    });
  });

  it("counts a failed post, and an unreadable comment list, per commit", () => {
    withBash(
      post,
      { env: { HEAD, FAIL_COMMENT: "1" }, state: { verifyReportPosts: `${OLD}:2` } },
      (r) => {
        assert.equal(r.stdout.trim(), "RC=1");
        assert.equal(r.issue.verifyReportPosts, `${HEAD}:1`);
        assert.equal(r.issue.verifyReportSha ?? null, null);
      },
    );
    withBash(post, { env: { HEAD, COMMENTS_FAIL: "1" } }, (r) => {
      assert.equal(r.stdout.trim(), "RC=1");
      assert.equal(r.issue.verifyReportPosts, `${HEAD}:1`);
      assert.doesNotMatch(r.calls, /gh issue comment/, "never posts blind");
    });
  });

  it("the In Test sweep retries a report on disk, up to the cap", () => {
    withBash(retry, { env: { HEAD }, state: { verifyReportPosts: `${HEAD}:2` } }, (r) => {
      assert.equal(r.comments.length, 1);
      assert.equal(r.issue.verifyReportSha, HEAD);
    });
    withBash(
      retry,
      { env: { HEAD, FAIL_COMMENT: "1" }, state: { verifyReportPosts: `${HEAD}:3` } },
      (r) => {
        assert.equal(r.issue.verifyReportPosts, `${HEAD}:4`);
        assert.match(r.log, /giving up on posting #7's verification report/);
      },
    );
    withBash(retry, { env: { HEAD }, state: { verifyReportPosts: `${HEAD}:4` } }, (r) => {
      assert.equal(r.calls, "", "spent: not even a comment fetch");
      assert.equal(r.comments.length, 0);
    });
  });

  it("spaces the retries, so the promoting tick and the next ones can't spend them all", () => {
    // Just composed, one failure (the promotion's own): not due for 10 min.
    withBash(retryFresh, { env: { HEAD }, state: { verifyReportPosts: `${HEAD}:1` } }, (r) => {
      assert.equal(r.calls, "");
    });
    // Nothing recorded as failed yet (the count write itself failed): due now.
    withBash(retryFresh, { env: { HEAD } }, (r) => {
      assert.equal(r.comments.length, 1);
    });
    // 15 minutes old: the first retry is due, the second isn't.
    const aged = (min) =>
      `${BODY_SETUP}\nnode -e 'const t = Date.now() / 1000 - ${min} * 60; require("fs").utimesSync(process.argv[1], t, t)' "$VERIFY_DIR/report-7-$HEAD.md"\n${retryCall}`;
    withBash(aged(15), { env: { HEAD }, state: { verifyReportPosts: `${HEAD}:1` } }, (r) => {
      assert.equal(r.comments.length, 1);
    });
    withBash(aged(15), { env: { HEAD }, state: { verifyReportPosts: `${HEAD}:2` } }, (r) => {
      assert.equal(r.calls, "");
    });
  });

  it("is inert for a card whose report is posted, or that never had one composed", () => {
    withBash(retry, { env: { HEAD }, state: { verifyReportSha: HEAD } }, (r) => {
      assert.equal(r.calls, "");
    });
    const noFile = `verify_report_retry 7 "$HEAD" '{}'`;
    withBash(noFile, { env: { HEAD } }, (r) => {
      assert.equal(r.calls, "");
      assert.equal(r.log, "");
    });
    withBash(retry, { env: { HEAD, DRY_RUN: "1" } }, (r) => {
      assert.equal(r.calls, "");
    });
  });
});

describe("verify_promote (real helper, real composer)", () => {
  const scenario = [
    "🏭 **Test scenario — verifying now (Testing).**",
    "## Test scenario",
    "### Web",
    "1. Open /notebooks — expected: the list.",
    "<!-- drafto-factory-in-test -->",
    "<!-- drafto-factory-test-scenario -->",
    `<!-- drafto-factory-scenario-sha:${HEAD} -->`,
  ].join("\n");
  const scenarioComment = [{ id: 5, body: scenario, createdAt: "t", authorAssociation: "OWNER" }];
  const promote = (lanes) =>
    `verify_promote ITEM 7 70 "$HEAD" lanes-done '${lanes}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
  const notBuilt = '{"shell":"skipped:not-built","browser":"skipped:not-built"}';

  it("composes the INCOMPLETE report, moves to In Test, posts it once and resets", () => {
    const state = {
      attempts: 4,
      crCliRuns: "2",
      verifyCrNote: `${HEAD}:CodeRabbit did not review aaaaaaaaaaaa (x)`,
    };
    withBash(promote(notBuilt), { env: { HEAD }, state, comments: scenarioComment }, (r) => {
      const calls = r.calls.trim().split("\n");
      const moveIdx = calls.indexOf("transition In Test");
      const postIdx = calls.findIndex((c) => c.startsWith("gh issue comment 7"));
      assert.ok(moveIdx !== -1 && postIdx > moveIdx, "posted only after the move");
      const report = r.comments.at(-1).body;
      assert.match(report, /\*\*Verdict: INCOMPLETE\*\*/);
      assert.match(report, /skipped: this lane isn't built yet/);
      assert.match(report, /Run the \*\*Web\*\* steps in the test scenario by hand/);
      assert.match(report, /ℹ️ CodeRabbit did not review aaaaaaaaaaaa \(x\)/, "the kept note");
      assert.match(report, /<!-- drafto-factory-verify-report -->/);
      assert.match(report, new RegExp(`<!-- drafto-factory-verify-sha:${HEAD} -->`));
      assert.equal(r.issue.verifyReportSha, HEAD);
      assert.equal(r.issue.attempts, 0);
      assert.equal(r.issue.crCliRuns, null);
      assert.ok(r.issue.lastWatchAt);
      assert.ok(existsSync(join(r.dir, "verify", `report-7-${HEAD}.md`)), "kept for a retry");
    });
  });

  it("renders a drained card's lanes as verification-off", () => {
    const off = '{"shell":"skipped:verification-off","browser":"skipped:verification-off"}';
    withBash(promote(off), { env: { HEAD }, comments: scenarioComment }, (r) => {
      assert.match(r.comments.at(-1).body, /verification is switched off \(FACTORY_VERIFY=0\)/);
    });
  });

  it("posts the minimal notice, markers included, when the composer fails", () => {
    withBash(promote(notBuilt), { env: { HEAD, REPORT_FAIL: "1" } }, (r) => {
      const report = r.comments.at(-1).body;
      assert.match(report, /couldn't be composed/);
      assert.match(report, /<!-- drafto-factory-verify-report -->/);
      assert.match(report, new RegExp(`<!-- drafto-factory-verify-sha:${HEAD} -->`));
      assert.equal(r.issue.verifyReportSha, HEAD);
    });
  });

  it("posts nothing and resets nothing when the move to In Test fails", () => {
    withBash(
      `${promote(notBuilt)} || echo RC=$?`,
      { env: { HEAD, FAIL_TRANSITION: "In Test" }, state: { attempts: 4 } },
      (r) => {
        assert.equal(r.stdout.trim(), "RC=1");
        assert.equal(r.comments.length, 0);
        assert.equal(r.issue.attempts, 4);
        assert.equal(r.issue.verifyReportSha ?? null, null);
        assert.match(r.log, /stays in Testing for the next tick/);
      },
    );
  });

  it("still promotes when the PR's files can't be read, saying so in the report", () => {
    withBash(promote(notBuilt), { env: { HEAD, DIFF_FAIL: "1" } }, (r) => {
      assert.match(r.calls, /^transition In Test$/m);
      assert.match(r.comments.at(-1).body, /changed files couldn't be read/);
    });
  });
});

describe("verify_sweep_card (real helpers, real verify-decide)", () => {
  const card = 'verify_sweep_card ITEM 7 "$LABELS"';
  const base = (over = {}) => ({
    HEAD,
    LABELS: "status:testing",
    PR_OBJ_STUB: PR_OBJ,
    PR_VIEW_STUB: prView(),
    ...over,
  });
  const reviewed = (over = {}) => ({
    verifySha: HEAD,
    verifyStartedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    lastReviewSha: HEAD,
    lastFeedbackAt: "2026-01-01T00:00:00Z",
    intestCommentSha: HEAD,
    ...over,
  });

  it("promotes at once while no lane is built (the Wave 4 behaviour)", () => {
    withBash(card, { env: base(), state: reviewed() }, (r) => {
      assert.match(r.log, /Testing → promote \(lanes-done\)/);
      assert.match(r.calls, /^transition In Test$/m);
      assert.match(r.comments.at(-1).body, /Verdict: INCOMPLETE/);
    });
  });

  it("promotes on the hold cap with lanes still pending", () => {
    const state = reviewed({ verifyStartedAt: "2026-01-01T00:00:00Z" });
    withBash(card, { env: base({ VERIFY_BUILT_LANES_STUB: "shell,browser" }), state }, (r) => {
      assert.match(r.log, /Testing → promote \(hold-cap\)/);
      assert.match(r.comments.at(-1).body, /skipped: the hold cap was reached first/);
    });
  });

  it("works the lanes, without a scenario rewrite, while they are pending inside the cap", () => {
    withBash(
      card,
      { env: base({ VERIFY_BUILT_LANES_STUB: "shell,browser" }), state: reviewed() },
      (r) => {
        assert.match(r.log, /Testing → work-lanes \(lanes-pending\)/);
        assert.match(r.calls, /^outcomes 7 /m);
        assert.match(r.calls, /^dispatch 7 70 /m);
        assert.doesNotMatch(r.calls, /^handoff|^transition/m);
      },
    );
  });

  it("starts a round for a card dragged in with none", () => {
    withBash(
      card,
      { env: base(), state: reviewed({ verifySha: null, intestCommentSha: null }) },
      (r) => {
        assert.match(r.log, /Testing → init \(no-round\)/);
        assert.equal(r.issue.verifySha, HEAD);
        assert.match(r.calls, /^handoff stage=testing /m);
        assert.doesNotMatch(r.calls, /^transition/m);
      },
    );
  });

  it("hands back on red CI", () => {
    const red = prView({ statusCheckRollup: [{ name: "Lint", conclusion: "FAILURE" }] });
    withBash(card, { env: base({ PR_VIEW_STUB: red }), state: reviewed() }, (r) => {
      assert.match(r.calls, /^transition In Review$/m);
      assert.match(r.comments.at(-1).body, /A required check is red/);
    });
  });

  it("promotes on actionable feedback, skipping noise", () => {
    const comments = (body) => [
      { id: 3, body, createdAt: "2026-06-01T00:00:00Z", authorAssociation: "OWNER" },
    ];
    const env = base({ VERIFY_BUILT_LANES_STUB: "shell,browser" });
    withBash(
      card,
      { env, state: reviewed(), comments: comments("the button is the wrong colour") },
      (r) => {
        assert.match(r.log, /Testing → promote \(feedback\)/);
      },
    );
    withBash(card, { env, state: reviewed(), comments: comments("thanks!") }, (r) => {
      assert.match(r.log, /Testing → work-lanes/);
    });
  });

  it("drains every card with verification off", () => {
    withBash(
      card,
      { env: base({ FACTORY_VERIFY: "0" }), state: reviewed({ lastReviewSha: OLD }) },
      (r) => {
        assert.match(r.log, /Testing → promote \(verification-off\)/);
        assert.doesNotMatch(r.calls, /^threads |has-status-option/m);
      },
    );
  });

  it("leaves a card whose PR merged", () => {
    withBash(
      card,
      { env: base({ PR_VIEW_STUB: prView({ state: "MERGED" }) }), state: reviewed() },
      (r) => {
        assert.match(r.log, /Testing → skip \(pr-merged\)/);
        assert.doesNotMatch(r.calls, /^transition/m);
      },
    );
  });

  it("waits when the thread list can't be read", () => {
    withBash(card, { env: base({ THREADS_FAIL: "1" }), state: reviewed() }, (r) => {
      assert.match(r.log, /Testing → wait \(threads-unknown\)/);
      assert.doesNotMatch(r.calls, /^transition/m);
    });
  });

  it("fails open to a promotion when the decision module is unusable", () => {
    const body = `node() { case "$1" in */verify-decide.mjs) echo garbage ;; *) command node "$@" ;; esac; }\n${card}`;
    withBash(body, { env: base(), state: reviewed() }, (r) => {
      assert.match(r.log, /no usable decision for #7; promoting it \(fail open\)/);
    });
  });

  it("keeps a mid-round card verifying when this tick's column lookup fails", () => {
    // The lookup only gates moving cards INTO Testing; a failure must not drain
    // cards already there as "verification off".
    const env = base({ NO_OPTION: "1", NO_LABEL: "1", VERIFY_BUILT_LANES_STUB: "shell,browser" });
    withBash(card, { env, state: reviewed() }, (r) => {
      assert.match(r.log, /Testing → work-lanes \(lanes-pending\)/);
      assert.doesNotMatch(r.log, /verification-off/);
      assert.doesNotMatch(r.calls, /has-status-option/);
    });
  });

  it("still honours the canary label for a card already in Testing", () => {
    const env = base({ FACTORY_VERIFY_ONLY_LABEL: "factory-verify" });
    withBash(card, { env, state: reviewed() }, (r) => {
      assert.match(r.log, /Testing → promote \(verification-off\)/);
    });
  });

  it("skips the tick when the card's state can't be read (never reads it as empty)", () => {
    withBash(`printf 'not json' > "$STATE_FILE"\n${card}`, { env: base() }, (r) => {
      assert.match(r.log, /couldn't read #7's factory state/);
      assert.doesNotMatch(r.calls, /^transition/m);
      assert.equal(r.comments.length, 0, "no misleading not-reviewed comment");
    });
  });

  it("skips the tick when an open PR's snapshot has no head", () => {
    withBash(
      card,
      { env: base({ PR_VIEW_STUB: prView({ headRefOid: "" }) }), state: reviewed() },
      (r) => {
        assert.match(r.log, /has no head SHA in the snapshot/);
        assert.doesNotMatch(r.calls, /^transition/m);
      },
    );
  });

  it("reads threads only once CI is green: a re-run with a thread open waits, no bounce", () => {
    const pending = prView({ statusCheckRollup: [{ name: "Lint", status: "IN_PROGRESS" }] });
    const env = base({ PR_VIEW_STUB: pending, THREADS_STUB: '[{"id":"T1"}]' });
    withBash(card, { env, state: reviewed() }, (r) => {
      assert.match(r.log, /Testing → wait \(ci-pending\)/);
      assert.doesNotMatch(r.calls, /^threads /m);
    });
    withBash(card, { env: base({ THREADS_STUB: '[{"id":"T1"}]' }), state: reviewed() }, (r) => {
      assert.match(r.log, /Testing → hand-back \(threads\)/);
      assert.equal(r.issue.verifyBounces, `${HEAD}:1`);
    });
  });

  it("lets actionable feedback beat a hand-back (the revision replaces the commit)", () => {
    const red = prView({ statusCheckRollup: [{ name: "Lint", conclusion: "FAILURE" }] });
    const comments = [
      {
        id: 3,
        body: "please rename the button",
        createdAt: "2026-06-01T00:00:00Z",
        authorAssociation: "OWNER",
      },
    ];
    withBash(card, { env: base({ PR_VIEW_STUB: red }), state: reviewed(), comments }, (r) => {
      assert.match(r.log, /Testing → promote \(feedback\)/);
      assert.match(r.calls, /^transition In Test$/m);
    });
  });

  it("skips the tick when the PR can't be read", () => {
    withBash(card, { env: base({ PR_VIEW_STUB: "" }), state: reviewed() }, (r) => {
      assert.match(r.log, /waits for the next tick/);
      assert.doesNotMatch(r.calls, /^transition/m);
    });
  });

  // ADR-0078: the label is checked in every column that has the PR, Testing
  // included, and the check never changes what happens to the card.
  describe("migration approval", () => {
    const HASH = "0123456789abcdef";
    const labelled = prView({
      labels: [{ name: "status:testing" }, { name: "migration-approved" }],
    });
    const env = (over = {}) =>
      base({
        PR_VIEW_STUB: labelled,
        DIFF_STUB: "supabase/migrations/20261113000001_q.sql",
        HASH_STUB: JSON.stringify({ hash: HASH, files: [] }),
        ...over,
      });

    it("asks for the view's labels in the one view it fetches", () => {
      const fn = extract("verify_sweep_card");
      assert.match(fn, /--json state,statusCheckRollup,comments,headRefOid,labels/);
      assert.equal(fn.split('gh pr view "').length - 1, 1);
      const vouch = fn.indexOf('migration_approval_vouch_view "$issue_num" "$pr_num" "$pr_view"');
      assert.ok(vouch !== -1);
      assert.ok(fn.indexOf("no head SHA in the snapshot") < vouch);
      assert.ok(vouch < fn.indexOf("verify-decide.mjs"));
    });

    it("records the label's SQL for this PR and head, and promotes as it would without it", () => {
      withBash(card, { env: env(), state: reviewed() }, (r) => {
        assert.match(r.calls, new RegExp(`^hash hash --root .* --pr 70 --head ${HEAD}$`, "m"));
        assert.equal(r.issue.migrationApprovedVouched, `70:${HEAD}:${HASH}`);
        assert.match(r.log, /Testing → promote \(lanes-done\)/);
        assert.match(r.calls, /^transition In Test$/m);
      });
    });

    it("skips the hash while the head is the one recorded", () => {
      const state = reviewed({ migrationApprovedVouched: `70:${HEAD}:${HASH}` });
      withBash(card, { env: env(), state }, (r) => {
        assert.doesNotMatch(r.calls, /^hash /m);
        // The one diff is the promotion's report, after the decision.
        assert.equal(r.calls.split("gh pr diff ").length - 1, 1);
        assert.ok(r.calls.indexOf("gh pr diff ") > r.calls.indexOf("threads 70"));
        assert.match(r.calls, /^transition In Test$/m);
      });
    });

    it("voids a label the SQL changed under, comment first, and still promotes", () => {
      const state = reviewed({ migrationApprovedVouched: `70:${OLD}:fedcba9876543210` });
      withBash(card, { env: env(), state }, (r) => {
        const comment = r.calls.indexOf("gh issue comment 7 ");
        const edit = r.calls.indexOf(
          "gh pr edit 70 --repo JakubAnderwald/drafto --remove-label migration-approved",
        );
        assert.ok(comment !== -1 && edit !== -1 && comment < edit, r.calls);
        assert.match(
          r.comments[0].body,
          new RegExp(`drafto-factory-migration-approval-void:${HASH}`),
        );
        assert.equal(r.issue.migrationApprovedVouched ?? null, null);
        assert.match(r.log, /Testing → promote \(lanes-done\)/);
        assert.match(r.calls, /^transition In Test$/m);
      });
    });

    it("never holds the card when the hash fails", () => {
      withBash(card, { env: env({ HASH_STUB: "" }), state: reviewed() }, (r) => {
        assert.match(r.log, /couldn't hash PR #70's migrations/);
        assert.equal(r.issue.migrationApprovedVouched ?? null, null);
        assert.match(r.calls, /^transition In Test$/m);
      });
    });
  });
});

describe("verify_sweep (real helper)", () => {
  const items = JSON.stringify([
    { itemId: "I9", issueNumber: 9, labels: [] },
    { itemId: "I8", issueNumber: 8, labels: ["factory-pause"] },
    { itemId: "I7", issueNumber: 7, labels: ["support"] },
    { itemId: "I6", issueNumber: 6, labels: ["driver:interactive"] },
    { itemId: "I3", issueNumber: 3, labels: [] },
  ]);
  const body = 'verify_sweep_card() { call "card $2"; }\nverify_sweep';

  it("visits cards oldest first, honouring factory-pause, driver:interactive and support", () => {
    withBash(body, { env: { TESTING_ITEMS: items } }, (r) => {
      assert.deepEqual(
        r.calls.split("\n").filter((c) => c.startsWith("card ")),
        ["card 3", "card 9"],
      );
      assert.match(r.log, /#8: skipping \(factory-pause label set\)/);
      assert.match(
        r.log,
        /#6: skipping \(driver:interactive label set — an interactive session owns it\)/,
      );
      assert.match(r.log, /#7: skipping \(support label — nightly-support\.sh owns these\)/);
    });
  });

  it("returns cleanly when the board query fails", () => {
    withBash(`${body}\necho AFTER`, { env: { QUERY_FAIL: "1" } }, (r) => {
      assert.match(r.stdout, /AFTER/);
      assert.match(r.log, /skipping the Testing sweep this tick/);
    });
  });

  it("is silent with verification off and nothing in Testing", () => {
    withBash(body, { env: { FACTORY_VERIFY: "0" } }, (r) => {
      assert.equal(r.log, "");
    });
  });

  it("stops when the factory is paused mid-tick", () => {
    const state = JSON.stringify({ paused: true, issues: {} });
    const pausedBody = `printf '%s' '${state}' > "$STATE_FILE"\n${body}`;
    withBash(pausedBody, { env: { TESTING_ITEMS: items } }, (r) => {
      assert.doesNotMatch(r.calls, /^card /m);
      assert.match(r.log, /stopping the Testing sweep/);
    });
  });
});

describe("verify_lane_states (real helper)", () => {
  const states = (enabled) =>
    `verify_lane_states "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$HEAD" ${enabled}`;

  it("reads a lane's own record for this head, SHA stripped", () => {
    const state = { verifyShell: `${HEAD}:reported:warn`, verifyBrowser: `${OLD}:reported:pass` };
    withBash(states(1), { env: { HEAD, VERIFY_BUILT_LANES_STUB: "shell,browser" }, state }, (r) => {
      assert.deepEqual(JSON.parse(r.stdout), {
        shell: "reported:warn",
        browser: "none",
        device: "skipped:lane-off",
      });
    });
  });

  it("fills the placeholders: verification off, lane off, not built", () => {
    withBash(states(0), { env: { HEAD } }, (r) => {
      assert.deepEqual(JSON.parse(r.stdout), {
        shell: "skipped:verification-off",
        browser: "skipped:verification-off",
        device: "skipped:verification-off",
      });
    });
    withBash(states(1), { env: { HEAD, FACTORY_VERIFY_LANES: "shell" } }, (r) => {
      assert.deepEqual(JSON.parse(r.stdout), {
        shell: "skipped:not-built",
        browser: "skipped:lane-off",
        device: "skipped:lane-off",
      });
    });
  });
});

describe("has_actionable_feedback (real helper)", () => {
  const check = (since) =>
    `if has_actionable_feedback "$(cat "$COMMENTS_FILE")" "${since}"; then echo YES; else echo NO; fi`;
  const owner = (body, createdAt = "2026-06-01T00:00:00Z", extra = {}) => ({
    id: 1,
    body,
    createdAt,
    authorAssociation: "OWNER",
    ...extra,
  });

  it("is true only for a non-noise OWNER comment after the mark", () => {
    const cases = [
      [[owner("move the button left")], "2026-01-01T00:00:00Z", "YES"],
      [[owner("lgtm")], "2026-01-01T00:00:00Z", "NO"],
      [[owner("move the button left", "2025-01-01T00:00:00Z")], "2026-01-01T00:00:00Z", "NO"],
      [[owner("move it <!-- drafto-factory-x -->")], "2026-01-01T00:00:00Z", "NO"],
      [
        [owner("move the button left", undefined, { authorAssociation: "NONE" })],
        "2026-01-01T00:00:00Z",
        "NO",
      ],
      [[owner("move the button left")], "", "NO"],
      [[owner("move the button left")], "null", "NO"],
    ];
    for (const [comments, since, want] of cases) {
      withBash(check(since), { comments }, (r) => {
        assert.equal(r.stdout.trim(), want, `${JSON.stringify(comments)} since ${since}`);
      });
    }
  });
});

describe("pr_preview_url (real helper)", () => {
  it("finds the preview in the Vercel comment or the rollup, and nothing otherwise", () => {
    const viaComment = JSON.stringify({
      comments: [
        { author: { login: "vercel" }, body: "Preview: https://drafto-git-x.vercel.app ok" },
      ],
      statusCheckRollup: [],
    });
    const viaRollup = JSON.stringify({
      comments: [],
      statusCheckRollup: [{ context: "Vercel", targetUrl: "https://drafto-abc.vercel.app" }],
    });
    for (const [view, want] of [
      [viaComment, "https://drafto-git-x.vercel.app"],
      [viaRollup, "https://drafto-abc.vercel.app"],
      [JSON.stringify({ comments: [], statusCheckRollup: [] }), ""],
      ["not json", ""],
    ]) {
      withBash(`printf '[%s]\\n' "$(pr_preview_url '${view}')"`, {}, (r) => {
        assert.equal(r.stdout.trim(), `[${want}]`);
      });
    }
  });
});

// ── The shell lane (Wave 5A): verify_shell_work / _stop / _housekeeping ────

describe("factory-agent.sh shell lane: static wiring", () => {
  it("builds the shell lane and calls it from both seams, once each", () => {
    assert.match(script, /^VERIFY_BUILT_LANES="[^"]*\bshell\b[^"]*"/m);
    const work = extract("verify_work_lanes");
    const stop = extract("verify_stop_lanes");
    assert.equal(work.match(/verify_shell_work "\$@"/g)?.length, 1);
    assert.equal(stop.match(/verify_shell_stop "\$@"/g)?.length, 1);
  });

  it("runs housekeeping at the top of --watch, after the CodeRabbit one, before the In Review loop", () => {
    const cr = script.indexOf("\n  cr_cli_housekeeping\n", watchStart);
    const hk = script.indexOf("\n  verify_shell_housekeeping\n", watchStart);
    const review = script.indexOf("  # ── 2. In Review → In Test ──", watchStart);
    const sweep = script.indexOf("\n  verify_sweep\n", watchStart);
    assert.ok(cr !== -1 && hk !== -1 && review !== -1 && sweep !== -1);
    assert.ok(cr < hk && hk < review && review < sweep);
    // A session limit ends the tick, like every other claude call's.
    assert.match(
      script.slice(hk, review),
      /if \[\[ "\$\{VERIFY_SESSION_LIMITED:-0\}" == "1" \]\]; then\n\s*log "=== factory-agent --\$MODE_NAME completed[^\n]*\n\s*exit 0\n\s*fi/,
    );
  });

  it("keeps the lane's claude call in node: no run-claude, no --chrome, no skip-permissions in bash", () => {
    for (const name of ["verify_shell_work", "verify_shell_stop", "verify_shell_housekeeping"]) {
      assert.doesNotMatch(
        extract(name),
        /run-claude\.mjs|--chrome|dangerously-skip-permissions|claude -p/,
        name,
      );
    }
  });

  it("starts the lane with the files and knobs the module needs, and never under --dry-run", () => {
    const work = extract("verify_shell_work");
    for (const flag of [
      '--issue "$issue_num"',
      '--pr "$pr_num"',
      '--sha "$head_sha"',
      '--platforms "$platforms"',
      '--state-file "$STATE_FILE"',
      '--repo-root "$REPO_ROOT"',
      '--run-root "$VERIFY_DIR"',
      '--prompt-file "$VERIFY_PROMPT_FILE"',
      '--account-file "$FACTORY_BROWSER_ACCOUNT_FILE"',
      '--signin-key-file "$FACTORY_BROWSER_SIGNIN_KEY_FILE"',
      // The sign-in lease browser_run also mints under (browser-signin.mjs).
      '--signin-lease-file "$SIGNIN_LEASE_FILE"',
    ]) {
      assert.ok(work.includes(flag), flag);
    }
    assert.ok(work.indexOf('[[ "$DRY_RUN" -eq 1 ]]') < work.indexOf('verify-lane.mjs" start'));
    assert.match(script, /^VERIFY_PROMPT_FILE="\$SCRIPT_DIR\/factory-verify-prompt\.md"$/m);
    assert.ok(existsSync(resolve(scriptsDir, "factory-verify-prompt.md")));
  });
});

describe("verify_shell_work (real helper, lane module stubbed)", () => {
  const LANES = '{"shell":"none","browser":"none"}';
  const work = (lanes = LANES) => `verify_shell_work 7 70 "$HEAD" '{"web":true}' '${lanes}'`;
  const env = (over = {}) => ({ HEAD, VERIFY_BUILT_LANES_STUB: "shell", ...over });

  it("starts the lane when its state for the head isn't terminal", () => {
    const started = JSON.stringify({ started: true, runId: "7-aaaaaaaaaaaa-x" });
    withBash(work(), { env: env({ LANE_START_STUB: started }) }, (r) => {
      assert.match(
        r.calls,
        new RegExp(
          `^lane start --issue 7 --pr 70 --sha ${HEAD} --platforms \\{"web":true\\} `,
          "m",
        ),
      );
      assert.match(r.log, /verification shell lane started for aaaaaaaaaaaa/);
      assert.equal(r.issue.verifyShell ?? null, null, "the module records running itself");
    });
  });

  it("hands the lane FACTORY_MODEL, opus[1m] when unset (ADR-0101)", () => {
    const started = JSON.stringify({ started: true, runId: "7-aaaaaaaaaaaa-x" });
    for (const [model, want] of [
      [undefined, "opus[1m]"],
      ["claude-sonnet-5-5", "claude-sonnet-5-5"],
    ]) {
      const over = { LANE_START_STUB: started };
      if (model !== undefined) over.FACTORY_MODEL = model;
      withBash(work(), { env: env(over) }, (r) => {
        const line = r.calls.split("\n").find((l) => l.startsWith("lane start "));
        assert.ok(line, r.calls);
        assert.ok(line.includes(` --model ${want} `), line);
        assert.ok(line.includes(" --effort xhigh "), line);
      });
    }
  });

  it("does nothing for a terminal state, a lane switched off or not built, or under --dry-run", () => {
    for (const state of [
      "reported:pass",
      "timeout",
      "unavailable:guard",
      "skipped:attempts",
      "no-preview",
      "stale-branch",
    ]) {
      withBash(work(`{"shell":"${state}"}`), { env: env() }, (r) => {
        assert.doesNotMatch(r.calls, /^lane /m, state);
      });
    }
    withBash(work(), { env: env({ FACTORY_VERIFY_LANES: "browser" }) }, (r) =>
      assert.doesNotMatch(r.calls, /^lane /m),
    );
    withBash(work(), { env: env({ VERIFY_BUILT_LANES_STUB: "" }) }, (r) =>
      assert.doesNotMatch(r.calls, /^lane /m),
    );
    withBash(work(), { env: env({ DRY_RUN: "1" }) }, (r) => {
      assert.doesNotMatch(r.calls, /^lane /m);
      assert.match(r.log, /DRY-RUN: would start the verification shell lane for #7/);
    });
  });

  it("tries again from a pending state: running, retry, deferred", () => {
    for (const state of ["running", "retry:error", "deferred:memory"]) {
      withBash(work(`{"shell":"${state}"}`), { env: env() }, (r) =>
        assert.match(r.calls, /^lane start /m, state),
      );
    }
  });

  it("maps each refusal to a lane state, or to nothing (retry next tick)", () => {
    const rows = [
      ["attempts", `${HEAD}:skipped:attempts`],
      ["memory", `${HEAD}:deferred:memory`],
      ["disk", `${HEAD}:deferred:disk`],
      ["busy", `${HEAD}:deferred:busy`],
      ["lane-paused", `${HEAD}:deferred:lane-paused`],
      ["factory-paused", `${HEAD}:deferred:paused`],
      ["claude-missing", `${HEAD}:unavailable:claude-missing`],
      ["prompt-missing", `${HEAD}:unavailable:prompt-missing`],
      ["preview-wait", null],
      ["scenario-wait", null],
      ["head-moved", null],
      ["start-failed", null],
      ["running", null],
      ["off", null],
      ["hold-cap-near", null],
    ];
    for (const [reason, want] of rows) {
      const stub = JSON.stringify({ started: false, reason });
      withBash(work(), { env: env({ LANE_START_STUB: stub }) }, (r) => {
        assert.equal(r.issue.verifyShell ?? null, want, reason);
      });
    }
  });

  it("never lets a deferral hide an earlier attempt's outcome", () => {
    const stub = JSON.stringify({ started: false, reason: "busy" });
    withBash(
      work(`{"shell":"retry:error"}`),
      { env: env({ LANE_START_STUB: stub }), state: { verifyShell: `${HEAD}:retry:error` } },
      (r) => {
        assert.equal(r.issue.verifyShell, `${HEAD}:retry:error`);
        assert.doesNotMatch(r.calls, /factory:set-issue-field/);
      },
    );
    // A terminal refusal still lands over a retry.
    const spent = JSON.stringify({ started: false, reason: "attempts" });
    withBash(
      work(`{"shell":"retry:error"}`),
      { env: env({ LANE_START_STUB: spent }), state: { verifyShell: `${HEAD}:retry:error` } },
      (r) => assert.equal(r.issue.verifyShell, `${HEAD}:skipped:attempts`),
    );
  });

  it("leaves a deferral that's already recorded alone, and survives a module that fails", () => {
    const stub = JSON.stringify({ started: false, reason: "memory" });
    withBash(
      work(`{"shell":"deferred:memory"}`),
      { env: env({ LANE_START_STUB: stub }), state: { verifyShell: `${HEAD}:deferred:memory` } },
      (r) => {
        assert.doesNotMatch(r.calls, /factory:set-issue-field/);
      },
    );
    withBash(work(), { env: env({ LANE_FAIL: "1" }) }, (r) => {
      assert.match(r.log, /couldn't be started \(non-fatal; retried next tick\)/);
    });
  });

  it("runs from the sweep's work-lanes action", () => {
    const card = 'verify_sweep_card ITEM 7 "status:testing"';
    const state = {
      verifySha: HEAD,
      verifyStartedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      lastReviewSha: HEAD,
      lastFeedbackAt: "2026-01-01T00:00:00Z",
      intestCommentSha: HEAD,
    };
    withBash(
      card,
      {
        env: env({ PR_OBJ_STUB: PR_OBJ, PR_VIEW_STUB: prView(), VERIFY_BUILT_LANES_STUB: "shell" }),
        state,
      },
      (r) => {
        assert.match(r.log, /Testing → work-lanes \(lanes-pending\)/);
        assert.match(r.calls, new RegExp(`^lane start --issue 7 --pr 70 --sha ${HEAD} `, "m"));
      },
    );
  });
});

describe("verify_shell_stop (real helper, lane module stubbed)", () => {
  it("stops the card's run on its way out of Testing, and logs it", () => {
    const stub = JSON.stringify({ state: "stopped", runId: "r" });
    withBash(
      `verify_shell_stop 7 "$HEAD" hold-cap`,
      { env: { HEAD, LANE_STOP_STUB: stub } },
      (r) => {
        assert.match(
          r.calls,
          new RegExp(`^lane stop --issue 7 --sha ${HEAD} --reason hold-cap `, "m"),
        );
        assert.match(r.log, /verification shell lane stopped \(hold-cap\)/);
      },
    );
  });

  it("is quiet when nothing ran, does nothing under --dry-run and survives a failure", () => {
    withBash(`verify_shell_stop 7 "$HEAD" threads`, { env: { HEAD } }, (r) =>
      assert.doesNotMatch(r.log, /stopped/),
    );
    withBash(`verify_shell_stop 7 "$HEAD" threads`, { env: { HEAD, DRY_RUN: "1" } }, (r) =>
      assert.doesNotMatch(r.calls, /^lane /m),
    );
    withBash(`verify_shell_stop 7 "$HEAD" threads`, { env: { HEAD, LANE_FAIL: "1" } }, (r) =>
      assert.match(r.log, /housekeeping reaps it/),
    );
  });

  it("runs on a hand-back and on a promotion", () => {
    withBash(`verify_hand_back ITEM 7 70 "$HEAD" ci-red '{}'`, { env: { HEAD } }, (r) => {
      assert.match(r.calls, /^lane stop --issue 7 /m);
    });
  });
});

describe("verify_shell_housekeeping (real helper, lane module stubbed)", () => {
  const run = 'verify_shell_housekeeping; echo "LIMITED=$VERIFY_SESSION_LIMITED"';

  it("is silent on an idle or running tick", () => {
    for (const out of [
      '{"state":"idle","reaped":{"worktrees":[],"runDirs":[]}}',
      '{"state":"running","runId":"r"}',
    ]) {
      withBash(run, { env: { LANE_HK_STUB: out } }, (r) => {
        assert.doesNotMatch(r.log, /Verification shell lane/);
        assert.match(r.stdout, /LIMITED=0/);
      });
    }
  });

  it("logs what it collected, reaped or killed", () => {
    const out = JSON.stringify({ state: "done", outcome: "reported", laneState: "reported:pass" });
    withBash(run, { env: { LANE_HK_STUB: out } }, (r) =>
      assert.match(r.log, /Verification shell lane: .*"reported:pass"/),
    );
    const reaped = JSON.stringify({
      state: "idle",
      reaped: { worktrees: [], runDirs: [], privateDirs: ["/x"] },
    });
    withBash(run, { env: { LANE_HK_STUB: reaped } }, (r) => assert.match(r.log, /privateDirs/));
  });

  it("pauses the factory on a session limit and tells --watch to end the tick", () => {
    const out = JSON.stringify({
      state: "done",
      outcome: "session-limit",
      sessionLimit: {
        resetAt: "2026-10-21T15:02:00.000Z",
        reason: "You've hit your session limit",
      },
    });
    withBash(run, { env: { LANE_HK_STUB: out } }, (r) => {
      assert.match(
        r.calls,
        /^pause until=2026-10-21T15:02:00\.000Z reason=You've hit your session limit$/m,
      );
      assert.match(r.stdout, /LIMITED=1/);
    });
    withBash(run, { env: { LANE_HK_STUB: out, DRY_RUN: "1" } }, (r) => {
      assert.doesNotMatch(r.calls, /^pause /m);
      assert.match(r.calls, /^lane housekeeping .*--dry-run 1/m);
    });
  });

  it("warns on an error or a failed module, never failing the tick", () => {
    withBash(run, { env: { LANE_HK_STUB: '{"state":"error","error":"x"}' } }, (r) =>
      assert.match(r.log, /housekeeping error \(non-fatal/),
    );
    withBash(run, { env: { LANE_FAIL: "1" } }, (r) =>
      assert.match(r.log, /housekeeping failed \(non-fatal/),
    );
  });
});

describe("verify_compose_report with a shell run (real composer, lane module stubbed)", () => {
  const scenario = [
    "## Test scenario",
    "### Web",
    "1. Open /notebooks — expected: the list.",
    `<!-- drafto-factory-scenario-sha:${HEAD} -->`,
  ].join("\n");
  const comments = [{ id: 5, body: scenario, createdAt: "t", authorAssociation: "OWNER" }];
  const output =
    "<<<REPORT\n**Summary:** 1 PASS\n**Assessment:** fine.\nREPORT>>>\n<<<MANUAL\nMANUAL>>>\nshell=ok verdict=pass\n";
  const promote = `mkdir -p "$LOG_DIR/run" && printf '%s' '${output}' > "$LOG_DIR/run/shell-output.txt" && node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field 7 verifyShellRunDir "$LOG_DIR/run" --state-file "$STATE_FILE" >/dev/null && verify_promote ITEM 7 70 "$HEAD" lanes-done '{"shell":"reported:pass","browser":"skipped:not-built"}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
  const state = { verifyShell: `${HEAD}:reported:pass` };

  it("adds the run's own gaps to the report", () => {
    const gaps = JSON.stringify({
      gaps: [{ lane: "shell", reason: "GAP-SENTINEL no bypass secret" }],
      bypassUsed: false,
    });
    withBash(promote, { env: { HEAD, LANE_GAPS_STUB: gaps }, state, comments }, (r) => {
      const body = r.comments.at(-1).body;
      assert.match(body, /\*\*Repo & API \(shell\):\*\* GAP-SENTINEL no bypass secret/);
      assert.match(body, /\*\*Verdict: PASS\*\*/);
      assert.match(r.calls, /^lane gaps --run-dir .*\/run$/m);
    });
  });

  // A reuse record for this head: <reused> kept from <built>, which finished <daysAgo> days ago.
  const reuse = (reused, built, daysAgo) => ({
    intestBetaSha: HEAD,
    intestBetaReused: reused,
    intestBetaBuilt: built,
    intestBetaBuiltAt: `${built.split(":")[0]}:${Math.floor(Date.now() / 1000 - daysAgo * 86400)}`,
  });

  it("names a beta reused from an earlier commit, with its build numbers (ADR-0081)", () => {
    const notice = {
      id: 6,
      body: `🏭 **iOS beta build 147 uploaded** — TestFlight, built from PR #70 @ \`${OLD.slice(0, 12)}\` (pre-merge).\n\n<!-- drafto-factory-intest-build:ios:147 -->`,
      createdAt: "t",
      authorAssociation: "OWNER",
    };
    withBash(
      promote,
      {
        env: { HEAD, DIFF_STUB: "apps/web/a.ts\napps/mobile/b.ts" },
        state: { ...state, ...reuse(`mobile:${OLD}`, `mobile:${OLD}`, 1) },
        comments: [...comments, notice],
      },
      (r) => {
        const body = r.comments.at(-1).body;
        assert.match(
          body,
          /\| iOS \/ Android \| manual \| — \| No mobile change since iOS build 147 \(`bbbbbbbbbbbb`\); keep testing that build\. Android: Play's internal track serves only its newest upload, so check that the installed build number is the one an earlier comment gives\. If Play shows a newer build, this card's Android build is no longer installable from Play; test iOS from TestFlight and ask in a comment for the Android build\. \|/,
        );
      },
    );
    // Reuse recorded for another head is not this commit's.
    withBash(
      promote,
      {
        env: { HEAD, DIFF_STUB: "apps/web/a.ts\napps/mobile/b.ts" },
        state: { ...state, ...reuse(`mobile:${OLD}`, `mobile:${OLD}`, 1), intestBetaSha: OLD },
        comments: [...comments, notice],
      },
      (r) => assert.doesNotMatch(r.comments.at(-1).body, /No mobile change since/),
    );
  });

  it("never reports a stale reuse record, e.g. with beta dispatch off (ADR-0081)", () => {
    // With FACTORY_INTEST_BETA=0 nothing re-checks intestBetaReused before the
    // report reads it, so the report filters it itself: an expired build, one
    // of unknown age, or one that is no longer the lane's last build.
    for (const [why, rec] of [
      ["61 days old", reuse(`mobile:${OLD}`, `mobile:${OLD}`, 61)],
      ["over a 7-day limit", reuse(`mobile:${OLD}`, `mobile:${OLD}`, 8)],
      ["unknown age", { ...reuse(`mobile:${OLD}`, `mobile:${OLD}`, 1), intestBetaBuiltAt: null }],
      ["a newer build since", reuse(`mobile:${OLD}`, `mobile:${HEAD}`, 1)],
    ]) {
      withBash(
        promote,
        {
          env: {
            HEAD,
            DIFF_STUB: "apps/web/a.ts\napps/mobile/b.ts",
            FACTORY_INTEST_BETA: "0",
            FACTORY_INTEST_BETA_REUSE_MAX_DAYS: why === "over a 7-day limit" ? "7" : "60",
          },
          state: { ...state, ...rec },
          comments,
        },
        (r) => {
          const body = r.comments.at(-1).body;
          assert.doesNotMatch(body, /No mobile change since/, why);
          assert.match(body, /\| iOS \/ Android \| manual \| — \| no beta was dispatched/, why);
        },
      );
    }
  });

  it("scans for the bypass secret the run held even after its file is gone (fails closed)", () => {
    const gaps = JSON.stringify({ gaps: [], bypassUsed: true });
    withBash(promote, { env: { HEAD, LANE_GAPS_STUB: gaps }, state, comments }, (r) => {
      const body = r.comments.at(-1).body;
      assert.match(body, /report withheld/i);
      assert.match(body, /bypass secret file/);
    });
  });
});

describe("the browser lane's --watch half (verify_browser_work, verify_browser_stop)", () => {
  const WEB = '{"web":true,"mobile":false,"desktop":false}';
  const work = (platforms, browser = "none") =>
    `verify_browser_work 7 70 "$HEAD" '${platforms}' '{"shell":"none","browser":"${browser}"}'`;
  const show = 'echo "C=[$VERIFY_BROWSER_CANDIDATES]"';

  it("is wired into the lane seams, and the browser lane counts as built", () => {
    assert.match(extract("verify_work_lanes"), /^\s+verify_browser_work "\$@" \|\| true$/m);
    assert.match(extract("verify_stop_lanes"), /^\s+verify_browser_stop "\$@" \|\| true$/m);
    assert.match(script, /^VERIFY_BUILT_LANES="[^"]*\bbrowser\b[^"]*"/m);
  });

  it("builds every lane, so none reads not-built with the script's own list", () => {
    const built = script.match(/^VERIFY_BUILT_LANES="([^"]*)"/m)?.[1];
    assert.equal(built, "shell,browser,device");
    // Both seams call both lanes, the shell lane first (it starts a detached
    // run; the browser lane only queues a candidate).
    const work = extract("verify_work_lanes");
    assert.ok(work.indexOf("verify_shell_work") < work.indexOf("verify_browser_work"));
    const stop = extract("verify_stop_lanes");
    assert.ok(stop.indexOf("verify_shell_stop") < stop.indexOf("verify_browser_stop"));
    const states = `verify_lane_states "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$HEAD" 1`;
    withBash(states, { env: { HEAD, VERIFY_BUILT_LANES_STUB: built } }, (r) => {
      // The device lane is off unless listed and FACTORY_VERIFY_DEVICE=1.
      assert.deepEqual(JSON.parse(r.stdout), {
        shell: "none",
        browser: "none",
        device: "skipped:lane-off",
      });
    });
    // A lane switched off still reads lane-off, and one missing from the list
    // still reads not-built (the wording a future lane would get).
    withBash(states, { env: { HEAD, VERIFY_BUILT_LANES_STUB: "browser" } }, (r) => {
      assert.deepEqual(JSON.parse(r.stdout), {
        shell: "skipped:not-built",
        browser: "none",
        device: "skipped:lane-off",
      });
    });
  });

  it("does nothing, recording nothing, when the browser lane is switched off or not built", () => {
    const NOT_WEB = '{"web":false,"mobile":true,"desktop":false}';
    for (const env of [
      { FACTORY_VERIFY_LANES: "shell", VERIFY_BUILT_LANES_STUB: "shell,browser" },
      { VERIFY_BUILT_LANES_STUB: "shell" },
    ]) {
      withBash(`${work(WEB)}\n${work(NOT_WEB)}\n${show}`, { env: { HEAD, ...env } }, (r) => {
        assert.equal(r.stdout.trim(), "C=[]", JSON.stringify(env));
        assert.equal(r.issue.verifyBrowser ?? null, null, JSON.stringify(env));
      });
    }
  });

  it("queues a verify candidate for a web card whose lane has no result, once", () => {
    withBash(
      `${work(WEB)}\n${work(WEB)}\n${show}`,
      { env: { HEAD, VERIFY_BUILT_LANES_STUB: "shell,browser" } },
      (r) => {
        assert.equal(r.stdout.trim(), `C=[verify:7:70:${HEAD}]`);
        assert.equal(r.issue.verifyBrowser ?? null, null, "queueing records nothing");
        assert.match(r.log, /browser lane queued for --browser/);
      },
    );
    withBash(
      `${work(WEB)}\n${show}`,
      {
        env: {
          HEAD,
          VERIFY_BUILT_LANES_STUB: "shell,browser",
          VERIFY_BROWSER_CANDIDATES_STUB: `verify:9:90:${OLD}`,
        },
      },
      (r) => assert.equal(r.stdout.trim(), `C=[verify:9:90:${OLD} verify:7:70:${HEAD}]`),
    );
  });

  it("leaves a lane alone once it has a result for this commit", () => {
    for (const browser of ["reported:pass", "unavailable:chrome", "skipped:not-built", "timeout"]) {
      withBash(
        `${work(WEB, browser)}\n${show}`,
        { env: { HEAD, VERIFY_BUILT_LANES_STUB: "shell,browser" } },
        (r) => {
          assert.equal(r.stdout.trim(), "C=[]", browser);
          assert.equal(r.issue.verifyBrowser ?? null, null, browser);
        },
      );
    }
  });

  it("ends the lane as skipped:not-web for a card with no web changes, clearing an old run dir", () => {
    const state = { verifyBrowserRunDir: "/old/run" };
    withBash(
      `${work('{"web":false,"mobile":true,"desktop":false}')}\n${show}`,
      { env: { HEAD, VERIFY_BUILT_LANES_STUB: "shell,browser" }, state },
      (r) => {
        assert.equal(r.stdout.trim(), "C=[]");
        assert.equal(r.issue.verifyBrowser, `${HEAD}:skipped:not-web`);
        assert.equal(r.issue.verifyBrowserRunDir ?? null, null);
      },
    );
  });

  it("ends the lane as skipped:browser-off when the runner or its verify kind is off", () => {
    for (const env of [{ FACTORY_BROWSER: "0" }, { FACTORY_BROWSER_KINDS: "intest" }]) {
      withBash(
        `${work(WEB)}\n${show}`,
        { env: { HEAD, VERIFY_BUILT_LANES_STUB: "shell,browser", ...env } },
        (r) => {
          assert.equal(r.stdout.trim(), "C=[]", JSON.stringify(env));
          assert.equal(r.issue.verifyBrowser, `${HEAD}:skipped:browser-off`);
        },
      );
    }
  });

  it("waits, recording nothing, while the PR's platforms can't be read", () => {
    for (const platforms of ["{}", "not json"]) {
      withBash(
        `${work(platforms)}\n${show}`,
        { env: { HEAD, VERIFY_BUILT_LANES_STUB: "shell,browser" } },
        (r) => {
          assert.equal(r.stdout.trim(), "C=[]", platforms);
          assert.equal(r.issue.verifyBrowser ?? null, null);
          assert.match(r.log, /platforms are unknown this tick; the browser lane waits/);
        },
      );
    }
  });

  it("records nothing in a dry run", () => {
    withBash(
      work('{"web":false}'),
      { env: { HEAD, VERIFY_BUILT_LANES_STUB: "shell,browser", DRY_RUN: "1" } },
      (r) => {
        assert.equal(r.issue.verifyBrowser ?? null, null);
      },
    );
  });

  it("drops only the stopped card's candidate", () => {
    const env = {
      HEAD,
      VERIFY_BROWSER_CANDIDATES_STUB: `verify:9:90:${OLD} verify:7:70:${HEAD} verify:71:7:${OLD}`,
    };
    withBash(`verify_browser_stop 7 "$HEAD" hold-cap\n${show}`, { env }, (r) => {
      assert.equal(r.stdout.trim(), `C=[verify:9:90:${OLD} verify:71:7:${OLD}]`);
    });
    withBash(
      `verify_hand_back ITEM 7 70 "$HEAD" ci-red '{}'\n${show}`,
      { env: { ...env, PR_OBJ_STUB: PR_OBJ } },
      (r) => assert.equal(r.stdout.trim(), `C=[verify:9:90:${OLD} verify:71:7:${OLD}]`),
    );
  });

  it("agrees with verify-decide.mjs on which lane states are final", () => {
    const tokens = [
      "reported:pass",
      "reported",
      "timeout",
      "unavailable:chrome",
      "stale-branch",
      "no-preview",
      "skipped:not-web",
      "none",
      "",
      "running",
      "queued:x",
      // The shell lane's pending states (5A) and the browser lane's preview wait.
      "deferred:memory",
      "retry:error",
      "waiting-preview:2026-10-21T00:00:00Z",
    ];
    const body = tokens
      .map((t) => `if verify_state_terminal '${t}'; then echo "T"; else echo "F"; fi`)
      .join("\n");
    withBash(body, {}, (r) => {
      const got = r.stdout.trim().split("\n");
      tokens.forEach((t, i) => {
        assert.equal(got[i] === "T", isTerminalLaneState(t), JSON.stringify(t));
      });
    });
  });
});

describe("the browser lane in the Testing sweep (real helpers, real composer)", () => {
  const card = 'verify_sweep_card ITEM 7 "$LABELS"';
  const base = (over = {}) => ({
    HEAD,
    LABELS: "status:testing",
    PR_OBJ_STUB: PR_OBJ,
    PR_VIEW_STUB: prView(),
    ...over,
  });
  const reviewed = (over = {}) => ({
    verifySha: HEAD,
    verifyStartedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    lastReviewSha: HEAD,
    lastFeedbackAt: "2026-01-01T00:00:00Z",
    intestCommentSha: HEAD,
    ...over,
  });
  const scenario = [
    "🏭 **Test scenario — verifying now (Testing).**",
    "## Test scenario",
    "### Web",
    "1. Open /notebooks — expected: the list.",
    "<!-- drafto-factory-in-test -->",
    "<!-- drafto-factory-test-scenario -->",
    `<!-- drafto-factory-scenario-sha:${HEAD} -->`,
  ].join("\n");
  const comments = [{ id: 5, body: scenario, createdAt: "t", authorAssociation: "OWNER" }];

  it("queues the card's verify candidate while its browser lane is pending", () => {
    withBash(
      `${card}\necho "C=[$VERIFY_BROWSER_CANDIDATES]"`,
      { env: base({ VERIFY_BUILT_LANES_STUB: "browser" }), state: reviewed(), comments },
      (r) => {
        assert.match(r.log, /Testing → work-lanes \(lanes-pending\)/);
        assert.equal(r.stdout.trim(), `C=[verify:7:70:${HEAD}]`);
      },
    );
  });

  it("promotes once the lane has reported, with the browser run in the report", () => {
    const output = [
      "<<<REPORT",
      "Ran against the preview as qa@example.com.",
      "",
      "| # | Step | Result | Evidence |",
      "|---|---|---|---|",
      "| 1 | Open /notebooks | PASS | the list shows |",
      "",
      "**Summary:** 1 PASS, 0 FAIL, 0 WARN, 0 SKIP.",
      "REPORT>>>",
      "browser=ok verdict=pass",
    ].join("\n");
    // The sink's record, as browser_run verify leaves it.
    const seed = [
      'RUN="$LOG_DIR/browser/issue-7-aaaaaaaaaaaa-verify-20261021T000000"',
      'mkdir -p "$RUN"',
      `printf '%s\\n' '${output}' > "$RUN/runner-output.txt"`,
      `node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field 7 verifyBrowser "$HEAD:reported:pass" --state-file "$STATE_FILE" >/dev/null`,
      'node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field 7 verifyBrowserRunDir "$RUN" --state-file "$STATE_FILE" >/dev/null',
    ].join("\n");
    withBash(
      `${seed}\n${card}`,
      { env: base({ VERIFY_BUILT_LANES_STUB: "browser" }), state: reviewed(), comments },
      (r) => {
        assert.match(r.log, /Testing → promote \(lanes-done\)/);
        assert.match(r.calls, /^transition In Test$/m);
        const report = r.comments.at(-1).body;
        assert.match(report, /\*\*Verdict: PASS\*\*/);
        assert.match(report, /\| Web \(browser\) \| ran \| PASS \|/);
        assert.match(report, /1 PASS, 0 FAIL, 0 WARN, 0 SKIP/);
        assert.match(report, /<summary>Web \(browser\): full report<\/summary>/);
        assert.doesNotMatch(report, /Run the \*\*Web\*\* steps in the test scenario by hand/);
      },
    );
  });

  it("works both lanes from the sweep: starts the shell run and queues the browser candidate", () => {
    withBash(
      `${card}\necho "C=[$VERIFY_BROWSER_CANDIDATES]"`,
      { env: base({ VERIFY_BUILT_LANES_STUB: "shell,browser" }), state: reviewed(), comments },
      (r) => {
        assert.match(r.log, /Testing → work-lanes \(lanes-pending\)/);
        assert.match(r.calls, new RegExp(`^lane start --issue 7 --pr 70 --sha ${HEAD} `, "m"));
        assert.equal(r.stdout.trim(), `C=[verify:7:70:${HEAD}]`);
      },
    );
  });

  it("promotes once both lanes have reported, with both in the report", () => {
    const browserOut = [
      "<<<REPORT",
      "| # | Step | Result | Evidence |",
      "|---|---|---|---|",
      "| 1 | Open /notebooks | PASS | the list shows |",
      "**Summary:** 1 PASS, 0 FAIL, 0 WARN, 0 SKIP.",
      "REPORT>>>",
      "browser=ok verdict=pass",
    ].join("\n");
    const shellOut = [
      "<<<REPORT",
      "| # | Check | Result | Evidence |",
      "|---|---|---|---|",
      "| 1 | pnpm test | PASS | 12 tests |",
      "**Summary:** 1 PASS, 0 FAIL.",
      "**Assessment:** fine.",
      "REPORT>>>",
      "<<<MANUAL",
      "MANUAL>>>",
      "shell=ok verdict=warn",
    ].join("\n");
    const set = (field, value) =>
      `node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field 7 ${field} "${value}" --state-file "$STATE_FILE" >/dev/null`;
    const seed = [
      'B="$LOG_DIR/browser/issue-7-aaaaaaaaaaaa-verify-20261021T000000"; S="$LOG_DIR/verify/shell-run"',
      'mkdir -p "$B" "$S"',
      `printf '%s\\n' '${browserOut}' > "$B/runner-output.txt"`,
      `printf '%s\\n' '${shellOut}' > "$S/shell-output.txt"`,
      set("verifyBrowser", "$HEAD:reported:pass"),
      set("verifyBrowserRunDir", "$B"),
      set("verifyShell", "$HEAD:reported:warn"),
      set("verifyShellRunDir", "$S"),
    ].join("\n");
    withBash(
      `${seed}\n${card}`,
      { env: base({ VERIFY_BUILT_LANES_STUB: "shell,browser" }), state: reviewed(), comments },
      (r) => {
        assert.match(r.log, /Testing → promote \(lanes-done\)/);
        const report = r.comments.at(-1).body;
        assert.match(report, /\*\*Verdict: WARN\*\*/, "the worst of the two");
        assert.match(report, /\| Repo & API \(shell\) \| ran \| WARN \|/);
        assert.match(report, /\| Web \(browser\) \| ran \| PASS \|/);
        assert.doesNotMatch(report, /isn't built yet/);
      },
    );
  });

  it("promotes as soon as the lane ends without a report, listing the Web steps for the human", () => {
    withBash(
      card,
      {
        env: base({ VERIFY_BUILT_LANES_STUB: "browser" }),
        state: reviewed({ verifyBrowser: `${HEAD}:unavailable:chrome-not-running` }),
        comments,
      },
      (r) => {
        assert.match(r.log, /Testing → promote \(lanes-done\)/);
        const report = r.comments.at(-1).body;
        assert.match(report, /unavailable: Chrome wasn't running on the Mac mini/);
        assert.match(report, /Run the \*\*Web\*\* steps in the test scenario by hand/);
      },
    );
  });
});

describe("handing a commit back to the In Test browser run (verify_browser_unclaim)", () => {
  const promote = (lanes) =>
    `verify_promote ITEM 7 70 "$HEAD" lanes-done '${lanes}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
  const lanes = '{"shell":"skipped:not-built","browser":"reported:pass"}';
  const claimed = (browser) => ({ browserRunSha: HEAD, verifyBrowser: `${HEAD}:${browser}` });

  it("releases the claim when the minimal notice goes out instead of the report", () => {
    for (const browser of ["reported:pass", "stale-branch"]) {
      withBash(
        promote(lanes),
        { env: { HEAD, REPORT_FAIL: "1" }, state: claimed(browser) },
        (r) => {
          assert.match(r.comments.at(-1).body, /couldn't be composed/);
          assert.equal(r.issue.browserRunSha ?? null, null, browser);
          assert.match(r.log, /the In Test browser run will report instead/);
        },
      );
    }
  });

  it("keeps the claim when the report carries the result, or an In Test run made it", () => {
    withBash(promote(lanes), { env: { HEAD }, state: claimed("reported:pass") }, (r) => {
      assert.equal(r.issue.browserRunSha, HEAD);
    });
    for (const browser of ["skipped:already-run", "skipped:no-web-steps"]) {
      withBash(promote(lanes), { env: { HEAD, REPORT_FAIL: "1" }, state: claimed(browser) }, (r) =>
        assert.equal(r.issue.browserRunSha, HEAD, browser),
      );
    }
    withBash(
      `${promote(lanes)} || true`,
      {
        env: { HEAD, REPORT_FAIL: "1", FAIL_TRANSITION: "In Test" },
        state: claimed("reported:pass"),
      },
      (r) => assert.equal(r.issue.browserRunSha, HEAD, "still in Testing: nothing changes"),
    );
  });

  it("releases the claim when posting the report is given up", () => {
    const body = [
      'mkdir -p "$VERIFY_DIR"',
      `printf 'report <!-- drafto-factory-verify-sha:%s -->\\n' "$HEAD" > "$VERIFY_DIR/report-7-$HEAD.md"`,
      'touch -t 202601010000 "$VERIFY_DIR/report-7-$HEAD.md"',
      'verify_report_retry 7 "$HEAD" "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")"',
    ].join("\n");
    const state = { ...claimed("reported:warn"), verifyReportPosts: `${HEAD}:3` };
    withBash(body, { env: { HEAD, FAIL_COMMENT: "1" }, state }, (r) => {
      assert.match(r.log, /giving up on posting/);
      assert.equal(r.issue.browserRunSha ?? null, null);
    });
    const early = { ...claimed("reported:warn"), verifyReportPosts: `${HEAD}:1` };
    withBash(body, { env: { HEAD, FAIL_COMMENT: "1" }, state: early }, (r) => {
      assert.equal(r.issue.browserRunSha, HEAD, "retries left: keep it");
    });
  });
});

describe("packages/shared/ reaches the web app, for verification only (ADR-0053, 5C)", () => {
  // derivePlatforms maps packages/shared/ to the native apps only; the web app
  // imports it too. The verification stage (and only it) reads the --verify
  // variant, so a shared-only PR gets a browser run; betas, the In Test
  // platforms, the preview gate, parity and the intest kind keep the plain one.
  const SHARED = "packages/shared/src/editor/x.ts";
  const PLAIN = { mobile: true, desktop: true, web: false };
  const VIA = { mobile: true, desktop: true, web: true, webViaShared: true };
  const card = 'verify_sweep_card ITEM 7 "$LABELS"';
  const base = (over = {}) => ({
    HEAD,
    LABELS: "status:testing",
    PR_OBJ_STUB: PR_OBJ,
    PR_VIEW_STUB: prView(),
    DIFF_STUB: SHARED,
    ...over,
  });
  const reviewed = (over = {}) => ({
    verifySha: HEAD,
    verifyStartedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    lastReviewSha: HEAD,
    lastFeedbackAt: "2026-01-01T00:00:00Z",
    intestCommentSha: HEAD,
    ...over,
  });
  // The JSON each matching call line carries after <prefix> (the stubs log it compact).
  const jsonAfter = (calls, prefix) =>
    calls
      .split("\n")
      .filter((l) => l.startsWith(prefix))
      .map((l) => JSON.parse(l.slice(prefix.length)));

  it("reads both variants from one diff: plain for the betas, verification for the lanes", () => {
    const body = [
      "verify_pr_platforms 70",
      'echo "P=$(echo "$VERIFY_PLATFORMS" | jq -c .)"',
      'echo "L=$(echo "$VERIFY_LANE_PLATFORMS" | jq -c .)"',
    ].join("\n");
    withBash(body, { env: { HEAD, DIFF_STUB: SHARED } }, (r) => {
      assert.match(
        r.stdout,
        new RegExp(`^P=${JSON.stringify(PLAIN).replace(/[{}]/g, "\\$&")}$`, "m"),
      );
      assert.match(
        r.stdout,
        new RegExp(`^L=${JSON.stringify(VIA).replace(/[{}]/g, "\\$&")}$`, "m"),
      );
      assert.equal((r.calls.match(/^gh pr diff /gm) || []).length, 1, "one diff read");
    });
    // An unreadable diff leaves both unknown: the browser lane waits, never not-web.
    withBash(
      'verify_pr_platforms 70 || echo RC=1\necho "L=$VERIFY_LANE_PLATFORMS"',
      { env: { HEAD, DIFF_FAIL: "1" } },
      (r) => {
        assert.match(r.stdout, /^RC=1$/m);
        assert.match(r.stdout, /^L=\{\}$/m);
      },
    );
  });

  it("queues the browser candidate for a shared-only PR; the betas still get the plain platforms", () => {
    withBash(
      `${card}\necho "C=[$VERIFY_BROWSER_CANDIDATES]"`,
      { env: base({ VERIFY_BUILT_LANES_STUB: "shell,browser" }), state: reviewed() },
      (r) => {
        assert.match(r.log, /Testing → work-lanes \(lanes-pending\)/);
        assert.equal(r.stdout.trim(), `C=[verify:7:70:${HEAD}]`);
        assert.match(
          r.log,
          /browser lane queued for --browser \(aaaaaaaaaaaa; web via packages\/shared\/\)/,
        );
        assert.equal(r.issue.verifyBrowser ?? null, null, "not ended as skipped:not-web");
        assert.deepEqual(jsonAfter(r.calls, `dispatch 7 70 ${HEAD} `), [PLAIN]);
        // The shell lane is a verification lane too: it gets the variant.
        assert.match(
          r.calls,
          /^lane start [\s\S]*?--platforms \{[\s\S]*?"webViaShared": true[\s\S]*?\}/m,
        );
        assert.doesNotMatch(r.calls, /^handoff/m, "the scenario for this head exists");
      },
    );
  });

  it("writes the Testing-stage scenario with the variant, so it has the ### Web section the lane walks", () => {
    // A round started by the sweep (init), and the entry from In Review.
    withBash(
      card,
      { env: base(), state: reviewed({ verifySha: null, intestCommentSha: null }) },
      (r) => {
        assert.match(r.log, /Testing → init \(no-round\)/);
        assert.match(r.calls, /^handoff stage=testing /m);
        assert.deepEqual(jsonAfter(r.calls, "handoff-platforms "), [VIA]);
        assert.deepEqual(jsonAfter(r.calls, `dispatch 7 70 ${HEAD} `), [PLAIN]);
      },
    );
    const enter = `verify_enter ITEM 7 70 '${PR_OBJ}' '${prView()}' "$HEAD" "${SHARED}" '${JSON.stringify(PLAIN)}' ""`;
    withBash(enter, { env: { HEAD } }, (r) => {
      assert.match(r.calls, /^handoff stage=testing /m);
      assert.deepEqual(jsonAfter(r.calls, "handoff-platforms "), [VIA]);
      assert.deepEqual(jsonAfter(r.calls, `dispatch 7 70 ${HEAD} `), [PLAIN]);
    });
  });

  it("still ends the lane as skipped:not-web when the diff reaches the web app through neither", () => {
    withBash(
      `${card}\necho "C=[$VERIFY_BROWSER_CANDIDATES]"`,
      {
        env: base({ VERIFY_BUILT_LANES_STUB: "shell,browser", DIFF_STUB: "apps/mobile/a.ts" }),
        state: reviewed(),
      },
      (r) => {
        assert.equal(r.stdout.trim(), "C=[]");
        assert.equal(r.issue.verifyBrowser, `${HEAD}:skipped:not-web`);
      },
    );
  });

  it("says in the report that the web changes come through packages/shared/", () => {
    const promote = `verify_promote ITEM 7 70 "$HEAD" lanes-done '{"shell":"skipped:not-built","browser":"no-preview"}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
    withBash(promote, { env: { HEAD, DIFF_STUB: SHARED } }, (r) => {
      const report = r.comments.at(-1).body;
      const row = report.split("\n").find((l) => l.startsWith("| Web (browser) |"));
      assert.match(row, /web changes come through `packages\/shared\/`, which the web app imports/);
      assert.match(row, /no Vercel preview was ready for this commit/);
      assert.match(report, /\| iOS \/ Android \| manual \|/);
    });
    withBash(promote, { env: { HEAD } }, (r) => {
      assert.doesNotMatch(r.comments.at(-1).body, /come through `packages\/shared\/`/);
    });
  });

  it("falls back to the plain platforms, with a gap, when only the variant can't be derived", () => {
    const promote = `verify_promote ITEM 7 70 "$HEAD" lanes-done '{"shell":"skipped:not-built","browser":"no-preview"}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
    // The harness's node stub, with derive-platforms --verify failing on top.
    const failVerify = [
      'eval "orig_$(declare -f node)"',
      'node() { if [[ "$1" == */dispatch-release.mjs && " $* " == *" --verify "* ]]; then cat >/dev/null; return 1; fi; orig_node "$@"; }',
    ].join("\n");
    withBash(
      `${failVerify}\n${promote}`,
      { env: { HEAD, DIFF_STUB: `${SHARED}\napps/mobile/a.ts` } },
      (r) => {
        const report = r.comments.at(-1).body;
        // The native rows still come from the plain platforms.
        assert.match(report, /\| iOS \/ Android \| manual \|/);
        assert.match(report, /\| macOS \| manual \|/);
        assert.match(
          report,
          /\*\*Web \(browser\):\*\* the verification platforms couldn't be derived from the changed files/,
        );
      },
    );
  });

  it("keeps the variant for a rewrite of a verified commit's scenario, the plain platforms otherwise", () => {
    const sp = `scenario_platforms 7 "$HEAD" "${SHARED}" '${JSON.stringify(PLAIN)}' | jq -c .`;
    // The commit had a round (e.g. handed back to In Review after its report,
    // then promoted again without a new commit): same platforms as its scenario.
    withBash(sp, { env: { HEAD }, state: { verifySha: HEAD, verifyReportSha: HEAD } }, (r) => {
      assert.equal(r.stdout.trim(), JSON.stringify(VIA));
    });
    // No round, or a round for another commit: the plain platforms, untouched.
    for (const state of [{}, { verifySha: OLD }]) {
      withBash(sp, { env: { HEAD }, state }, (r) => {
        assert.equal(r.stdout.trim(), JSON.stringify(PLAIN), JSON.stringify(state));
      });
    }
    // No head, or a variant that can't be derived: the plain platforms.
    withBash(
      `scenario_platforms 7 "" "${SHARED}" '${JSON.stringify(PLAIN)}' | jq -c .`,
      { env: { HEAD }, state: { verifySha: HEAD } },
      (r) => assert.equal(r.stdout.trim(), JSON.stringify(PLAIN)),
    );
    withBash(
      `node() { case "$1" in */dispatch-release.mjs) return 1 ;; *) command node "$@" ;; esac; }\n${sp}`,
      { env: { HEAD }, state: { verifySha: HEAD } },
      (r) => assert.equal(r.stdout.trim(), JSON.stringify(PLAIN)),
    );
  });

  it("leaves betas, the In Test platforms, the preview gate, parity and the intest kind plain", () => {
    // Exactly one --verify read, in verify_platforms_of.
    assert.equal(
      (script.match(/dispatch-release\.mjs" derive-platforms --verify/g) || []).length,
      1,
    );
    assert.match(extract("verify_platforms_of"), /derive-platforms --verify --diff-file -/);
    const plainRead = (v, files) =>
      new RegExp(
        `${v}=\\$\\(printf '%s\\\\n' "\\$${files}" \\| node "\\$SCRIPT_DIR/lib/dispatch-release\\.mjs" derive-platforms --diff-file - `,
      );
    assert.match(script, plainRead("INTEST_PLATFORMS", "INTEST_DIFF_FILES"));
    assert.match(script, plainRead("INTEST_PLATS", "INTEST_FILES"));
    assert.match(script, plainRead("DISPATCH_PLATFORMS", "DIFF_FILES"));
    // The preview gate.
    assert.match(
      reviewLoop,
      /WEB_TOUCHED=\$\(echo "\$INTEST_PLATFORMS" \| jq -r '\.web \/\/ false'/,
    );
    // The In Review promotion: betas on INTEST_PLATFORMS; only its scenario
    // re-post takes the variant a verified commit's scenario had.
    const promotion = slice(
      'log "Issue #$ISSUE_NUM: required CI green (platforms:',
      "  # ── 2b. Testing sweep",
    );
    assert.equal(
      (
        promotion.match(
          /intest_dispatch_betas "\$ISSUE_NUM" "\$PR_NUM" "\$HEAD_SHA" "\$INTEST_PLATFORMS"/g,
        ) || []
      ).length,
      2,
    );
    assert.match(
      promotion,
      /SCENARIO_PLATFORMS=\$\(scenario_platforms "\$ISSUE_NUM" "\$HEAD_SHA" "\$INTEST_DIFF_FILES" "\$INTEST_PLATFORMS"\)/,
    );
    const handoffs = promotion.match(/intest_handoff [^\n]*/g) || [];
    assert.equal(handoffs.length, 2);
    for (const h of handoffs) {
      assert.match(h, /"\$INTEST_DIFF_FILES" "\$SCENARIO_PLATFORMS" "\$INTEST_BETA"/);
    }
    // The In Test sweep: betas and the intest browser candidate stay plain.
    const sweep = slice("  # ── In Test feedback sweep", "# ── --browser mode");
    assert.match(
      sweep,
      /intest_dispatch_betas "\$ISSUE_NUM" "\$INTEST_PR_NUM" "\$INTEST_HEAD_SHA" "\$INTEST_PLATS"/,
    );
    assert.match(
      sweep,
      /\[\[ "\$\(echo "\$INTEST_PLATS" \| jq -r '\.web \/\/ false' 2>\/dev\/null\)" == "true" \]\]; then\n\s*BROWSER_CANDIDATES=/,
    );
    assert.match(
      sweep,
      /INTEST_SCEN_PLATS=\$\(scenario_platforms "\$ISSUE_NUM" "\$INTEST_HEAD_SHA" "\$INTEST_FILES" "\$INTEST_PLATS"\)/,
    );
    assert.match(sweep, /"\$INTEST_FILES" "\$INTEST_SCEN_PLATS" \\\n\s*"\$INTEST_BETA"/);
    // Parity reads the diff itself, never derived platforms: apps/web/ only.
    const parity = extract("parity_violation");
    assert.doesNotMatch(parity, /derive-platforms|scenario_platforms|verify_/);
    assert.match(parity, /grep -qE '\^apps\/web\/'/);
    // Inside the stage: betas plain, scenario via scenario_platforms, lanes and
    // report on the variant.
    const prep = extract("verify_prepare");
    assert.match(prep, /intest_dispatch_betas "\$issue_num" "\$pr_num" "\$head_sha" "\$platforms"/);
    assert.match(
      prep,
      /scenario_plats=\$\(scenario_platforms "\$issue_num" "\$head_sha" "\$diff_files" "\$platforms"\)/,
    );
    assert.match(prep, /"\$diff_files" "\$scenario_plats" "\$beta" "\$cr_note"/);
    const sweepCard = extract("verify_sweep_card");
    assert.match(sweepCard, /"\$VERIFY_DIFF_FILES" \\\n\s*"\$VERIFY_PLATFORMS" "\$cr_note"/);
    assert.match(
      sweepCard,
      /verify_work_lanes "\$issue_num" "\$pr_num" "\$head_sha" "\$VERIFY_LANE_PLATFORMS" "\$lanes"/,
    );
    const promote = extract("verify_promote");
    assert.match(promote, /report_plats="\$VERIFY_LANE_PLATFORMS"/);
    assert.match(
      promote,
      /verify_compose_report "\$issue_num" "\$pr_num" "\$head_sha" "\$report_plats"/,
    );
  });
});

describe("the Web lane's screenshots in the verification report (ADR-0096, real composer)", () => {
  const RUN_ID = "verify-20261021T000000";
  const COMMIT = "c".repeat(40);
  const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const SHORT = HEAD.slice(0, 12);
  const RUN_REL = `browser/issue-7-${SHORT}-${RUN_ID}`;
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
  const url = (n) =>
    `https://raw.githubusercontent.com/JakubAnderwald/drafto/${COMMIT}/7/${SHORT}/${RUN_ID}/${String(n).padStart(2, "0")}.png`;
  // The record evidence-upload.mjs writes for a published run.
  const PUBLISHED = JSON.stringify({
    ok: true,
    issue: "7",
    sha: HEAD,
    runId: RUN_ID,
    ref: `refs/factory-evidence/7/${SHORT}/${RUN_ID}`,
    commit: COMMIT,
    images: [{ n: 1, url: url(1), local: "/x/shot-1.png", name: "shot-1.png" }],
    overflow: [],
  });
  const runnerOutput = (evidence = "the list shows (screenshot 1)") =>
    [
      "<<<REPORT",
      "| # | Step | Result | Evidence |",
      "|---|---|---|---|",
      `| 1 | Open /notebooks | PASS | ${evidence} |`,
      "**Summary:** 1 PASS, 0 FAIL, 0 WARN, 0 SKIP.",
      "REPORT>>>",
      "browser=ok verdict=pass",
    ].join("\n");
  const set = (field, value) =>
    `node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field 7 ${field} "${value}" --state-file "$STATE_FILE" >/dev/null`;
  // The browser lane's run as browser_run verify leaves it: the runner's
  // output, the guard-copied evidence and the session id, recorded in state.
  const seed = ({ output = runnerOutput(), evidence = true, session = true, lane } = {}) =>
    [
      `B="$LOG_DIR/${RUN_REL}"`,
      'mkdir -p "$B"',
      evidence ? 'mkdir -p "$B/evidence" && printf x > "$B/evidence/shot-1.png"' : ":",
      session ? `printf '%s\\n' ${SESSION} > "$B/session-id"` : ":",
      `printf '%s\\n' '${output}' > "$B/runner-output.txt"`,
      set("verifyBrowser", `$HEAD:${lane}`),
      set("verifyBrowserRunDir", "$B"),
    ].join("\n");
  const promote = (lane) =>
    `verify_promote ITEM 7 70 "$HEAD" lanes-done '{"shell":"skipped:not-built","browser":"${lane}"}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
  const scenario = [
    "## Test scenario",
    "### Web",
    "1. Open /notebooks — expected: the list.",
    `<!-- drafto-factory-scenario-sha:${HEAD} -->`,
  ].join("\n");
  const comments = [{ id: 5, body: scenario, createdAt: "t", authorAssociation: "OWNER" }];

  // Seed the lane, promote, and hand the result to <fn>.
  function promoted({ lane = "reported:pass", env = {}, state = {}, ...seedOpts }, fn) {
    withBash(
      `${seed({ lane, ...seedOpts })}\n${promote(lane)}`,
      { env: { HEAD, TRACE_REPORT: "1", ...env }, state, comments },
      fn,
    );
  }
  const runDir = (r) => join(r.dir, RUN_REL);
  const callLines = (r) => r.calls.split("\n").filter(Boolean);
  const uploadsOf = (r) => {
    const f = join(r.dir, "calls.log.uploads");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const args = JSON.parse(l);
        assert.equal(args[0], "upload");
        const flags = {};
        for (let i = 1; i < args.length; i += 2) flags[args[i]] = args[i + 1];
        return flags;
      });
  };
  const reports = (r) =>
    r.comments.filter((c) => c.body.includes("<!-- drafto-factory-verify-report -->"));
  const webDetails = (body) => {
    const start = body.indexOf("<summary>Web (browser): full report</summary>");
    assert.ok(start !== -1, "the Web lane's details");
    return body.slice(start, body.indexOf("</details>", start));
  };

  it("publishes them after the dry render, then composes again with them in the Web lane's details", () => {
    promoted({ env: { UPLOAD_STUB: PUBLISHED }, state: { attempts: 3 } }, (r) => {
      const lines = callLines(r);
      const at = (pred) => lines.findIndex(pred);
      const dry = at((l) => l === "report dry");
      const up = at((l) => l.startsWith("upload "));
      const again = at((l) => l.startsWith("report images "));
      const move = at((l) => l === "transition In Test");
      const post = at((l) => l.startsWith("gh issue comment 7"));
      assert.ok(dry !== -1 && dry < up && up < again && again < move && move < post, r.calls);
      assert.equal(lines[again], `report images ${runDir(r)}/upload.json`);
      assert.equal(lines.filter((l) => l === "report dry").length, 1);

      const uploads = uploadsOf(r);
      assert.equal(uploads.length, 1);
      assert.deepEqual(uploads[0], {
        "--issue": "7",
        "--sha": HEAD,
        "--run-id": RUN_ID,
        "--evidence-dir": `${runDir(r)}/evidence`,
        "--source": "browser",
        "--guard-log": `${r.dir}/browser-guard/${SESSION}.jsonl`,
        "--render-json": `${runDir(r)}/verify-render.json`,
        // The account file is always passed, so node fails closed when it is
        // missing; the harness's repo root has no ocr.swift, so --ocr is ""
        // and node refuses for itself.
        "--account-file": `${r.dir}/account.env`,
        "--ocr": "",
        // The composer's other secret files, "" when it had none.
        "--bypass-file": "",
        "--signin-key-file": "",
        "--log-dir": r.dir,
        "--repo-root": r.dir,
        "--out": `${runDir(r)}/upload.json`,
      });
      // The dry render's JSON line is what the upload's scan gate reads.
      const dryJson = JSON.parse(readFileSync(join(runDir(r), "verify-render.json"), "utf8"));
      assert.equal(dryJson.verdict, "pass");
      assert.deepEqual(dryJson.withheld, { shell: false, browser: false });
      assert.deepEqual(dryJson.secretHits, []);
      assert.deepEqual(dryJson.images, { browser: 0 }, "composed without screenshots");

      const posted = reports(r);
      assert.equal(posted.length, 1, "posted once");
      const { body } = posted[0];
      assert.match(
        webDetails(body),
        new RegExp(
          `<img src="${url(1).replace(/[.?/]/g, "\\$&")}" width="480" alt="Screenshot 1">`,
        ),
      );
      assert.match(body, /\*\*Step 1\*\* · PASS · Open \/notebooks/, "under the step that took it");
      assert.match(body, /Web screenshots are published in this report \(ADR-0096\)/);
      assert.doesNotMatch(body, /weren't published/);
      assert.match(body, /\*\*Verdict: PASS\*\*/);
      assert.match(r.log, /composed with the Web lane's screenshots/);
      assert.equal(r.issue.verifyReportSha, HEAD);
      assert.equal(r.issue.attempts, 0, "the promotion's resets are unchanged");
    });
  });

  it("passes the composer's bypass and sign-in key files to the upload, so the images are scanned for them", () => {
    withBash(
      [
        `printf 'VERCEL_AUTOMATION_BYPASS_SECRET=%s\\n' not-a-real-bypass > "$LOG_DIR/no-bypass.env"`,
        `printf 'DEV_SUPABASE_SERVICE_ROLE_KEY=%s\\n' not-a-real-key > "$LOG_DIR/signin.env"`,
        seed({ lane: "reported:pass" }),
        promote("reported:pass"),
      ].join("\n"),
      { env: { HEAD, TRACE_REPORT: "1", UPLOAD_STUB: PUBLISHED }, comments },
      (r) => {
        const uploads = uploadsOf(r);
        assert.equal(uploads.length, 1, r.calls);
        assert.equal(uploads[0]["--bypass-file"], join(r.dir, "no-bypass.env"));
        assert.equal(uploads[0]["--signin-key-file"], join(r.dir, "signin.env"));
        assert.equal(reports(r).length, 1, "posted once");
      },
    );
  });

  it("keeps a withheld lane's screenshots on the Mac mini: never uploaded", () => {
    // The lane's own output trips the scan; and a clean lane in a body that
    // trips the final check (here the CodeRabbit note) is withheld as well.
    for (const opts of [
      { output: runnerOutput(`token ${JWT} (screenshot 1)`) },
      { state: { verifyCrNote: `${HEAD}:see ${JWT}` } },
    ]) {
      promoted({ env: { UPLOAD_STUB: PUBLISHED }, ...opts }, (r) => {
        const what = JSON.stringify(opts).slice(0, 40);
        assert.doesNotMatch(r.calls, /^upload |^report images /m, what);
        assert.match(r.log, /withheld the Web lane's text \(or its body\)/, what);
        const posted = reports(r);
        assert.equal(posted.length, 1, what);
        assert.doesNotMatch(posted[0].body, /<img /, what);
        assert.match(posted[0].body, /withheld/i, what);
        assert.match(r.calls, /^transition In Test$/m, what);
      });
    }
  });

  it("publishes nothing for a browser lane that didn't report", () => {
    for (const lane of ["timeout", "unavailable:chrome", "no-preview"]) {
      promoted({ lane, env: { UPLOAD_STUB: PUBLISHED } }, (r) => {
        assert.doesNotMatch(r.calls, /^upload |^report images /m, lane);
        assert.equal(reports(r).length, 1, lane);
        assert.doesNotMatch(reports(r)[0].body, /<img /, lane);
      });
    }
  });

  it("publishes nothing when the run kept no evidence dir", () => {
    promoted({ evidence: false, env: { UPLOAD_STUB: PUBLISHED } }, (r) => {
      assert.doesNotMatch(r.calls, /^upload /m);
      assert.doesNotMatch(reports(r)[0].body, /<img /);
    });
  });

  it("hands node an empty guard log when the run left no session id", () => {
    promoted({ session: false, env: { UPLOAD_STUB: PUBLISHED } }, (r) => {
      assert.equal(uploadsOf(r)[0]["--guard-log"], "");
    });
  });

  for (const [what, env] of [
    ["fails", { UPLOAD_FAIL: "1", UPLOAD_STUB: PUBLISHED }],
    ["leaves no record", {}],
  ]) {
    it(`posts the dry render, promotion unchanged, when the upload ${what}`, () => {
      promoted({ env, state: { attempts: 3 } }, (r) => {
        assert.match(r.calls, /^upload /m);
        assert.doesNotMatch(r.calls, /^report images /m, "nothing to compose with");
        assert.match(r.log, /publishing #7's screenshots of a{12} failed/);
        assert.match(r.calls, /^transition In Test$/m, "the card still moves");
        const posted = reports(r);
        assert.equal(posted.length, 1, "posted once");
        assert.doesNotMatch(posted[0].body, /<img /);
        assert.match(
          posted[0].body,
          new RegExp(
            `Local evidence stays on the Mac mini \\(the repo is public\\): Web \`[^\`]*${RUN_REL}\``,
          ),
        );
        assert.doesNotMatch(posted[0].body, /weren't published/, "no record, no reason");
        assert.match(posted[0].body, /\*\*Verdict: PASS\*\*/);
        assert.equal(r.issue.verifyReportSha, HEAD);
        assert.equal(r.issue.attempts, 0);
      });
    });
  }

  it("says why in the report when node refused to publish", () => {
    const refusal = JSON.stringify({ ok: false, reason: "selftest-missing" });
    promoted({ env: { UPLOAD_STUB: refusal } }, (r) => {
      assert.match(r.calls, /^report images /m, "a record: composed again, with the reason");
      const { body } = reports(r)[0];
      assert.doesNotMatch(body, /<img /);
      assert.match(
        body,
        /Web screenshots weren't published: the publishing self-test hasn't passed on this Mac mini yet/,
      );
    });
  });

  it("posts the dry render when composing with the screenshots fails", () => {
    promoted({ env: { UPLOAD_STUB: PUBLISHED, REPORT_IMAGES_FAIL: "1" } }, (r) => {
      assert.match(r.calls, /^report images /m);
      assert.match(
        r.log,
        /composing #7's verification report with the Web lane's screenshots failed/,
      );
      const posted = reports(r);
      assert.equal(posted.length, 1);
      assert.doesNotMatch(posted[0].body, /<img /);
      assert.match(posted[0].body, /\*\*Verdict: PASS\*\*/);
      assert.ok(!existsSync(join(r.dir, "verify", `report-7-${HEAD}.md.images`)), "no temp left");
    });
  });

  it("asks for the same run's upload again when the promotion is retried, so node reuses it", () => {
    // The ref and upload.json are keyed by issue + head + run: a promotion
    // that couldn't move the card composes again next tick with the same
    // --run-id and --out, and evidence-upload.mjs reuses the record.
    const body = [
      seed({ lane: "reported:pass" }),
      'FAIL_TRANSITION="In Test"',
      `${promote("reported:pass")} || true`,
      'FAIL_TRANSITION=""',
      promote("reported:pass"),
    ].join("\n");
    withBash(body, { env: { HEAD, UPLOAD_STUB: PUBLISHED }, comments }, (r) => {
      const uploads = uploadsOf(r);
      assert.equal(uploads.length, 2);
      assert.equal(uploads[1]["--run-id"], uploads[0]["--run-id"]);
      assert.equal(uploads[1]["--out"], uploads[0]["--out"]);
      assert.equal(reports(r).length, 1, "one report, after the move");
      assert.match(webDetails(reports(r)[0].body), /<img src=/);
    });
  });

  it("composes first and publishes after, from verify_compose_report only", () => {
    const compose = extract("verify_compose_report");
    const dry = compose.indexOf('verify-report.mjs" "${render_args[@]}" --out "$body_file"');
    const publish = compose.indexOf('verify_publish_screenshots "$issue_num" "$head_sha"');
    assert.ok(dry !== -1 && publish > dry);
    assert.doesNotMatch(compose.slice(0, dry), /--browser-images/, "the first render has none");
    const fn = extract("verify_publish_screenshots");
    assert.match(
      fn,
      /\[\[ "\$st" == reported\* && -n "\$browser_dir" && -d "\$browser_dir\/evidence" \]\] \|\| return 0/,
    );
    assert.match(fn, /--browser-images "\$browser_dir\/upload\.json"/);
    // The only verify_* function that publishes anything.
    for (const name of verifyFns.filter((n) => n !== "verify_publish_screenshots")) {
      assert.doesNotMatch(extract(name), /evidence_upload|evidence-upload\.mjs/, name);
    }
  });
});

// ── The device lane (ADR-0106): verify_device_* and device_post_followup ───
// device-lane.mjs is stubbed (argv recorded, canned JSON line); state-cli,
// verify-decide and verify-report are the real modules. The lane is off
// unless `device` is in FACTORY_VERIFY_LANES AND FACTORY_VERIFY_DEVICE=1.

const DEVICE_RUN_ID = `7-${HEAD.slice(0, 12)}-20261110T051950Z`;
const DEVICE_ON = {
  FACTORY_VERIFY_LANES: "shell,browser,device",
  FACTORY_VERIFY_DEVICE: "1",
  VERIFY_BUILT_LANES_STUB: "shell,browser,device",
};

// A device-output.json: one iOS platform, finished (PASS) or still running.
function deviceOutput({ sha = HEAD, running = false } = {}) {
  return {
    version: 1,
    runId: DEVICE_RUN_ID,
    issue: "7",
    pr: "70",
    sha,
    mode: "smoke",
    trigger: "testing",
    startedAt: "2026-11-10T05:19:50Z",
    finishedAt: running ? null : "2026-11-10T06:00:00Z",
    platforms: {
      ios: running
        ? { state: "running", verdict: null, build: null, flows: [] }
        : {
            state: "done",
            verdict: "PASS",
            build: { cached: true, durationS: 300 },
            flows: [{ name: "ios-all.yaml", status: "PASS", durationS: 90, failure: null }],
          },
    },
  };
}

// Bash that writes the run dir (and the ledger, when <ledgerState> is given)
// under $REPO_ROOT, as device-lane.mjs lays them out.
function seedDeviceRun({
  output = deviceOutput(),
  ledgerState = null,
  evidence = false,
  finishedAt = "2026-11-10T06:00:00Z",
} = {}) {
  const runDir = `$REPO_ROOT/logs/factory/device/runs/${DEVICE_RUN_ID}`;
  const lines = [
    `RUN_DIR="${runDir}"`,
    `mkdir -p "$RUN_DIR"${evidence ? ' "$RUN_DIR/evidence"' : ""}`,
    `printf '%s' '${JSON.stringify(output)}' > "$RUN_DIR/device-output.json"`,
  ];
  if (ledgerState) {
    lines.push(
      `jq -nc --arg d "$RUN_DIR" --arg s "${ledgerState}" '{version: 1, inFlight: null, attempts: {}, last: {"7": {sha: "${output.sha}", runId: "${DEVICE_RUN_ID}", runDir: $d, state: $s, finishedAt: "${finishedAt}"}}}' > "$REPO_ROOT/logs/factory/device/ledger.json"`,
    );
  }
  return lines.join("\n");
}

describe("the device lane: settings and the off path", () => {
  const block = script.match(
    /FACTORY_VERIFY="\$\{FACTORY_VERIFY:-0\}"[\s\S]*?VERIFY_REPORT_RETRY_STEP_MIN=10\n/,
  );
  function parse(env) {
    const r = spawnSync(
      "/bin/bash",
      [
        "-c",
        `set -euo pipefail\n${block[0]}\necho "LANES=$FACTORY_VERIFY_LANES DEVICE=$FACTORY_VERIFY_DEVICE WAIT=$FACTORY_VERIFY_DEVICE_WAIT_MIN ACCOUNT=$FACTORY_DEVICE_ACCOUNT_FILE"`,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/home/op", ...env } },
    );
    assert.equal(r.status, 0, r.stderr);
    return { out: r.stdout.trim(), stderr: r.stderr };
  }

  it("is off by default, and not in the default lane list", () => {
    assert.match(script, /^FACTORY_VERIFY_DEVICE="\$\{FACTORY_VERIFY_DEVICE:-0\}"$/m);
    assert.match(
      script,
      /^FACTORY_VERIFY_DEVICE_WAIT_MIN="\$\{FACTORY_VERIFY_DEVICE_WAIT_MIN:-30\}"$/m,
    );
    const { out, stderr } = parse({});
    assert.equal(stderr, "");
    assert.equal(out, "LANES=shell,browser DEVICE=0 WAIT=30 ACCOUNT=");
  });

  it("accepts device in the lane list and validates its knobs", () => {
    assert.equal(
      parse({ FACTORY_VERIFY_LANES: "shell,device,device", FACTORY_VERIFY_DEVICE: "1" }).out,
      "LANES=shell,device DEVICE=1 WAIT=30 ACCOUNT=",
    );
    const bad = parse({ FACTORY_VERIFY_DEVICE: "yes", FACTORY_VERIFY_DEVICE_WAIT_MIN: "08" });
    assert.equal(bad.out, "LANES=shell,browser DEVICE=0 WAIT=30 ACCOUNT=");
    assert.match(bad.stderr, /invalid FACTORY_VERIFY_DEVICE='yes'/);
    assert.match(bad.stderr, /invalid FACTORY_VERIFY_DEVICE_WAIT_MIN='08'/);
    assert.equal(
      parse({ FACTORY_DEVICE_ACCOUNT_FILE: "~/drafto-secrets/device.env" }).out,
      "LANES=shell,browser DEVICE=0 WAIT=30 ACCOUNT=/home/op/drafto-secrets/device.env",
    );
  });

  it("reads lane-off unless it is listed and switched on", () => {
    const states = `verify_lane_states "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$HEAD" 1`;
    const built = { VERIFY_BUILT_LANES_STUB: "shell,browser,device" };
    for (const env of [
      { FACTORY_VERIFY_LANES: "shell,browser,device" }, // listed, switch off
      { FACTORY_VERIFY_DEVICE: "1" }, // switch on, not listed
    ]) {
      withBash(states, { env: { HEAD, ...built, ...env } }, (r) => {
        assert.equal(JSON.parse(r.stdout).device, "skipped:lane-off", JSON.stringify(env));
      });
    }
    withBash(states, { env: { HEAD, ...DEVICE_ON } }, (r) => {
      assert.equal(JSON.parse(r.stdout).device, "none");
    });
    const state = { verifyDevice: `${HEAD}:running` };
    withBash(states, { env: { HEAD, ...DEVICE_ON }, state }, (r) => {
      assert.equal(JSON.parse(r.stdout).device, "running");
    });
  });

  it("does nothing at all while switched off and never run (no ledger)", () => {
    const body = [
      `verify_device_work 7 70 "$HEAD" '{"mobile":true}' '{"device":"none"}'`,
      `verify_device_stop 7 "$HEAD" threads`,
      "verify_device_housekeeping",
    ].join("\n");
    withBash(body, { env: { HEAD, VERIFY_BUILT_LANES_STUB: "shell,browser,device" } }, (r) => {
      assert.doesNotMatch(r.calls, /^device /m);
      assert.equal(r.issue.verifyDevice ?? null, null);
    });
  });

  it("is wired into both lane seams, --watch housekeeping and the facts", () => {
    assert.match(extract("verify_work_lanes"), /^\s+verify_device_work "\$@" \|\| true$/m);
    assert.match(extract("verify_stop_lanes"), /^\s+verify_device_stop "\$@" \|\| true$/m);
    const hk = script.indexOf("\n  verify_device_housekeeping\n", watchStart);
    const shellHk = script.indexOf("\n  verify_shell_housekeeping\n", watchStart);
    const sweep = script.indexOf("\n  verify_sweep\n", watchStart);
    assert.ok(shellHk !== -1 && hk > shellHk && hk < sweep);
    assert.match(
      extract("verify_sweep_card"),
      /--argjson deviceWaitMin "\$\{FACTORY_VERIFY_DEVICE_WAIT_MIN:-30\}"/,
    );
    // Nothing on the device lane's path moves a card.
    for (const name of [
      "verify_device_work",
      "verify_device_stop",
      "verify_device_housekeeping",
      "verify_device_collect",
      "device_post_followup",
    ]) {
      assert.doesNotMatch(extract(name), /transition_status|set-status/, name);
    }
  });
});

describe("verify_device_work", () => {
  const work = (platforms, device = "none") =>
    `verify_device_work 7 70 "$HEAD" '${platforms}' '{"shell":"none","browser":"none","device":"${device}"}'`;
  const MOBILE = '{"web":false,"mobile":true,"desktop":false}';
  const WEB = '{"web":true,"mobile":false,"desktop":false}';

  it("ends a PR that doesn't touch the mobile app as not-applicable, without a lookup", () => {
    withBash(work(WEB), { env: { HEAD, ...DEVICE_ON } }, (r) => {
      assert.doesNotMatch(r.calls, /^device /m);
      assert.equal(r.issue.verifyDevice, `${HEAD}:skipped:not-applicable`);
      assert.equal(isTerminalLaneState("skipped:not-applicable"), true);
    });
  });

  it("waits, starting nothing, while the platforms are unknown, and records it", () => {
    withBash(
      `${work("{}")}\n${work("{}", "deferred:platforms-unknown")}`,
      { env: { HEAD, ...DEVICE_ON } },
      (r) => {
        assert.doesNotMatch(r.calls, /^device /m);
        assert.equal(r.issue.verifyDevice, `${HEAD}:deferred:platforms-unknown`);
        assert.equal(
          r.log.match(/platforms are unknown this tick; the device lane waits/g)?.length,
          1,
        );
      },
    );
  });

  it("starts a testing run on the PR head and records it as running, with its run dir", () => {
    const started = JSON.stringify({
      started: true,
      runId: DEVICE_RUN_ID,
      runDir: "/runs/x",
      platforms: { ios: {} },
    });
    withBash(work(MOBILE), { env: { HEAD, ...DEVICE_ON, DEVICE_START_STUB: started } }, (r) => {
      assert.match(
        r.calls,
        new RegExp(
          `^device start --issue 7 --pr 70 --sha ${HEAD} --trigger testing --repo-root `,
          "m",
        ),
      );
      assert.equal(r.issue.verifyDevice, `${HEAD}:running`);
      assert.equal(r.issue.verifyDeviceRunDir, "/runs/x");
    });
  });

  it("leaves a running run alone, and a terminal lane too", () => {
    for (const st of ["running", "reported:pass", "skipped:attempts", "unavailable:no-account"]) {
      withBash(work(MOBILE, st), { env: { HEAD, ...DEVICE_ON } }, (r) => {
        assert.doesNotMatch(r.calls, /^device /m, st);
      });
    }
  });

  it("records a deferral and tries again next tick, logging once per change", () => {
    const deferred = '{"started":false,"reason":"deferred:beta-build"}';
    const body = [work(MOBILE), work(MOBILE, "deferred:beta-build")].join("\n");
    withBash(body, { env: { HEAD, ...DEVICE_ON, DEVICE_START_STUB: deferred } }, (r) => {
      assert.equal(r.calls.match(/^device start /gm)?.length, 2, "tried again");
      assert.equal(r.issue.verifyDevice, `${HEAD}:deferred:beta-build`);
      assert.equal(r.log.match(/device lane not started/g)?.length, 1);
    });
  });

  it("keeps an earlier attempt's retry:<why> over a deferral", () => {
    const deferred = '{"started":false,"reason":"deferred:memory"}';
    const state = { verifyDevice: `${HEAD}:retry:lost` };
    withBash(
      work(MOBILE, "retry:lost"),
      { env: { HEAD, ...DEVICE_ON, DEVICE_START_STUB: deferred }, state },
      (r) => {
        assert.match(r.calls, /^device start /m);
        assert.equal(r.issue.verifyDevice, `${HEAD}:retry:lost`);
      },
    );
  });

  it("ends the lane on refusals waiting can't fix, and retries the rest silently", () => {
    for (const [reason, want] of [
      ["attempts", "skipped:attempts"],
      ["not-applicable", "skipped:not-applicable"],
      ["account", "unavailable:no-account"],
      ["maestro-missing", "unavailable:maestro-missing"],
      // A stop arrived while start attached its supervisor: a deferral.
      ["stopped", "deferred:stopping"],
      // Anything else is retried, and recorded so the In Test pass picks it up.
      ["head-moved", "deferred:head-moved"],
      ["pr-unreadable", "deferred:pr-unreadable"],
      ["Weird Reason!", "deferred:start-error"],
    ]) {
      const stub = JSON.stringify({ started: false, reason });
      withBash(work(MOBILE), { env: { HEAD, ...DEVICE_ON, DEVICE_START_STUB: stub } }, (r) => {
        assert.equal(r.issue.verifyDevice ?? null, want ? `${HEAD}:${want}` : null, reason);
      });
    }
    // A start that exits non-zero.
    withBash(work(MOBILE), { env: { HEAD, ...DEVICE_ON, DEVICE_FAIL: "1" } }, (r) => {
      assert.equal(r.issue.verifyDevice, `${HEAD}:deferred:start-error`);
    });
  });
});

describe("verify_device_work: the scenario's mobile sections (--scenario-file)", () => {
  const SCENARIO_ON = { ...DEVICE_ON, FACTORY_DEVICE_SCENARIO: "1" };
  const work = `verify_device_work 7 70 "$HEAD" '{"web":false,"mobile":true,"desktop":false}' '{"device":"none"}'`;
  const scenario = (sha, sections) => [
    {
      id: 5,
      authorAssociation: "OWNER",
      createdAt: "t",
      body: [
        "## Test scenario",
        ...sections,
        "<!-- drafto-factory-test-scenario -->",
        `<!-- drafto-factory-scenario-sha:${sha} -->`,
      ].join("\n"),
    },
  ];

  it("passes the scenario's mobile sections in a mode-600 file, removed after start", () => {
    const comments = scenario(HEAD, ["### Web", "1. web", "### iOS", "1. ios step"]);
    withBash(work, { env: { HEAD, ...SCENARIO_ON }, comments }, (r) => {
      const m = /^device start .* --repo-root \S+ --scenario-file (\S+)$/m.exec(r.calls);
      assert.ok(m, r.calls);
      assert.ok(m[1].startsWith(`${r.dir}/logs/factory/device/scenario-7-`), m[1]);
      assert.equal(existsSync(m[1]), false, "removed once start has copied it");
      const [mode, ...json] = readFileSync(`${r.dir}/calls.log.scenario`, "utf8").split("\n");
      assert.equal(mode, "600");
      assert.deepEqual(JSON.parse(json.join("\n")), [{ heading: "iOS", text: "1. ios step" }]);
    });
  });

  it("passes no file without mobile sections, for another commit, or when comments fail", () => {
    for (const [comments, env] of [
      [scenario(HEAD, ["### Web", "1. web"]), {}],
      [scenario("b".repeat(40), ["### iOS", "1. ios"]), {}],
      [scenario(HEAD, ["### iOS", "1. ios"]), { COMMENTS_FAIL: "1" }],
    ]) {
      withBash(work, { env: { HEAD, ...SCENARIO_ON, ...env }, comments }, (r) => {
        assert.match(r.calls, /^device start /m);
        assert.doesNotMatch(r.calls, /--scenario-file/);
        assert.deepEqual(
          readdirSync(`${r.dir}/logs/factory/device`).filter((f) => f.startsWith("scenario-")),
          [],
        );
      });
    }
  });

  it("with FACTORY_DEVICE_SCENARIO off, fetches nothing and passes no file", () => {
    const comments = scenario(HEAD, ["### iOS", "1. ios step"]);
    // A counting fetch: the knob must stop it before any GitHub read.
    const body = [`fetch_issue_comments() { call "fetch $1"; cat "$COMMENTS_FILE"; }`, work].join(
      "\n",
    );
    for (const knob of [undefined, "0", "yes"]) {
      const env = {
        HEAD,
        ...DEVICE_ON,
        ...(knob === undefined ? {} : { FACTORY_DEVICE_SCENARIO: knob }),
      };
      withBash(body, { env, comments }, (r) => {
        assert.match(r.calls, /^device start /m);
        assert.doesNotMatch(r.calls, /--scenario-file|^fetch /m, String(knob));
      });
    }
    withBash(body, { env: { HEAD, ...SCENARIO_ON }, comments }, (r) => {
      assert.match(r.calls, /^fetch 7$/m);
      assert.match(r.calls, /--scenario-file /);
    });
  });

  it("the on-demand start passes it too", () => {
    const fn = extract("verify_device_ondemand_work");
    assert.match(fn, /scenario_file=\$\(verify_device_scenario_file "\$issue_num" "\$head_sha"\)/);
    assert.match(
      fn,
      /--force-attempt --repo-root "\$REPO_ROOT" \\\n\s+\$\{scenario_args\[@\]\+"\$\{scenario_args\[@\]\}"\}/,
    );
  });
});

describe("verify_device_stop: only for reasons that leave the run without a reader", () => {
  const ledger =
    'mkdir -p "$REPO_ROOT/logs/factory/device" && echo "{}" > "$REPO_ROOT/logs/factory/device/ledger.json"';
  const stopped = '{"state":"stopped","runId":"r"}';

  it("stops the run on a hand-back, feedback or verification off", () => {
    for (const reason of [
      "head-moved",
      "ci-red",
      "not-reviewed",
      "threads",
      "feedback",
      "verification-off",
    ]) {
      withBash(
        `${ledger}\nverify_stop_lanes 7 "$HEAD" ${reason}`,
        { env: { HEAD, DEVICE_STOP_STUB: stopped } },
        (r) => {
          assert.match(r.calls, new RegExp(`^device stop --issue 7 --reason ${reason} `, "m"));
          assert.match(r.log, new RegExp(`device lane stopped \\(${reason}\\)`));
        },
      );
    }
  });

  it("logs a stop still in progress (a supervisor shutting its devices down)", () => {
    withBash(
      `${ledger}\nverify_stop_lanes 7 "$HEAD" feedback`,
      { env: { HEAD, DEVICE_STOP_STUB: '{"state":"stopping","runId":"r"}' } },
      (r) => {
        assert.match(r.calls, /^device stop --issue 7 --reason feedback /m);
        assert.match(r.log, /device lane stopping \(feedback\); housekeeping finalises it/);
        assert.doesNotMatch(r.log, /WARNING/);
      },
    );
  });

  it("lets it run on into In Test at the hold cap or with the other lanes done", () => {
    for (const reason of ["hold-cap", "lanes-done", "decide-error"]) {
      withBash(`${ledger}\nverify_stop_lanes 7 "$HEAD" ${reason}`, { env: { HEAD } }, (r) => {
        assert.doesNotMatch(r.calls, /^device /m, reason);
      });
    }
  });

  it("hands back with a stop, promotes at the hold cap without one (real sweep)", () => {
    const red = prView({ statusCheckRollup: [{ name: "Lint", conclusion: "FAILURE" }] });
    const state = {
      verifySha: HEAD,
      verifyStartedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      lastReviewSha: HEAD,
      lastFeedbackAt: "2026-01-01T00:00:00Z",
      intestCommentSha: HEAD,
      verifyDevice: `${HEAD}:running`,
    };
    const env = {
      HEAD,
      LABELS: "status:testing",
      PR_OBJ_STUB: PR_OBJ,
      ...DEVICE_ON,
      DEVICE_STOP_STUB: stopped,
    };
    const card = `${ledger}\nverify_sweep_card ITEM 7 "$LABELS"`;
    withBash(card, { env: { ...env, PR_VIEW_STUB: red }, state }, (r) => {
      assert.match(r.calls, /^transition In Review$/m);
      assert.match(r.calls, /^device stop --issue 7 --reason ci-red /m);
    });
    const capped = { ...state, verifyStartedAt: "2026-01-01T00:00:00Z" };
    withBash(card, { env: { ...env, PR_VIEW_STUB: prView() }, state: capped }, (r) => {
      assert.match(r.log, /Testing → promote \(hold-cap\)/);
      assert.match(r.calls, /^transition In Test$/m);
      assert.doesNotMatch(r.calls, /^device stop /m);
    });
  });
});

describe("the device lane at promotion: running — results follow", () => {
  const state = (over = {}) => ({
    verifySha: HEAD,
    lastReviewSha: HEAD,
    lastFeedbackAt: "2026-01-01T00:00:00Z",
    intestCommentSha: HEAD,
    verifyShell: `${HEAD}:skipped:lane-off`,
    verifyBrowser: `${HEAD}:skipped:not-web`,
    verifyDevice: `${HEAD}:running`,
    ...over,
  });
  const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const card = [
    seedDeviceRun({ output: deviceOutput({ running: true }) }),
    `node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field 7 verifyDeviceRunDir "$RUN_DIR" --state-file "$STATE_FILE" >/dev/null`,
    'verify_sweep_card ITEM 7 "$LABELS"',
  ].join("\n");
  const env = (over = {}) => ({
    HEAD,
    LABELS: "status:testing",
    PR_OBJ_STUB: PR_OBJ,
    PR_VIEW_STUB: prView(),
    DIFF_STUB: "apps/mobile/e2e/ios-all.yaml",
    ...DEVICE_ON,
    FACTORY_VERIFY_LANES: "browser,device",
    FACTORY_DEVICE_ACCOUNT_FILE: "",
    TRACE_REPORT: "1",
    ...over,
  });

  it("holds the card while the run is inside FACTORY_VERIFY_DEVICE_WAIT_MIN", () => {
    withBash(card, { env: env(), state: state({ verifyStartedAt: minsAgo(10) }) }, (r) => {
      assert.match(r.log, /Testing → work-lanes \(lanes-pending\)/);
      assert.doesNotMatch(r.calls, /^transition/m);
      assert.doesNotMatch(r.calls, /^device start /m, "a running run isn't started again");
    });
  });

  it("then promotes with the device rows reading running, no images, the run left going", () => {
    withBash(card, { env: env(), state: state({ verifyStartedAt: minsAgo(31) }) }, (r) => {
      assert.match(r.log, /Testing → promote \(lanes-done\)/);
      assert.match(r.calls, /^transition In Test$/m);
      assert.doesNotMatch(r.calls, /^device stop /m);
      assert.doesNotMatch(r.calls, /^report device-images|^upload /m);
      const report = r.comments.at(-1).body;
      assert.match(report, /running — results follow in a separate comment/);
      assert.doesNotMatch(report, /<img /);
    });
  });

  it("honours a shorter FACTORY_VERIFY_DEVICE_WAIT_MIN", () => {
    withBash(
      card,
      {
        env: env({ FACTORY_VERIFY_DEVICE_WAIT_MIN: "5" }),
        state: state({ verifyStartedAt: minsAgo(10) }),
      },
      (r) => {
        assert.match(r.log, /Testing → promote \(lanes-done\)/);
      },
    );
  });
});

describe("verify_device_housekeeping and the follow-up comment", () => {
  const RUN_DIR_RE = new RegExp(`logs/factory/device/runs/${DEVICE_RUN_ID}$`);
  const env = (over = {}) => ({
    HEAD,
    ...DEVICE_ON,
    PR_VIEW_STUB: prView(),
    FACTORY_DEVICE_ACCOUNT_FILE: "",
    TRACE_REPORT: "1",
    ...over,
  });
  const followups = (r) => r.comments.filter((c) => /drafto-factory-device-report/.test(c.body));

  it("collects the run, records the round's outcome and posts the follow-up once", () => {
    const body = [
      seedDeviceRun({ ledgerState: "done:PASS" }),
      `node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field 7 verifyDeviceRunDir "$RUN_DIR" --state-file "$STATE_FILE" >/dev/null`,
      "verify_device_housekeeping",
      "verify_device_housekeeping",
      'rm -f "$RUN_DIR/followup.done"',
      "verify_device_housekeeping",
    ].join("\n");
    const state = { verifyDevice: `${HEAD}:running` };
    withBash(body, { env: env(), state }, (r) => {
      assert.match(r.calls, /^device housekeeping --repo-root /m);
      assert.equal(r.issue.verifyDevice, `${HEAD}:reported:pass`);
      assert.match(r.issue.verifyDeviceRunDir, RUN_DIR_RE);
      assert.equal(r.issue.deviceReportPosted, `${HEAD}:${DEVICE_RUN_ID}`);
      const posted = followups(r);
      assert.equal(posted.length, 1, "posted once");
      assert.match(
        posted[0].body,
        new RegExp(`drafto-factory-device-sha:${HEAD}:${DEVICE_RUN_ID}`),
      );
      assert.equal(r.calls.match(/^gh issue comment /gm)?.length, 1);
      assert.doesNotMatch(r.calls, /^transition/m, "never moves the card");
    });
  });

  it("publishes the run's screenshots for the follow-up only, as the device source", () => {
    const commit = "c".repeat(40);
    const url = `https://raw.githubusercontent.com/JakubAnderwald/drafto/${commit}/7/${HEAD.slice(0, 12)}/device-${DEVICE_RUN_ID}/01.png`;
    const published = JSON.stringify({
      ok: true,
      issue: "7",
      sha: HEAD,
      runId: `device-${DEVICE_RUN_ID}`,
      ref: `refs/factory-evidence/7/${HEAD.slice(0, 12)}/device-${DEVICE_RUN_ID}`,
      commit,
      images: [{ n: 1, url, local: "/x/01.png", label: "ios: ios-all.yaml" }],
      overflow: [],
    });
    const body = [
      seedDeviceRun({ ledgerState: "done:PASS", evidence: true }),
      "verify_device_housekeeping",
    ].join("\n");
    withBash(body, { env: env({ UPLOAD_STUB: published }) }, (r) => {
      const uploads = r.calls.split("\n").filter((l) => l.startsWith("upload "));
      assert.equal(uploads.length, 1);
      assert.match(uploads[0], /--source device /);
      assert.match(uploads[0], new RegExp(`--run-id device-${DEVICE_RUN_ID} `));
      assert.match(r.calls, /^report device-images .*upload\.json$/m);
      const posted = followups(r);
      assert.equal(posted.length, 1);
      assert.ok(posted[0].body.includes(`<img src="${url}"`), posted[0].body);
    });
  });

  it("skips a run whose commit is no longer the PR head, recording it as stale", () => {
    const body = [seedDeviceRun({ ledgerState: "done:FAIL" }), "verify_device_housekeeping"].join(
      "\n",
    );
    for (const view of [prView({ headRefOid: OLD }), prView({ state: "MERGED" })]) {
      withBash(body, { env: env({ PR_VIEW_STUB: view }) }, (r) => {
        assert.equal(followups(r).length, 0);
        assert.doesNotMatch(r.calls, /^upload /m);
        assert.equal(r.issue.deviceReportPosted, `${HEAD}:${DEVICE_RUN_ID}:stale`);
        assert.match(r.log, /no longer PR #70's open head; its results aren't posted \(stale\)/);
      });
    }
  });

  it("doesn't post one already on the issue under the factory's identity", () => {
    const comments = [
      {
        id: 4,
        body: `x <!-- drafto-factory-device-sha:${HEAD}:${DEVICE_RUN_ID} -->`,
        createdAt: "t",
        authorAssociation: "OWNER",
      },
    ];
    const body = [seedDeviceRun({ ledgerState: "done:PASS" }), "verify_device_housekeeping"].join(
      "\n",
    );
    withBash(body, { env: env(), comments }, (r) => {
      assert.doesNotMatch(r.calls, /^gh issue comment /m);
      assert.equal(r.issue.deviceReportPosted, `${HEAD}:${DEVICE_RUN_ID}`);
    });
  });

  it("posts nothing for a stopped run, and retries a failed post next tick", () => {
    const stopped = [
      seedDeviceRun({ ledgerState: "stopped:threads" }),
      "verify_device_housekeeping",
    ].join("\n");
    const state = { verifyDevice: `${HEAD}:running` };
    withBash(stopped, { env: env(), state }, (r) => {
      assert.equal(followups(r).length, 0);
      assert.equal(r.issue.deviceReportPosted ?? null, null);
      assert.equal(r.issue.verifyDevice, `${HEAD}:running`, "not the round's run dir");
    });
    const failing = [
      seedDeviceRun({ ledgerState: "done:PASS" }),
      "verify_device_housekeeping",
      'test -e "$RUN_DIR/followup.done" && echo DONE || echo PENDING',
    ].join("\n");
    withBash(failing, { env: env({ FAIL_COMMENT: "1" }) }, (r) => {
      assert.equal(r.stdout.trim(), "PENDING");
      assert.equal(r.issue.deviceReportPosted ?? null, null);
      assert.match(
        r.log,
        /posting the device lane's follow-up on #7 failed; trying again next tick/,
      );
    });
  });

  it("maps a finished run's ledger state to a lane state", () => {
    const cases = [
      ["done:PASS", "reported:pass"],
      ["done:FAIL", "reported:fail"],
      ["timeout", "timeout"],
      ["failed:error", "unavailable:error"],
      ["unavailable:lost", "unavailable:lost"],
      ["stopped:head-moved", "retry:stopped-head-moved"],
      ["stopped:threads", "retry:stopped-threads"],
      ["stopped:feedback", "retry:stopped-feedback"],
      ["stopped:conflict", "retry:stopped-conflict"],
      // An operator's stop sticks.
      ["stopped:stop", "skipped:stopped-stop"],
      ["stopped:signal", "skipped:stopped-signal"],
      ["stopped:left-column", "skipped:stopped-left-column"],
      ["retry:beta-build", "retry:beta-build"],
      ["weird", ""],
    ];
    const body = cases.map(([s]) => `echo "[$(verify_device_outcome_state '${s}')]"`).join("\n");
    withBash(body, {}, (r) => {
      assert.deepEqual(
        r.stdout.trim().split("\n"),
        cases.map(([, want]) => `[${want}]`),
      );
    });
  });
});

describe("the device lane: review round (hand-back retry, In Test continuation, report)", () => {
  const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const round = (over = {}) => ({
    verifySha: HEAD,
    verifyStartedAt: minsAgo(31),
    lastReviewSha: HEAD,
    lastFeedbackAt: "2026-01-01T00:00:00Z",
    intestCommentSha: HEAD,
    verifyShell: `${HEAD}:skipped:lane-off`,
    verifyBrowser: `${HEAD}:skipped:not-web`,
    ...over,
  });
  const env = (over = {}) => ({
    HEAD,
    LABELS: "status:testing",
    PR_OBJ_STUB: PR_OBJ,
    PR_VIEW_STUB: prView(),
    DIFF_STUB: "apps/mobile/e2e/ios-all.yaml",
    ...DEVICE_ON,
    FACTORY_VERIFY_LANES: "browser,device",
    FACTORY_DEVICE_ACCOUNT_FILE: "",
    TESTING_ITEMS: JSON.stringify([{ itemId: "ITEM", issueNumber: 7, labels: ["status:in-test"] }]),
    ...over,
  });
  const setRunDir = `node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field 7 verifyDeviceRunDir "$RUN_DIR" --state-file "$STATE_FILE" >/dev/null`;
  const startedStub = `DEVICE_START_STUB="{\\"started\\":true,\\"runId\\":\\"${DEVICE_RUN_ID}\\",\\"runDir\\":\\"$RUN_DIR\\"}"`;
  const followups = (r) => r.comments.filter((c) => /drafto-factory-device-report/.test(c.body));
  const reports = (r) => r.comments.filter((c) => /drafto-factory-verify-report/.test(c.body));

  it("a hand-back stop is retried, not terminal, so the lane starts again on the same commit", () => {
    const body = [
      seedDeviceRun({ ledgerState: "stopped:threads" }),
      setRunDir,
      "verify_device_housekeeping",
      `verify_device_work 7 70 "$HEAD" '{"mobile":true}' "$(verify_lane_states "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$HEAD" 1)"`,
    ].join("\n");
    withBash(body, { env: env(), state: { verifyDevice: `${HEAD}:running` } }, (r) => {
      assert.equal(r.issue.verifyDevice, `${HEAD}:retry:stopped-threads`);
      assert.equal(isTerminalLaneState("retry:stopped-threads"), false);
      assert.match(r.calls, /^device start --issue 7 /m, "started again");
      assert.equal(followups(r).length, 0, "a stopped run posts nothing");
    });
  });

  it("keeps the last run's dir when a later state has none", () => {
    const body = [
      'verify_device_record 7 "$HEAD" running /runs/one',
      'verify_device_record 7 "$HEAD" deferred:busy',
    ].join("\n");
    withBash(body, { env: env() }, (r) => {
      assert.equal(r.issue.verifyDevice, `${HEAD}:deferred:busy`);
      assert.equal(r.issue.verifyDeviceRunDir, "/runs/one");
    });
  });

  it("deferred through Testing, started from In Test, finished, one follow-up", () => {
    const body = [
      `RUN_DIR="$REPO_ROOT/logs/factory/device/runs/${DEVICE_RUN_ID}"`,
      // Testing: the wait is over while the lane still waited for the betas.
      'verify_sweep_card ITEM 7 "$LABELS"',
      // In Test: the next ticks start the run, then leave it running.
      startedStub,
      "verify_device_intest_work",
      "verify_device_intest_work",
      // The run finishes; housekeeping posts its results once.
      seedDeviceRun({ ledgerState: "done:PASS" }),
      "verify_device_housekeeping",
      "verify_device_housekeeping",
    ].join("\n");
    const state = round({ verifyDevice: `${HEAD}:deferred:beta-build` });
    withBash(body, { env: env(), state }, (r) => {
      assert.match(r.log, /Testing → promote \(lanes-done\)/);
      assert.equal(r.calls.match(/^transition /gm)?.length, 1, "only the promotion moves it");
      const report = reports(r)[0].body;
      assert.match(report, /the device lane hadn't started \(a beta build was running\)/);
      assert.doesNotMatch(report, /running — results follow/);
      assert.equal(r.calls.match(/^device start /gm)?.length, 1, "started once, from In Test");
      assert.equal(r.issue.verifyDevice, `${HEAD}:reported:pass`);
      assert.equal(followups(r).length, 1);
      assert.equal(r.issue.deviceReportPosted, `${HEAD}:${DEVICE_RUN_ID}`);
    });
  });

  it("leaves an In Test card alone once its head moved, its lane is terminal, or it skipped Testing", () => {
    for (const [state, view] of [
      [
        round({ verifyReportSha: HEAD, verifyDevice: `${HEAD}:deferred:busy` }),
        prView({ headRefOid: OLD }),
      ],
      [round({ verifyReportSha: HEAD, verifyDevice: `${HEAD}:skipped:attempts` }), prView()],
      [round({ verifyReportSha: HEAD, verifyDevice: `${HEAD}:running` }), prView()],
      [round({ verifyDevice: `${HEAD}:deferred:busy` }), prView()], // no report for this head
    ]) {
      withBash("verify_device_intest_work", { env: env({ PR_VIEW_STUB: view }), state }, (r) => {
        assert.doesNotMatch(r.calls, /^device start /m, state.verifyDevice);
        assert.doesNotMatch(r.calls, /^transition/m);
      });
    }
    // Off: no board query at all.
    withBash("verify_device_intest_work", { env: env({ FACTORY_VERIFY_DEVICE: "0" }) }, (r) => {
      assert.doesNotMatch(r.calls, /^project /m);
    });
  });

  it("is called from --watch after the In Test feedback sweep", () => {
    const intest = script.indexOf("  # ── In Test feedback sweep", watchStart);
    const pass = script.indexOf("\n  verify_device_intest_work\n", watchStart);
    const candidates = script.indexOf("\n  browser_write_candidates\n", pass);
    const revising = script.lastIndexOf("<!-- drafto-factory-revising -->", pass);
    assert.ok(intest !== -1 && pass > intest && revising > intest && pass > revising);
    assert.ok(candidates > pass, "before --watch hands its browser candidates over");
    assert.equal(script.match(/\n  verify_device_intest_work\n/g)?.length, 1, "after the sweep");
  });

  it("a promotion that stops the run doesn't promise its results", () => {
    const body = [
      seedDeviceRun({ output: deviceOutput({ running: true }) }),
      setRunDir,
      'mkdir -p "$REPO_ROOT/logs/factory/device" && echo "{}" > "$REPO_ROOT/logs/factory/device/ledger.json"',
      `verify_promote ITEM 7 70 "$HEAD" feedback '{"shell":"skipped:lane-off","browser":"skipped:not-web","device":"skipped:feedback"}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`,
    ].join("\n");
    withBash(body, { env: env(), state: round({ verifyDevice: `${HEAD}:running` }) }, (r) => {
      assert.match(r.calls, /^device stop --issue 7 --reason feedback /m);
      const report = reports(r)[0].body;
      assert.doesNotMatch(report, /running — results follow/);
      assert.match(report, /the device run was stopped: the card rolled back for feedback/);
    });
  });

  it("results already in the verification report aren't posted again", () => {
    const body = [
      seedDeviceRun({ ledgerState: "done:PASS", finishedAt: minsAgo(1) }),
      setRunDir,
      // The run finished in Testing: the follow-up waits for the report.
      "verify_device_housekeeping",
      'test -e "$RUN_DIR/followup.done" && echo EARLY-DONE || echo WAITING',
      'verify_sweep_card ITEM 7 "$LABELS"',
      "verify_device_housekeeping",
      "verify_device_housekeeping",
    ].join("\n");
    withBash(body, { env: env(), state: round({ verifyDevice: `${HEAD}:running` }) }, (r) => {
      assert.match(r.stdout, /^WAITING$/m);
      assert.match(r.log, /Testing → promote \(lanes-done\)/);
      assert.match(reports(r)[0].body, /\| iOS \(simulator\) \| ran \| PASS \|/);
      assert.equal(followups(r).length, 0);
      assert.equal(r.issue.deviceReportPosted, `${HEAD}:${DEVICE_RUN_ID}:in-report`);
    });
  });

  it("posts the round's run once its report is out without its results", () => {
    // Running at promotion: the report promised them, so the follow-up goes out.
    const body = [
      seedDeviceRun({ ledgerState: "done:PASS" }),
      setRunDir,
      "verify_device_housekeeping",
    ].join("\n");
    const state = round({ verifyDevice: `${HEAD}:running`, verifyReportSha: HEAD });
    withBash(body, { env: env(), state }, (r) => {
      assert.equal(followups(r).length, 1);
    });
  });

  it("holds the round's run until a report is posted, the head moves, the card leaves, or time runs out", () => {
    const seed = (finishedAt) =>
      [
        seedDeviceRun({ ledgerState: "done:PASS", finishedAt }),
        setRunDir,
        "verify_device_housekeeping",
        'test -e "$RUN_DIR/followup.done" && echo DONE || echo HELD',
      ].join("\n");
    const state = round({ verifyDevice: `${HEAD}:running` }); // no report yet
    const column = (status) => JSON.stringify({ itemId: "ITEM", contentId: "N", status });
    const inReview = column("In Review");
    // Just finished, card in In Review after a hand-back: held.
    withBash(seed(minsAgo(5)), { env: env({ ITEM_STATUS_STUB: inReview }), state }, (r) => {
      assert.match(r.calls, /^project item-status --issue 7$/m, "the board column is looked up");
      assert.doesNotMatch(r.calls, /^gh issue view /m, "not the status:* label");
      assert.match(r.stdout, /^HELD$/m);
      assert.equal(followups(r).length, 0);
      assert.equal(r.issue.deviceReportPosted ?? null, null);
    });
    // The board can't be read: held too (not read as a move).
    for (const over of [{ ITEM_STATUS_FAIL: "1" }, { ITEM_STATUS_STUB: "" }]) {
      withBash(seed(minsAgo(5)), { env: env(over), state }, (r) => {
        assert.match(r.stdout, /^HELD$/m, JSON.stringify(over));
        assert.equal(followups(r).length, 0);
      });
    }
    // The head moved: released, and recorded as stale.
    withBash(
      seed(minsAgo(5)),
      {
        env: env({ ITEM_STATUS_STUB: inReview, PR_VIEW_STUB: prView({ headRefOid: OLD }) }),
        state,
      },
      (r) => {
        assert.match(r.stdout, /^DONE$/m);
        assert.equal(followups(r).length, 0, "a moved head never gets its results");
        assert.equal(r.issue.deviceReportPosted, `${HEAD}:${DEVICE_RUN_ID}:stale`);
      },
    );
    // Dragged out of Testing by hand (to In Test, Blocked, off the board), its
    // status:testing label left behind: the board says so, released, posted.
    for (const status of ["In Test", "Blocked", null]) {
      withBash(
        seed(minsAgo(5)),
        {
          env: env({
            ITEM_STATUS_STUB: column(status),
            ISSUE_VIEW_STUB: JSON.stringify({
              state: "OPEN",
              labels: [{ name: "status:testing" }],
            }),
          }),
          state,
        },
        (r) => {
          assert.equal(followups(r).length, 1, String(status));
        },
      );
    }
    // Past the hold cap + 60 minutes since it finished: released, posted.
    withBash(seed(minsAgo(121)), { env: env({ ITEM_STATUS_STUB: inReview }), state }, (r) => {
      assert.equal(followups(r).length, 1);
    });
  });

  it("marks the results as reported only once the report showing them is posted", () => {
    const promote = `verify_promote ITEM 7 70 "$HEAD" lanes-done '{"shell":"skipped:lane-off","browser":"skipped:not-web","device":"reported:pass"}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
    const body = [
      seedDeviceRun({ ledgerState: "done:PASS" }),
      setRunDir,
      `${promote} || true`,
      'ls "$RUN_DIR" | grep report-composed || echo NO-MARKER',
    ].join("\n");
    const state = round({ verifyDevice: `${HEAD}:reported:pass` });
    // The post fails: only the pending marker, so the follow-up isn't suppressed.
    withBash(body, { env: env({ FAIL_COMMENT: "1" }), state }, (r) => {
      assert.match(r.stdout, /^report-composed\.pending$/m);
      assert.doesNotMatch(r.stdout, /^report-composed$/m);
    });
    // Posted: the marker.
    withBash(body, { env: env(), state }, (r) => {
      assert.match(r.stdout, /^report-composed$/m);
      assert.match(reports(r)[0].body, /\| iOS \(simulator\) \| ran \| PASS \|/);
    });
    // The device lane's text withheld (its password file unreadable): no marker.
    withBash(
      body,
      { env: env({ FACTORY_DEVICE_ACCOUNT_FILE: "/nonexistent/device.env" }), state },
      (r) => {
        assert.match(r.stdout, /^NO-MARKER$/m);
      },
    );
  });

  it("passes --device-out only for output the state's own run produced", () => {
    const promote = (device) =>
      `verify_promote ITEM 7 70 "$HEAD" lanes-done '{"shell":"skipped:lane-off","browser":"skipped:not-web","device":"${device}"}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
    // An earlier attempt's run (retry:lost) is kept beside a later refusal.
    const body = [
      seedDeviceRun({ ledgerState: "retry:lost" }),
      setRunDir,
      promote("unavailable:no-account"),
    ].join("\n");
    const state = round({ verifyDevice: `${HEAD}:unavailable:no-account` });
    withBash(body, { env: env(), state }, (r) => {
      const report = reports(r)[0].body;
      assert.doesNotMatch(report, /iOS \(simulator\)/, "the kept run's output isn't shown");
      assert.match(
        report,
        /the device lane couldn't run: the device lane's dev account file is missing/,
      );
    });
    // The same dir for a state that run produced is shown.
    const own = [
      seedDeviceRun({ ledgerState: "failed:build" }),
      setRunDir,
      promote("unavailable:build"),
    ].join("\n");
    withBash(
      own,
      { env: env(), state: round({ verifyDevice: `${HEAD}:unavailable:build` }) },
      (r) => {
        assert.match(reports(r)[0].body, /iOS \(simulator\)/);
      },
    );
  });

  it("records the lane as off for a round started while it was off or not built", () => {
    const begin = `verify_begin_round 7 "$HEAD" "" '{}'`;
    withBash(begin, { env: { HEAD, VERIFY_BUILT_LANES_STUB: "shell,browser,device" } }, (r) => {
      assert.equal(r.issue.verifyDevice, `${HEAD}:skipped:lane-off`);
    });
    withBash(
      begin,
      { env: { HEAD, ...DEVICE_ON, VERIFY_BUILT_LANES_STUB: "shell,browser" } },
      (r) => {
        assert.equal(r.issue.verifyDevice, `${HEAD}:skipped:not-built`);
      },
    );
    withBash(begin, { env: { HEAD, ...DEVICE_ON } }, (r) => {
      assert.equal(r.issue.verifyDevice ?? null, null, "on: nothing until the lane works");
    });
  });

  it("from In Test: starts a round whose lane recorded nothing, never one started with it off", () => {
    // No record: the round started with the lane on, but nothing ran yet.
    withBash(
      `${startedStub.replace("$RUN_DIR", "/runs/x")}\nverify_device_intest_work`,
      { env: env(), state: round({ verifyReportSha: HEAD }) },
      (r) => {
        assert.match(r.calls, /^gh pr diff 70 /m, "its platforms are read");
        assert.match(r.calls, /^device start --issue 7 /m);
        assert.equal(r.issue.verifyDevice, `${HEAD}:running`);
      },
    );
    // A web-only PR: not applicable, nothing started.
    withBash(
      "verify_device_intest_work",
      { env: env({ DIFF_STUB: "apps/web/a.ts" }), state: round({ verifyReportSha: HEAD }) },
      (r) => {
        assert.doesNotMatch(r.calls, /^device start /m);
        assert.equal(r.issue.verifyDevice, `${HEAD}:skipped:not-applicable`);
      },
    );
    for (const rec of ["skipped:lane-off", "skipped:not-built"]) {
      withBash(
        "verify_device_intest_work",
        { env: env(), state: round({ verifyReportSha: HEAD, verifyDevice: `${HEAD}:${rec}` }) },
        (r) => assert.doesNotMatch(r.calls, /^device start /m, rec),
      );
    }
  });

  it("re-derives lane-off and not-built in Testing, and clears them when a round starts with the lane on", () => {
    const states = `verify_lane_states "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$HEAD" 1`;
    for (const rec of ["skipped:lane-off", "skipped:not-built"]) {
      withBash(states, { env: env(), state: { verifyDevice: `${HEAD}:${rec}` } }, (r) => {
        assert.equal(JSON.parse(r.stdout).device, "none", rec);
      });
    }
    const begin = `verify_begin_round 7 "$HEAD" "" "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")"`;
    withBash(begin, { env: env(), state: { verifyDevice: `${HEAD}:skipped:lane-off` } }, (r) => {
      assert.equal(r.issue.verifyDevice ?? null, null);
    });
  });

  it("never overwrites a head's device result with lane-off", () => {
    const begin = `verify_begin_round 7 "$HEAD" "" "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")"`;
    withBash(
      begin,
      {
        env: { HEAD, VERIFY_BUILT_LANES_STUB: "shell,browser,device" },
        state: { verifyDevice: `${HEAD}:reported:pass` },
      },
      (r) => assert.equal(r.issue.verifyDevice, `${HEAD}:reported:pass`),
    );
    // Another commit's record is replaced.
    withBash(
      begin,
      {
        env: { HEAD, VERIFY_BUILT_LANES_STUB: "shell,browser,device" },
        state: { verifyDevice: `${OLD}:reported:pass` },
      },
      (r) => assert.equal(r.issue.verifyDevice, `${HEAD}:skipped:lane-off`),
    );
  });

  it("stops the device run when the factory moves a card out of In Test itself", () => {
    const sweep = script.slice(
      script.indexOf("  # ── In Test feedback sweep", watchStart),
      script.indexOf(
        "\n  verify_device_intest_work\n",
        script.indexOf("<!-- drafto-factory-revising -->", watchStart),
      ),
    );
    const stopFb = sweep.indexOf('verify_device_stop "$ISSUE_NUM" "" feedback || true');
    const rollback = sweep.indexOf(
      'transition_status "$ITEM_ID" "$ISSUE_NUM" "In Progress" || true',
    );
    assert.ok(stopFb !== -1 && rollback > stopFb, "before the feedback rollback");
    const stopConflict = sweep.indexOf(
      'verify_device_stop "$ISSUE_NUM" "$INTEST_HEAD_SHA" conflict || true',
    );
    const conflict = sweep.indexOf('conflict_handback "$ITEM_ID" "$ISSUE_NUM" "$INTEST_PR_NUM"');
    assert.ok(stopConflict !== -1 && conflict > stopConflict, "before the conflict hand-back");
    const ledger =
      'mkdir -p "$REPO_ROOT/logs/factory/device" && echo "{}" > "$REPO_ROOT/logs/factory/device/ledger.json"';
    withBash(`${ledger}\nverify_device_stop 7 "$HEAD" conflict`, { env: env() }, (r) => {
      assert.match(r.calls, /^device stop --issue 7 --reason conflict /m);
    });
  });

  it("runs the In Test pass on the feedback sweep's query-failure exit too", () => {
    const branch = slice(
      'if ! INTEST_JSON=$(node "$SCRIPT_DIR/lib/factory-project.mjs" query-status-items',
      "    exit 0\n",
      watchStart,
    );
    assert.match(branch, /\n\s+verify_device_intest_work\n[\s\S]*\n\s+browser_write_candidates\n/);
    assert.equal(script.match(/\n\s+verify_device_intest_work\n/g)?.length, 2);
  });

  it("a run that gave way to a beta build starts again later (refunded)", () => {
    const body = [
      seedDeviceRun({ ledgerState: "retry:beta-build" }),
      setRunDir,
      "verify_device_housekeeping",
      startedStub,
      "verify_device_intest_work",
    ].join("\n");
    const state = round({ verifyReportSha: HEAD, verifyDevice: `${HEAD}:running` });
    withBash(body, { env: env(), state }, (r) => {
      assert.equal(r.issue.verifyDevice, `${HEAD}:running`, "restarted from retry:beta-build");
      assert.match(r.log, /device lane for aaaaaaaaaaaa: retry:beta-build/);
      assert.match(r.calls, /^device start --issue 7 /m);
      assert.equal(followups(r).length, 0, "a run that gave way posts nothing");
    });
  });
});

describe("the device lane: review round 4 (run identity, board column, account file, OCR)", () => {
  const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const RUN_DIR = `$REPO_ROOT/logs/factory/device/runs/${DEVICE_RUN_ID}`;
  const round = (over = {}) => ({
    verifySha: HEAD,
    verifyStartedAt: minsAgo(31),
    lastReviewSha: HEAD,
    lastFeedbackAt: "2026-01-01T00:00:00Z",
    intestCommentSha: HEAD,
    verifyShell: `${HEAD}:skipped:lane-off`,
    verifyBrowser: `${HEAD}:skipped:not-web`,
    ...over,
  });
  const env = (over = {}) => ({
    HEAD,
    LABELS: "status:testing",
    PR_OBJ_STUB: PR_OBJ,
    PR_VIEW_STUB: prView(),
    DIFF_STUB: "apps/mobile/e2e/ios-all.yaml",
    ...DEVICE_ON,
    FACTORY_VERIFY_LANES: "browser,device",
    FACTORY_DEVICE_ACCOUNT_FILE: "",
    TESTING_ITEMS: JSON.stringify([{ itemId: "ITEM", issueNumber: 7, labels: ["status:in-test"] }]),
    ...over,
  });
  const setRunDir = `node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field 7 verifyDeviceRunDir "$RUN_DIR" --state-file "$STATE_FILE" >/dev/null`;
  const followups = (r) => r.comments.filter((c) => /drafto-factory-device-report/.test(c.body));
  const reports = (r) => r.comments.filter((c) => /drafto-factory-verify-report/.test(c.body));
  const ledgerDir = 'mkdir -p "$REPO_ROOT/logs/factory/device"';
  const inFlight = (over = "") =>
    `${ledgerDir} && jq -nc --arg d "${RUN_DIR}" '{version: 1, inFlight: ({runId: "${DEVICE_RUN_ID}", issue: "7", pr: "70", sha: "${HEAD}", runDir: $d}${over}), attempts: {}, last: {}}' > "$REPO_ROOT/logs/factory/device/ledger.json"`;
  const work = `verify_device_work 7 70 "$HEAD" '{"mobile":true}' '{"device":"none"}'`;

  it("records a run with its dir in one write, and tries a failed write once more", () => {
    const body = [
      // The first state write fails; the second must carry both fields.
      `eval "$(declare -f node | sed '1s/^node/stub_node/')"`,
      'node() { if [[ "$2" == factory:set-issue-fields ]]; then echo "$*" >> "$REPO_ROOT/writes"; if [[ ! -e "$REPO_ROOT/failed-once" ]]; then : > "$REPO_ROOT/failed-once"; return 1; fi; fi; stub_node "$@"; }',
      'verify_device_record 7 "$HEAD" running /runs/one',
      'cat "$REPO_ROOT/writes"',
    ].join("\n");
    withBash(body, { env: env() }, (r) => {
      assert.equal(r.issue.verifyDevice, `${HEAD}:running`);
      assert.equal(r.issue.verifyDeviceRunDir, "/runs/one");
      const writes = r.stdout.trim().split("\n");
      assert.equal(writes.length, 2, "tried once more");
      for (const w of writes) {
        assert.match(
          w,
          /verifyDevice \S+:running verifyDeviceRunDir \/runs\/one/,
          "one write, both",
        );
      }
      assert.doesNotMatch(r.log, /couldn't record/);
    });
  });

  it("adopts an unrecorded run in flight for the same commit instead of starting another", () => {
    withBash(`${inFlight()}\n${work}`, { env: env() }, (r) => {
      assert.doesNotMatch(r.calls, /^device start /m);
      assert.equal(r.issue.verifyDevice, `${HEAD}:running`);
      assert.match(r.issue.verifyDeviceRunDir, new RegExp(`device/runs/${DEVICE_RUN_ID}$`));
      assert.match(r.log, /wasn't recorded; adopting it/);
    });
    // Another commit's run, or one already stopping, isn't ours to adopt.
    for (const over of [` + {sha: "${OLD}"}`, ` + {stopping: {reason: "feedback"}}`]) {
      withBash(`${inFlight(over)}\n${work}`, { env: env() }, (r) => {
        assert.match(r.calls, /^device start /m, over);
        assert.doesNotMatch(r.log, /adopting/);
      });
    }
  });

  it("adopts a finished run the round never recorded, so the lane isn't run again", () => {
    const body = [
      seedDeviceRun({ ledgerState: "done:PASS", finishedAt: minsAgo(1) }),
      // The record still names an earlier run's dir, for another commit.
      'node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field 7 verifyDeviceRunDir /runs/older --state-file "$STATE_FILE" >/dev/null',
      "verify_device_housekeeping",
      `verify_device_work 7 70 "$HEAD" '{"mobile":true}' "$(verify_lane_states "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$HEAD" 1)"`,
    ].join("\n");
    const state = round({ verifyDevice: `${HEAD}:deferred:busy` });
    withBash(body, { env: env(), state }, (r) => {
      assert.equal(r.issue.verifyDevice, `${HEAD}:reported:pass`);
      assert.match(r.issue.verifyDeviceRunDir, new RegExp(`device/runs/${DEVICE_RUN_ID}$`));
      assert.doesNotMatch(r.calls, /^device start /m, "terminal now: not started again");
      assert.equal(followups(r).length, 0, "the round's run waits for its report");
    });
    // A run for another commit than the round's is left as it is.
    const other = round({ verifySha: OLD, verifyDevice: `${OLD}:deferred:busy` });
    withBash(body.split("\n").slice(0, -1).join("\n"), { env: env(), state: other }, (r) => {
      assert.equal(r.issue.verifyDevice, `${OLD}:deferred:busy`);
      assert.equal(r.issue.verifyDeviceRunDir, "/runs/older");
    });
  });

  it("posts nothing when the head moves while the comments are read", () => {
    const body = [
      seedDeviceRun({ ledgerState: "done:PASS" }),
      `eval "$(declare -f gh | sed '1s/^gh/stub_gh/')"`,
      `gh() { if [[ "$1 $2" == "pr view" && -e "$REPO_ROOT/moved" ]]; then call "gh $*"; echo '{"state":"OPEN","headRefOid":"${OLD}"}'; return 0; fi; stub_gh "$@"; }`,
      'fetch_issue_comments() { : > "$REPO_ROOT/moved"; cat "$COMMENTS_FILE"; }',
      "verify_device_housekeeping",
    ].join("\n");
    withBash(body, { env: env() }, (r) => {
      assert.equal(followups(r).length, 0);
      assert.equal(r.issue.deviceReportPosted, `${HEAD}:${DEVICE_RUN_ID}:stale`);
      assert.match(r.log, /head moved off .* it isn't posted \(stale\)/);
    });
  });

  it("scans for the password of the account file the run used, not the current setting", () => {
    const leaky = deviceOutput();
    leaky.platforms.ios.verdict = "FAIL";
    leaky.platforms.ios.flows = [
      { name: "ios-all.yaml", status: "FAIL", durationS: 3, failure: "typed Run-Acct-Passw0rd" },
    ];
    const meta = [
      `printf 'E2E_TEST_EMAIL=dev@example.com\\nE2E_TEST_PASSWORD=Run-Acct-Passw0rd\\n' > "$REPO_ROOT/run-account.env"`,
      'chmod 600 "$REPO_ROOT/run-account.env"',
      `jq -nc --arg a "$REPO_ROOT/run-account.env" '{needsAccount: true, paths: {accountFile: $a}}' > "${RUN_DIR}/meta.json"`,
    ].join("\n");
    // The follow-up comment.
    withBash(
      [
        seedDeviceRun({ output: leaky, ledgerState: "done:FAIL" }),
        meta,
        "verify_device_housekeeping",
      ].join("\n"),
      { env: env() },
      (r) => {
        const posted = followups(r);
        assert.equal(posted.length, 1);
        assert.ok(
          !posted[0].body.includes("Run-Acct-Passw0rd"),
          "the run's password is scanned for",
        );
      },
    );
    // The verification report.
    const promote = `verify_promote ITEM 7 70 "$HEAD" lanes-done '{"shell":"skipped:lane-off","browser":"skipped:not-web","device":"reported:fail"}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
    withBash(
      [seedDeviceRun({ output: leaky, ledgerState: "done:FAIL" }), meta, setRunDir, promote].join(
        "\n",
      ),
      { env: env(), state: round({ verifyDevice: `${HEAD}:reported:fail` }) },
      (r) => {
        const report = reports(r)[0].body;
        assert.ok(!report.includes("Run-Acct-Passw0rd"));
        assert.match(report, /report withheld \(matched device-password\)/);
      },
    );
    // No account in the run's record: the setting is the fallback.
    withBash(
      `mkdir -p "${RUN_DIR}" && printf '{}' > "${RUN_DIR}/meta.json"\nverify_device_account_file "${RUN_DIR}"`,
      { env: env({ FACTORY_DEVICE_ACCOUNT_FILE: "/set/device.env" }) },
      (r) => assert.equal(r.stdout.trim(), "/set/device.env"),
    );
  });

  it("doesn't repeat results its follow-up already posted, and points at that comment", () => {
    const promote = `verify_promote ITEM 7 70 "$HEAD" lanes-done '{"shell":"skipped:lane-off","browser":"skipped:not-web","device":"reported:pass"}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
    const body = [
      seedDeviceRun({ ledgerState: "done:PASS" }),
      setRunDir,
      promote,
      'ls "$RUN_DIR" | grep report-composed || echo NO-MARKER',
    ].join("\n");
    const state = round({
      verifyDevice: `${HEAD}:reported:pass`,
      deviceReportPosted: `${HEAD}:${DEVICE_RUN_ID}`,
    });
    withBash(body, { env: env(), state }, (r) => {
      const report = reports(r)[0].body;
      assert.doesNotMatch(report, /\| iOS \(simulator\) \| ran \| PASS \|/);
      assert.match(report, /results are already on this issue, in the device lane's own comment/);
      assert.match(r.stdout, /^NO-MARKER$/m);
    });
    // Settled some other way (stale, in-report…): shown as before.
    withBash(
      body,
      { env: env(), state: { ...state, deviceReportPosted: `${HEAD}:${DEVICE_RUN_ID}:stale` } },
      (r) => assert.match(reports(r)[0].body, /\| iOS \(simulator\) \| ran \| PASS \|/),
    );
  });

  it("a failed composition drops an earlier composition's marker", () => {
    const promote = `verify_promote ITEM 7 70 "$HEAD" lanes-done '{"shell":"skipped:lane-off","browser":"skipped:not-web","device":"reported:pass"}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
    const body = [
      seedDeviceRun({ ledgerState: "done:PASS" }),
      setRunDir,
      'printf "%s\\n" "$HEAD" > "$RUN_DIR/report-composed.pending"',
      `REPORT_FAIL=1 ${promote}`,
      'ls "$RUN_DIR" | grep report-composed || echo NO-MARKER',
      "verify_device_housekeeping",
    ].join("\n");
    const state = round({ verifyDevice: `${HEAD}:reported:pass` });
    withBash(body, { env: env(), state }, (r) => {
      assert.match(reports(r)[0].body, /report\s+couldn't be composed/);
      assert.match(r.stdout, /^NO-MARKER$/m);
      assert.equal(followups(r).length, 1, "the results still go out, as the follow-up");
      assert.equal(r.issue.deviceReportPosted, `${HEAD}:${DEVICE_RUN_ID}`);
    });
  });

  it("holds the follow-up while a saved report with its results waits for a retry", () => {
    const inTest = JSON.stringify({ itemId: "ITEM", contentId: "N", status: "In Test" });
    const seed = [
      seedDeviceRun({ ledgerState: "done:PASS" }),
      setRunDir,
      'printf "%s\\n" "$HEAD" > "$RUN_DIR/report-composed.pending"',
      'mkdir -p "$VERIFY_DIR"',
      `printf 'report with device rows <!-- drafto-factory-verify-report --> <!-- drafto-factory-verify-sha:%s -->\\n' "$HEAD" > "$VERIFY_DIR/report-7-$HEAD.md"`,
      'touch -t 202601010000 "$VERIFY_DIR/report-7-$HEAD.md"',
    ];
    const state = round({ verifyDevice: `${HEAD}:reported:pass`, verifyReportPosts: `${HEAD}:1` });
    const retry = `verify_report_retry 7 "$HEAD" "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")"`;
    // The retry is still to come: no follow-up; once it posts, the run is in-report.
    withBash(
      [...seed, "verify_device_housekeeping", retry, "verify_device_housekeeping"].join("\n"),
      { env: env({ ITEM_STATUS_STUB: inTest }), state },
      (r) => {
        assert.equal(followups(r).length, 0, "the results went out once, in the report");
        assert.equal(reports(r).length, 1);
        assert.equal(r.issue.deviceReportPosted, `${HEAD}:${DEVICE_RUN_ID}:in-report`);
      },
    );
    // Retries spent: the follow-up posts.
    withBash(
      [...seed, "verify_device_housekeeping"].join("\n"),
      {
        env: env({ ITEM_STATUS_STUB: inTest }),
        state: { ...state, verifyReportPosts: `${HEAD}:4` },
      },
      (r) => assert.equal(followups(r).length, 1),
    );
    // The card left In Test (the retry runs only there): the follow-up posts.
    const approved = JSON.stringify({ itemId: "ITEM", contentId: "N", status: "Approved" });
    withBash(
      [...seed, "verify_device_housekeeping"].join("\n"),
      { env: env({ ITEM_STATUS_STUB: approved }), state },
      (r) => assert.equal(followups(r).length, 1),
    );
  });

  it("from In Test: continues a round promoted for its head even when its report never posted", () => {
    const promote = `verify_promote ITEM 7 70 "$HEAD" lanes-done '{"shell":"skipped:lane-off","browser":"skipped:not-web","device":"skipped:beta-build"}' "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$(cat "$COMMENTS_FILE")"`;
    const startedStub = `DEVICE_START_STUB='{"started":true,"runId":"${DEVICE_RUN_ID}","runDir":"/runs/x"}'`;
    const body = [`FAIL_COMMENT=1 ${promote}`, startedStub, "verify_device_intest_work"].join("\n");
    withBash(
      body,
      { env: env(), state: round({ verifyDevice: `${HEAD}:deferred:beta-build` }) },
      (r) => {
        assert.equal(r.issue.verifyPromotedSha, HEAD);
        assert.equal(r.issue.verifyReportSha ?? null, null, "the report wasn't posted");
        assert.match(r.calls, /^device start --issue 7 /m);
        assert.equal(r.issue.verifyDevice, `${HEAD}:running`);
      },
    );
  });

  it("from In Test: starts nothing for a card with feedback pending, or whose comments can't be read", () => {
    const state = round({ verifyPromotedSha: HEAD, verifyDevice: `${HEAD}:deferred:beta-build` });
    const feedback = [
      {
        id: 5,
        user: { login: "JakubAnderwald" },
        body: "The button is the wrong colour, please fix it",
        createdAt: "2026-10-20T00:00:00Z",
        authorAssociation: "OWNER",
      },
    ];
    withBash("verify_device_intest_work", { env: env(), state, comments: feedback }, (r) => {
      assert.doesNotMatch(r.calls, /^device start /m);
      assert.match(r.log, /actionable feedback pending; not starting a run/);
    });
    withBash("verify_device_intest_work", { env: env({ COMMENTS_FAIL: "1" }), state }, (r) => {
      assert.doesNotMatch(r.calls, /^device start /m);
      assert.match(r.log, /couldn't read the comments; trying again next tick/);
    });
    // Only noise since the mark: it starts.
    const thanks = [{ ...feedback[0], body: "thanks!" }];
    withBash("verify_device_intest_work", { env: env(), state, comments: thanks }, (r) => {
      assert.match(r.calls, /^device start /m);
    });
  });

  it("builds the OCR helper in the background when a run starts, once, never in the tick", () => {
    const fake = [
      'mkdir -p "$REPO_ROOT/apps/desktop/e2e/in-test/lib" "$REPO_ROOT/fakebin"',
      'echo "// ocr" > "$REPO_ROOT/apps/desktop/e2e/in-test/lib/ocr.swift"',
      // A swiftc that writes its -o output.
      `printf '#!/bin/sh\\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\\nsleep 0.3\\nprintf "#!/bin/sh\\\\n" > "$out"; chmod +x "$out"\\n' > "$REPO_ROOT/fakebin/swiftc"`,
      'chmod +x "$REPO_ROOT/fakebin/swiftc"',
      'PATH="$REPO_ROOT/fakebin:$PATH"',
    ].join("\n");
    const startedStub = `DEVICE_START_STUB='{"started":true,"runId":"${DEVICE_RUN_ID}","runDir":"/runs/x"}'`;
    const body = [
      fake,
      startedStub,
      work,
      // Returned at once: the build is still going (or only just done).
      'test -e "$LOG_DIR/bin/ocr.building" && echo BUILDING-MARKER',
      'for _ in $(seq 1 100); do [[ -x "$LOG_DIR/bin/ocr" && ! -e "$LOG_DIR/bin/ocr.building" ]] && break; sleep 0.1; done',
      'test -x "$LOG_DIR/bin/ocr" && echo BUILT',
      'test -e "$LOG_DIR/bin/ocr.tmp" || echo NO-TMP',
      // Built and fresh: nothing more to do.
      "evidence_ocr_provision && echo FRESH-OK",
      'test -e "$LOG_DIR/bin/ocr.building" || echo NO-SECOND-BUILD',
    ].join("\n");
    withBash(body, { env: env() }, (r) => {
      assert.match(r.stdout, /^BUILDING-MARKER$/m);
      assert.match(r.stdout, /^BUILT$/m);
      assert.match(r.stdout, /^NO-TMP$/m);
      assert.match(r.stdout, /^FRESH-OK$/m);
      assert.match(r.stdout, /^NO-SECOND-BUILD$/m);
      assert.match(r.log, /Building the OCR helper .* in the background/);
    });
    // Uploads off: nothing is built.
    withBash(
      [fake, startedStub, work, 'test -e "$LOG_DIR/bin/ocr.building" || echo NONE'].join("\n"),
      { env: env({ FACTORY_EVIDENCE_UPLOAD: "0" }) },
      (r) => assert.match(r.stdout, /^NONE$/m),
    );
  });
});

describe("the factory-device-run label: an on-demand device run (ADR-0106 decision 7)", () => {
  const env = (over = {}) => ({
    HEAD,
    PR_OBJ_STUB: PR_OBJ,
    PR_VIEW_STUB: prView(),
    // The operator asked: it runs whatever FACTORY_VERIFY_DEVICE says.
    FACTORY_VERIFY_DEVICE: "0",
    VERIFY_BUILT_LANES_STUB: "shell,browser,device",
    TESTING_ITEMS: JSON.stringify([
      { itemId: "ITEM", issueNumber: 7, labels: ["status:in-test", "factory-device-run"] },
    ]),
    ...over,
  });
  const started = `{"started":true,"runId":"${DEVICE_RUN_ID}","runDir":"/runs/od"}`;
  const removed = (r) =>
    r.calls.match(/^gh issue edit 7 .*--remove-label factory-device-run/gm) ?? [];
  const notes = (r) => r.comments.filter((c) => /drafto-factory-device-run -->/.test(c.body));

  it("starts the run on the PR head with one allowance past the cap, then takes the label off", () => {
    withBash("verify_device_ondemand_work", { env: env({ DEVICE_START_STUB: started }) }, (r) => {
      assert.match(
        r.calls,
        new RegExp(
          `^device start --issue 7 --pr 70 --sha ${HEAD} --trigger on-demand --force-attempt `,
          "m",
        ),
      );
      // Testing and In Test are both walked; the one labelled card starts once
      // per column it was listed in, and the label goes after the first.
      assert.ok(removed(r).length >= 1);
      assert.equal(r.issue.deviceRunRequest, `${HEAD}:${DEVICE_RUN_ID}`);
      assert.doesNotMatch(r.calls, /^transition/m, "never moves a card");
      assert.equal(notes(r).length, 0);
    });
  });

  it("keeps the label and waits while the lane is busy or a beta builds, logging once per reason", () => {
    const body = ["verify_device_ondemand_work", "verify_device_ondemand_work"].join("\n");
    withBash(
      body,
      { env: env({ DEVICE_START_STUB: '{"started":false,"reason":"deferred:beta-build"}' }) },
      (r) => {
        assert.equal(removed(r).length, 0);
        assert.equal(r.issue.deviceRunRequest, `${HEAD}:waiting:deferred:beta-build`);
        assert.equal(r.log.match(/on-demand device run waits \(deferred:beta-build\)/g)?.length, 1);
      },
    );
  });

  it("says why on the issue and takes the label off when the run can't happen", () => {
    for (const [reason, why] of [
      ["account", /no device-lane account/],
      ["maestro-missing", /a tool the lane needs is missing/],
      ["not-applicable", /changes nothing the mobile app is built from/],
    ]) {
      withBash(
        "verify_device_ondemand_work",
        { env: env({ DEVICE_START_STUB: `{"started":false,"reason":"${reason}"}` }) },
        (r) => {
          assert.ok(removed(r).length >= 1, reason);
          assert.equal(r.issue.deviceRunRequest, `${HEAD}:refused`);
          assert.ok(notes(r).length >= 1, reason);
          assert.match(notes(r)[0].body, why);
          // A factory comment: never read as the operator's feedback.
          assert.match(notes(r)[0].body, /^<!-- drafto-factory/);
        },
      );
    }
  });

  it("refuses a card with no open PR without asking the lane", () => {
    withBash("verify_device_ondemand_work", { env: env({ PR_OBJ_STUB: "null" }) }, (r) => {
      assert.doesNotMatch(r.calls, /^device start/m);
      assert.match(notes(r)[0].body, /no open PR/);
      assert.ok(removed(r).length >= 1);
    });
  });

  it("takes the label off without a second run when one is already going for the head", () => {
    const body = [
      'mkdir -p "$REPO_ROOT/logs/factory/device"',
      `echo '{"inFlight":{"issue":7,"sha":"${HEAD}","runId":"r"}}' > "$REPO_ROOT/logs/factory/device/ledger.json"`,
      "verify_device_ondemand_work",
    ].join("\n");
    withBash(body, { env: env({ DEVICE_START_STUB: started }) }, (r) => {
      assert.doesNotMatch(r.calls, /^device start/m);
      assert.ok(removed(r).length >= 1);
      assert.match(r.log, /one is already going/);
    });
  });

  it("keeps the label, and records nothing, when the refusal can't be explained on the issue", () => {
    withBash(
      "verify_device_ondemand_work",
      { env: env({ PR_OBJ_STUB: "null", FAIL_COMMENT: "1" }) },
      (r) => {
        assert.equal(removed(r).length, 0);
        assert.equal(r.issue.deviceRunRequest ?? null, null);
        assert.match(r.log, /couldn't post why the on-demand device run can't start .*keeping/);
      },
    );
  });

  it("only takes a stuck label off, even after the PR head moved", () => {
    const state = { deviceRunRequest: `${OLD}:${DEVICE_RUN_ID}:label-stuck` };
    withBash(
      "verify_device_ondemand_work",
      { env: env({ DEVICE_START_STUB: started }), state },
      (r) => {
        assert.doesNotMatch(r.calls, /^device start/m, "no second run for the same label");
        assert.ok(removed(r).length >= 1);
        assert.equal(r.issue.deviceRunRequest, `${OLD}:${DEVICE_RUN_ID}`);
      },
    );
    // Once it came off, a label added again starts a new run.
    withBash(
      "verify_device_ondemand_work",
      {
        env: env({ DEVICE_START_STUB: started }),
        state: { deviceRunRequest: `${OLD}:${DEVICE_RUN_ID}` },
      },
      (r) => assert.match(r.calls, /^device start --issue 7 /m),
    );
  });

  it("doesn't count a stopping run for the head as the one the label asked for", () => {
    const body = [
      'mkdir -p "$REPO_ROOT/logs/factory/device"',
      `echo '{"inFlight":{"issue":7,"sha":"${HEAD}","runId":"r","stopping":{"reason":"feedback"}}}' > "$REPO_ROOT/logs/factory/device/ledger.json"`,
      "verify_device_ondemand_work",
    ].join("\n");
    withBash(
      body,
      { env: env({ DEVICE_START_STUB: '{"started":false,"reason":"deferred:busy"}' }) },
      (r) => {
        assert.doesNotMatch(r.log, /one is already going/);
        assert.match(
          r.calls,
          /^device start --issue 7 /m,
          "it asks the lane, which waits for the stop",
        );
        assert.equal(removed(r).length, 0, "the request is kept");
        assert.equal(r.issue.deviceRunRequest, `${HEAD}:waiting:deferred:busy`);
      },
    );
  });

  it("builds the OCR helper when an on-demand run starts", () => {
    const body = [
      'mkdir -p "$REPO_ROOT/apps/desktop/e2e/in-test/lib" "$REPO_ROOT/fakebin"',
      'echo "// ocr" > "$REPO_ROOT/apps/desktop/e2e/in-test/lib/ocr.swift"',
      `printf '#!/bin/sh\\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\\nprintf "#!/bin/sh\\\\n" > "$out"; chmod +x "$out"\\n' > "$REPO_ROOT/fakebin/swiftc"`,
      'chmod +x "$REPO_ROOT/fakebin/swiftc"',
      'PATH="$REPO_ROOT/fakebin:$PATH"',
      "verify_device_ondemand_work",
      'for _ in $(seq 1 100); do [[ -x "$LOG_DIR/bin/ocr" && ! -e "$LOG_DIR/bin/ocr.building" ]] && break; sleep 0.1; done',
      'test -x "$LOG_DIR/bin/ocr" && echo BUILT',
    ].join("\n");
    withBash(body, { env: env({ DEVICE_START_STUB: started }) }, (r) => {
      assert.match(r.stdout, /^BUILT$/m);
      assert.match(r.log, /Building the OCR helper .* in the background/);
    });
  });

  it("skips unlabelled, paused, interactive and support cards, and does nothing when the lane isn't built", () => {
    for (const labels of [
      ["status:in-test"],
      ["status:in-test", "factory-device-run", "factory-pause"],
      ["status:in-test", "factory-device-run", "driver:interactive"],
      ["status:in-test", "factory-device-run", "support"],
    ]) {
      const items = JSON.stringify([{ itemId: "ITEM", issueNumber: 7, labels }]);
      withBash(
        "verify_device_ondemand_work",
        { env: env({ TESTING_ITEMS: items, DEVICE_START_STUB: started }) },
        (r) => {
          assert.doesNotMatch(r.calls, /^device start/m, labels.join(","));
          assert.equal(removed(r).length, 0, labels.join(","));
        },
      );
    }
    withBash(
      "verify_device_ondemand_work",
      { env: env({ VERIFY_BUILT_LANES_STUB: "shell,browser", DEVICE_START_STUB: started }) },
      (r) => {
        assert.doesNotMatch(r.calls, /^project /m);
      },
    );
  });

  it("waits, keeping the label, on a transient failure or a failed PR lookup", () => {
    for (const reason of ["fetch-failed", "pr-unreadable", "start-failed", "abandoned", "error"]) {
      withBash(
        "verify_device_ondemand_work",
        { env: env({ DEVICE_START_STUB: `{"started":false,"reason":"${reason}"}` }) },
        (r) => {
          assert.equal(removed(r).length, 0, reason);
          assert.equal(notes(r).length, 0, reason);
          assert.equal(r.issue.deviceRunRequest, `${HEAD}:waiting:${reason}`);
        },
      );
    }
    withBash("verify_device_ondemand_work", { env: env({ FIND_PR_FAIL: "1" }) }, (r) => {
      assert.equal(notes(r).length, 0, "no 'no open PR' comment when GitHub failed");
      assert.equal(removed(r).length, 0);
    });
    // start exiting non-zero: one log line per head, the label stays.
    const twice = ["verify_device_ondemand_work", "verify_device_ondemand_work"].join("\n");
    withBash(twice, { env: env({ DEVICE_FAIL: "1" }) }, (r) => {
      assert.equal(removed(r).length, 0);
      assert.equal(r.issue.deviceRunRequest, `${HEAD}:waiting:start-error`);
      assert.equal(r.log.match(/waits \(start-error\)/g)?.length, 1);
    });
  });

  it("a label that wouldn't come off after a start only gets its removal retried", () => {
    const body = [
      "verify_device_ondemand_work",
      "unset FAIL_LABEL_EDIT",
      "verify_device_ondemand_work",
    ].join("\n");
    withBash(body, { env: env({ DEVICE_START_STUB: started, FAIL_LABEL_EDIT: "1" }) }, (r) => {
      assert.equal(r.calls.match(/^device start /gm)?.length, 1, "never a second forced run");
      assert.equal(r.issue.deviceRunRequest, `${HEAD}:${DEVICE_RUN_ID}`);
    });
  });

  it("leaves a Testing card to its verification round when that round runs the lane for the head", () => {
    const items = JSON.stringify([
      { itemId: "ITEM", issueNumber: 7, labels: ["status:testing", "factory-device-run"] },
    ]);
    withBash(
      "verify_device_ondemand_work",
      {
        env: env({ ...DEVICE_ON, TESTING_ITEMS: items, DEVICE_START_STUB: started }),
        state: { verifySha: HEAD, verifyDevice: `${HEAD}:deferred:beta-build` },
      },
      (r) => {
        assert.doesNotMatch(r.calls, /^device start/m);
        assert.ok(removed(r).length >= 1);
        assert.equal(r.issue.deviceRunRequest, `${HEAD}:round`);
      },
    );
    // A round whose lane already finished for the head: the operator wants another run.
    withBash(
      "verify_device_ondemand_work",
      {
        env: env({ ...DEVICE_ON, TESTING_ITEMS: items, DEVICE_START_STUB: started }),
        state: { verifySha: HEAD, verifyDevice: `${HEAD}:reported:fail` },
      },
      (r) => {
        assert.match(r.calls, /^device start --issue 7 .*--trigger on-demand --force-attempt/m);
      },
    );
  });

  it("says so once when an on-demand run is cut off without results", () => {
    const body = [
      'RUN_DIR="$REPO_ROOT/runs/od"',
      'mkdir -p "$RUN_DIR"',
      `echo '{"sha":"${HEAD}","pr":70,"runId":"${DEVICE_RUN_ID}","trigger":"on-demand","platforms":{}}' > "$RUN_DIR/device-output.json"`,
      `verify_device_collect 7 "$HEAD" "${DEVICE_RUN_ID}" "$RUN_DIR" stopped:feedback`,
      `verify_device_collect 7 "$HEAD" "${DEVICE_RUN_ID}" "$RUN_DIR" stopped:feedback`,
    ].join("\n");
    withBash(body, { env: env() }, (r) => {
      assert.equal(notes(r).length, 1);
      assert.match(notes(r)[0].body, /was cut off before it finished \(feedback\)/);
      assert.equal(r.issue.deviceReportPosted, `${HEAD}:${DEVICE_RUN_ID}:cut-off`);
    });
    // A Testing round's own run that was stopped says nothing (it is retried).
    const round = body.replace('"trigger":"on-demand"', '"trigger":"testing"');
    withBash(round, { env: env() }, (r) => {
      assert.equal(notes(r).length, 0);
    });
  });

  it("is called from --watch right after the In Test device pass, and the label is defined", () => {
    const pass = script.indexOf("\n  verify_device_intest_work\n", watchStart);
    const ondemand = script.indexOf("\n  verify_device_ondemand_work\n", watchStart);
    const candidates = script.indexOf("\n  browser_write_candidates\n", watchStart);
    assert.ok(pass !== -1 && ondemand > pass && candidates > ondemand);
    assert.equal(script.match(/\n  verify_device_ondemand_work\n/g)?.length, 1);
    // Also when the In Test board query fails: it runs its own queries.
    assert.match(
      script,
      /\n    verify_device_intest_work\n    verify_device_ondemand_work\n    log "WARNING: query-status-items 'In Test' failed/,
    );
    const labels = readFileSync(join(scriptsDir, "setup-factory-labels.sh"), "utf8");
    assert.match(labels, /^\s+"factory-device-run\|[0-9A-F]{6}\|/m);
  });
});
