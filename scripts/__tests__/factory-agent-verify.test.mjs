import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
//      its literal In Test move.
// Two layers, like the CodeRabbit lane's tests: static lock-ins over the
// source, and the real functions run in bash with gh, the board and the beta
// and scenario helpers stubbed (state-cli, verify-decide and verify-report are
// the real modules, on a temp state file).

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
];

const STUBS = `
LANE_START_DEFAULT='{"started":false,"reason":"busy"}'
LANE_STOP_DEFAULT='{"state":"idle"}'
LANE_HK_DEFAULT='{"state":"idle","reaped":{}}'
LANE_GAPS_DEFAULT='{"gaps":[],"bypassUsed":false}'
log() { echo "LOG: $*" >> "$LOG_FILE"; }
logerr() { echo "ERR: $*" >> "$LOG_FILE"; }
call() { printf '%s\\n' "$*" >> "$CALLS"; }
transition_status() { call "transition $3"; [[ "\${FAIL_TRANSITION:-}" != "$3" ]]; }
intest_check_lane_outcomes() { call "outcomes $*"; }
intest_dispatch_betas() { call "dispatch $1 $2 $3 $(echo "$4" | jq -c . 2>/dev/null || echo "$4")"; echo '{"dispatched":[],"skipped":[],"manualCommands":[]}'; }
intest_handoff() {
  call "handoff stage=\${INTEST_STAGE:-unset} cr_note=\${10:-}"
  call "handoff-platforms $(echo "$8" | jq -c . 2>/dev/null || echo "$8")"
}
fetch_issue_comments() { [[ -z "\${COMMENTS_FAIL:-}" ]] || return 1; cat "$COMMENTS_FILE"; }
find_prior_pr() { echo "\${PR_OBJ_STUB:-null}"; }
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
  esac
}
node() {
  case "$1" in
    */factory-project.mjs)
      call "project $2 $3 $4"
      case "$2" in
        has-status-option) [[ -z "\${NO_OPTION:-}" ]] ;;
        query-status-items) [[ -z "\${QUERY_FAIL:-}" ]] || return 1; echo "\${TESTING_ITEMS:-[]}" ;;
      esac
      ;;
    # dispatch-release.mjs is the real module: derive-platforms (and --verify)
    # reads the stubbed diff on stdin.
    */verify-report.mjs) [[ -z "\${REPORT_FAIL:-}" ]] || return 1; command node "$@" ;;
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
    "FACTORY_CR_CLI=${FACTORY_CR_CLI:-0}",
    "FACTORY_BROWSER=${FACTORY_BROWSER:-1}",
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
      /NOOP_TARGET="In Test"\n\s*if verify_target_status "\$ISSUE_NUM" "\$PRE_HEAD_OID" "\$ITEM_LABELS" \\\n\s*&& transition_status "\$ITEM_ID" "\$ISSUE_NUM" "Testing"; then\n\s*NOOP_TARGET="Testing"\n[\s\S]*?\n\s*else\n\s*transition_status "\$ITEM_ID" "\$ISSUE_NUM" "In Test" \|\| true\n\s*fi/,
    );
    assert.match(noopArm, /returned to \$NOOP_TARGET/);
    // The no-op path starts the commit's round itself, as verify_enter does, so
    // a round left in state can't read as "head moved" or an expired clock.
    assert.match(
      noopArm,
      /NOOP_TARGET="Testing"\n[\s\S]*?verify_begin_round "\$ISSUE_NUM" "\$PRE_HEAD_OID"[\s\S]*?\n\s*else\n/,
    );
  });

  it("reuses the In Test sweep's feedback filter rather than a copy", () => {
    const sweep = slice("  # ── In Test feedback sweep", "# ── --browser mode");
    assert.match(sweep, /if has_actionable_feedback "\$COMMENTS_JSON" "\$INTEST_HWM"; then/);
    assert.match(extract("verify_sweep_card"), /has_actionable_feedback "\$comments_json" "\$hwm"/);
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
});

describe("verify_sweep (real helper)", () => {
  const items = JSON.stringify([
    { itemId: "I9", issueNumber: 9, labels: [] },
    { itemId: "I8", issueNumber: 8, labels: ["factory-pause"] },
    { itemId: "I7", issueNumber: 7, labels: ["support"] },
    { itemId: "I3", issueNumber: 3, labels: [] },
  ]);
  const body = 'verify_sweep_card() { call "card $2"; }\nverify_sweep';

  it("visits cards oldest first, honouring factory-pause and support", () => {
    withBash(body, { env: { TESTING_ITEMS: items } }, (r) => {
      assert.deepEqual(
        r.calls.split("\n").filter((c) => c.startsWith("card ")),
        ["card 3", "card 9"],
      );
      assert.match(r.log, /#8: skipping \(factory-pause label set\)/);
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
      assert.deepEqual(JSON.parse(r.stdout), { shell: "reported:warn", browser: "none" });
    });
  });

  it("fills the placeholders: verification off, lane off, not built", () => {
    withBash(states(0), { env: { HEAD } }, (r) => {
      assert.deepEqual(JSON.parse(r.stdout), {
        shell: "skipped:verification-off",
        browser: "skipped:verification-off",
      });
    });
    withBash(states(1), { env: { HEAD, FACTORY_VERIFY_LANES: "shell" } }, (r) => {
      assert.deepEqual(JSON.parse(r.stdout), {
        shell: "skipped:not-built",
        browser: "skipped:lane-off",
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

  it("builds both lanes, so neither reads not-built with the script's own list", () => {
    const built = script.match(/^VERIFY_BUILT_LANES="([^"]*)"/m)?.[1];
    assert.equal(built, "shell,browser");
    // Both seams call both lanes, the shell lane first (it starts a detached
    // run; the browser lane only queues a candidate).
    const work = extract("verify_work_lanes");
    assert.ok(work.indexOf("verify_shell_work") < work.indexOf("verify_browser_work"));
    const stop = extract("verify_stop_lanes");
    assert.ok(stop.indexOf("verify_shell_stop") < stop.indexOf("verify_browser_stop"));
    const states = `verify_lane_states "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")" "$HEAD" 1`;
    withBash(states, { env: { HEAD, VERIFY_BUILT_LANES_STUB: built } }, (r) => {
      assert.deepEqual(JSON.parse(r.stdout), { shell: "none", browser: "none" });
    });
    // A lane switched off still reads lane-off, and one missing from the list
    // still reads not-built (the wording a future lane would get).
    withBash(states, { env: { HEAD, VERIFY_BUILT_LANES_STUB: "browser" } }, (r) => {
      assert.deepEqual(JSON.parse(r.stdout), { shell: "skipped:not-built", browser: "none" });
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
    assert.match(
      extract("verify_promote"),
      /verify_compose_report "\$issue_num" "\$pr_num" "\$head_sha" "\$VERIFY_LANE_PLATFORMS"/,
    );
  });
});
