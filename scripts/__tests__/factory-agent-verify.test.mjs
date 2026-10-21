import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
];

const STUBS = `
log() { echo "LOG: $*" >> "$LOG_FILE"; }
logerr() { echo "ERR: $*" >> "$LOG_FILE"; }
call() { printf '%s\\n' "$*" >> "$CALLS"; }
transition_status() { call "transition $3"; [[ "\${FAIL_TRANSITION:-}" != "$3" ]]; }
intest_check_lane_outcomes() { call "outcomes $*"; }
intest_dispatch_betas() { call "dispatch $*"; echo '{"dispatched":[],"skipped":[],"manualCommands":[]}'; }
intest_handoff() { call "handoff stage=\${INTEST_STAGE:-unset} cr_note=\${10:-}"; }
fetch_issue_comments() { [[ -z "\${COMMENTS_FAIL:-}" ]] || return 1; cat "$COMMENTS_FILE"; }
find_prior_pr() { echo "\${PR_OBJ_STUB:-null}"; }
fetch_review_threads() { [[ -z "\${THREADS_FAIL:-}" ]] || return 1; echo "\${THREADS_STUB:-[]}"; }
cr_coverage_note() { echo "\${CR_NOTE_STUB:-}"; }
gh() {
  call "gh $*"
  case "$1 $2" in
    "pr view") echo "$PR_VIEW_STUB" ;;
    "pr diff") [[ -z "\${DIFF_FAIL:-}" ]] || return 1; printf 'apps/web/a.ts\\n' ;;
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
    */dispatch-release.mjs) cat > /dev/null; echo '{"web":true,"mobile":false,"desktop":false}' ;;
    */verify-report.mjs) [[ -z "\${REPORT_FAIL:-}" ]] || return 1; command node "$@" ;;
    *) command node "$@" ;;
  esac
}
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
    `LOG_DIR="${dir}"`,
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
    "REQUIRED_CONTEXTS_JSON='[\"Lint\"]'",
    "VERIFY_REPORT_POST_MAX=3",
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
    const stateOut = JSON.parse(read(files.state) || "{}");
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
      /NOOP_TARGET="In Test"\n\s*if verify_target_status "\$ISSUE_NUM" "\$PRE_HEAD_OID" "\$ITEM_LABELS" \\\n\s*&& transition_status "\$ITEM_ID" "\$ISSUE_NUM" "Testing"; then\n\s*NOOP_TARGET="Testing"\n\s*else\n\s*transition_status "\$ITEM_ID" "\$ISSUE_NUM" "In Test" \|\| true\n\s*fi/,
    );
    assert.match(noopArm, /returned to \$NOOP_TARGET/);
  });

  it("reuses the In Test sweep's feedback filter rather than a copy", () => {
    const sweep = slice("  # ── In Test feedback sweep", "# ── --browser mode");
    assert.match(sweep, /if has_actionable_feedback "\$COMMENTS_JSON" "\$INTEST_HWM"; then/);
    assert.match(extract("verify_sweep_card"), /has_actionable_feedback "\$comments_json" "\$hwm"/);
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
    /FACTORY_VERIFY="\$\{FACTORY_VERIFY:-0\}"[\s\S]*?VERIFY_REPORT_POST_MAX=3\n/,
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
    'if verify_target_status 7 "$HEAD" "$LABELS"; then echo "RC=0 $VERIFY_TARGET"; else echo "RC=1 $VERIFY_TARGET"; fi';

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
    withBash(back("head-moved"), { env: { HEAD }, state: { verifyBounces: `${OLD}:2` } }, (r) => {
      assert.equal(r.issue.verifyBounces, `${HEAD}:1`);
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
  const retry = `${BODY_SETUP}\nverify_report_retry 7 "$HEAD" "$(node "$SCRIPT_DIR/lib/state-cli.mjs" factory:get-issue 7 --state-file "$STATE_FILE")"`;
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
      { env: { HEAD, FAIL_COMMENT: "1" }, state: { verifyReportPosts: `${HEAD}:2` } },
      (r) => {
        assert.equal(r.issue.verifyReportPosts, `${HEAD}:3`);
        assert.match(r.log, /giving up on posting #7's verification report/);
      },
    );
    withBash(retry, { env: { HEAD }, state: { verifyReportPosts: `${HEAD}:3` } }, (r) => {
      assert.equal(r.calls, "", "spent: not even a comment fetch");
      assert.equal(r.comments.length, 0);
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
        assert.doesNotMatch(r.calls, /fetch_review_threads|has-status-option/);
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
