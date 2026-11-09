import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// factory-agent.sh's side of the plan-stage browser probe (ADR-0071). The
// decisions live in scripts/lib/plan-probe.mjs (plan-probe.test.mjs); these pin
// where bash calls it and how plan_probe_browser_run drives the one browser
// runner for a probe.

const HERE = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(HERE, "..");
const scriptPath = resolve(scriptsDir, "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");

function extract(name) {
  const fn = script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(fn, `could not extract ${name}`);
  return fn[0];
}

const section = (from, to) => {
  const a = script.indexOf(from);
  assert.ok(a !== -1, from);
  const b = script.indexOf(to, a);
  assert.ok(b !== -1, to);
  return script.slice(a, b);
};

const PLAN = section('if [[ "$MODE_PLAN" -eq 1 ]]; then', "# ── --implement mode");
const READY = section(
  "# ── Orphaned-Planning rescue sweep",
  "# ── Plan Review sweep: in-place replan",
);
const REPLAN = section("# ── Plan Review sweep: in-place replan", "# ── --implement mode");
const BROWSER = section('\nif [[ "$MODE_BROWSER" -eq 1 ]]; then', "# ── --release mode");

const SHA = "c".repeat(40);
const PREVIEW = "https://drafto-probe-jakubanderwalds-projects.vercel.app";

describe("factory-agent.sh plan probe: knobs", () => {
  const block = script.match(
    /FACTORY_PLAN_PROBE="\$\{FACTORY_PLAN_PROBE:-0\}"[\s\S]*?FACTORY_PLAN_PROBE_MAX_FOLDS=2\n/,
  );
  const run = (env) => {
    assert.ok(block, "knob block");
    const r = spawnSync(
      "/bin/bash",
      [
        "-c",
        `set -euo pipefail\n${block[0]}\necho "P=$FACTORY_PLAN_PROBE S=$FACTORY_PLAN_PROBE_SPIKE R=$FACTORY_PLAN_PROBE_MAX_ROUNDS W=$FACTORY_PLAN_PROBE_PREVIEW_WAIT_MIN T=$FACTORY_PLAN_PROBE_TIMEOUT_SEC"`,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };

  it("is off by default, with spikes allowed, 2 rounds, a 15-min preview wait and a 900 s cap", () => {
    assert.equal(run({}), "P=0 S=1 R=2 W=15 T=900");
  });

  it("falls back on bad values: off, main only, the defaults", () => {
    assert.equal(
      run({
        FACTORY_PLAN_PROBE: "yes",
        FACTORY_PLAN_PROBE_SPIKE: "maybe",
        FACTORY_PLAN_PROBE_MAX_ROUNDS: "0",
        FACTORY_PLAN_PROBE_PREVIEW_WAIT_MIN: "x",
        FACTORY_PLAN_PROBE_TIMEOUT_SEC: "-1",
      }),
      "P=0 S=0 R=2 W=15 T=900",
    );
  });

  it("needs both the switch and the runner's plan kind", () => {
    const fn = extract("plan_probe_enabled");
    assert.match(fn, /\[\[ "\$FACTORY_PLAN_PROBE" == "1" \]\] && browser_kind_enabled plan/);
  });
});

describe("factory-agent.sh plan probe: --plan wiring", () => {
  it("runs housekeeping first, before the rescue sweep parks anything", () => {
    const hk = PLAN.indexOf("\n  plan_probe_housekeeping\n");
    assert.ok(hk !== -1);
    assert.ok(hk < PLAN.indexOf("# ── Orphaned-Planning rescue sweep"));
  });

  for (const [name, block] of [
    ["Ready sweep", READY],
    ["replan sweep", REPLAN],
  ]) {
    it(`${name}: prepares the probe, caps the planner per call, and settles the staging on every path`, () => {
      const prep = block.indexOf('plan_probe_prepare "$ISSUE_NUM" "$BUNDLE"');
      const call = block.indexOf(
        'CLAUDE_CALL_TIMEOUT_SEC="$PLAN_CALL_TIMEOUT" \\\n      node "$SCRIPT_DIR/lib/run-claude.mjs" -p',
      );
      assert.ok(prep !== -1 && call !== -1 && prep < call, "prepare, then the capped call");
      assert.match(
        block,
        /\[\[ \$EXIT_CODE -eq 0 \]\] \|\| plan_probe_finalize "\$ISSUE_NUM" discard/,
      );
      assert.match(
        block,
        /no well-formed summary line[^\n]*\n\s+plan_probe_finalize "\$ISSUE_NUM" discard/,
      );
      assert.match(
        block,
        /ACTION=\$\(echo "\$SUMMARY_LINE" \| sed -E 's\/\.\*action=\(\[\^ \]\+\)\.\*\/\\1\/'\)\n(?:\s+#[^\n]*\n)*\s+plan_probe_finalize "\$ISSUE_NUM" "\$ACTION"/,
      );
      assert.match(block, /claude timed out \(>\$\{PLAN_CALL_TIMEOUT\}s\)/);
    });
  }

  it("replans for a probe result with no comment to answer, and counts the fold before the run", () => {
    assert.match(
      REPLAN,
      /PROBE_FOLD_JSON=\$\(plan_probe_fold_due "\$ISSUE_NUM" "\$COMMENTS_JSON"\)/,
    );
    assert.match(
      REPLAN,
      /if \[\[ "\$UNACKED_COUNT" -eq 0 && "\$PROBE_FOLD_JSON" == "null" \]\]; then\n\s+continue/,
    );
    const begin = REPLAN.indexOf("plan_probe fold-begin");
    const call = REPLAN.indexOf("lib/run-claude.mjs");
    const reply = REPLAN.indexOf('plan_reply_check "$ISSUE_NUM" "$PLAN_REPLY_MARKERS"\n');
    const end = REPLAN.indexOf("plan_probe_fold_end");
    assert.ok(begin < call && call < reply && reply < end, "fold-begin, run, replies, fold-end");
    assert.match(REPLAN, /plan_probe_prepare "\$ISSUE_NUM" "\$BUNDLE" "\$PROBE_FOLD_JSON"/);
  });
});

describe("factory-agent.sh plan probe: --browser wiring", () => {
  it("counts plan in the early exit and lists probes from the state, last", () => {
    assert.match(
      BROWSER,
      /! browser_kind_enabled verify && ! browser_kind_enabled intest && ! plan_probe_enabled/,
    );
    const fileList = BROWSER.indexOf("BROWSER_LIST=$( { grep -E");
    const planList = BROWSER.indexOf("plan_probe candidates");
    const empty = BROWSER.indexOf('if [[ -z "$BROWSER_LIST" ]]; then');
    assert.ok(
      fileList < planList && planList < empty,
      "file candidates, then probes, then the empty check",
    );
    assert.match(BROWSER, /grep -E '\^plan:\[0-9\]\+:0:\[0-9a-f\]\{40\}\$'/);
  });

  it("re-checks a probe's card against Plan Review and runs it through plan_probe_browser_run", () => {
    assert.match(BROWSER, /plan:\*\) BROWSER_KIND=plan; BROWSER_COLUMN="Plan Review"/);
    assert.match(BROWSER, /query-status-items \\\n\s*--status "Plan Review"/);
    assert.match(
      BROWSER,
      /if \[\[ "\$BROWSER_KIND" == plan \]\]; then\n\s+plan_probe_browser_run "\$BROWSER_ISSUE" "\$\{BROWSER_CAND##\*:\}" \|\| BROWSER_RC=\$\?/,
    );
  });

  it("never touches the PR kinds' browser keys", () => {
    const fn = extract("plan_probe_browser_run");
    assert.doesNotMatch(
      fn,
      /browserRunSha|browserRunAttempts|browser_claim_sha|browser_refund_attempt/,
    );
  });
});

// ── plan_probe_browser_run, extracted and run with stubs ────────────────────

function runProbe({
  status = "queued",
  stateSha = SHA,
  remote = SHA,
  preview = { state: "ready", url: PREVIEW, waitedMin: 3 },
  attempts = "",
  preflight = "ok",
  mint = "ok",
  taskResult = "ran",
  render = "ok",
  dryRun = 0,
  headersExist = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plan-probe-run-"));
  try {
    const stateFile = join(dir, "state.json");
    const probeId = "492-1762682400";
    const root = join(dir, "plan-probe");
    mkdirSync(join(root, probeId), { recursive: true });
    writeFileSync(join(root, probeId, "checks.md"), "1. Open /login. Expect the form.\n");
    if (headersExist) writeFileSync(join(root, probeId, "headers.json"), "{}");
    writeFileSync(
      stateFile,
      JSON.stringify({
        issues: {
          492: {
            planProbeStatus: status,
            planProbeSha: stateSha,
            planProbeId: probeId,
            planProbeAttempts: attempts,
            browserRunSha: "keep",
            browserRunAttempts: "keep:1",
          },
        },
      }),
    );
    const calls = join(dir, "calls.txt");
    const snippet = `set -euo pipefail
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
LOG_DIR=${JSON.stringify(dir)}
STATE_FILE=${JSON.stringify(stateFile)}
SCRIPT_DIR=${JSON.stringify(scriptsDir)}
REPO_ROOT=${JSON.stringify(dir)}
PLAN_PROBE_ROOT=${JSON.stringify(root)}
DRY_RUN=${dryRun}
FACTORY_PLAN_PROBE_PREVIEW_WAIT_MIN=15
FACTORY_PLAN_PROBE_MAX_ATTEMPTS=2
FACTORY_VERIFY_BYPASS_FILE=/nonexistent/bypass.env
FACTORY_BROWSER_ACCOUNT_FILE=/nonexistent/account.env
FACTORY_BROWSER_SIGNIN_KEY_FILE=/nonexistent/key.env
FACTORY_BROWSER_DEVICE_ID=9796912b-8977-4d74-9c08-d9bb283b9496
FACTORY_SIGNIN_LEASE_SEC=300
SIGNIN_LEASE_FILE=${JSON.stringify(join(dir, "lease"))}
BROWSER_SIGNIN_LEASE_OWNER=""
BROWSER_PREFLIGHT_FAILED=""
c() { echo "$*" >>${JSON.stringify(calls)}; }
log() { echo "[log] $*"; }
pause_for_session_limit() { c "PAUSED"; }
fetch_issue_record() { echo '{"number":492,"title":"t"}'; }
browser_record_result() { c "health $1"; }
browser_signin_release() { c "release"; BROWSER_SIGNIN_LEASE_OWNER=""; }
plan_probe_end() { c "end $*"; }
git() { c "git $*"; printf '%s\\trefs/heads/factory/plan-probe-492\\n' ${JSON.stringify(remote)}; }
run_browser_task() {
  c "task $1 $3 signin=$(printf '%s' "$4" | jq -r '.account.signInUrl') checks=$(printf '%s' "$4" | jq -r '.checks != null')"
  mkdir -p "$2"; BROWSER_OUT="$2/out.txt"; : >"$BROWSER_OUT"
  BROWSER_RESULT=${JSON.stringify(taskResult)}
}
node() {
  case "$1" in
    */state-cli.mjs) command node "$@" ;;
    */plan-probe.mjs)
      c "probe $2 $(printf '%s ' "\${@:3}")"
      case "$2" in
        preview-state) echo ${JSON.stringify(JSON.stringify(preview))} ;;
        *) echo '{}' ;;
      esac ;;
    */browser-health.mjs) c "preflight"; echo ${JSON.stringify(preflight)}; [[ ${JSON.stringify(preflight)} == ok ]] ;;
    */factory-bundle.mjs)
      c "bundle $(jq -c '{runKind, checks: (.checks|length > 0), probeId, headSha}')"
      echo '{"checks":{"checksEnveloped":"<plan-checks>1.</plan-checks>"},"account":{}}' ;;
    */browser-signin.mjs)
      c "signin $2 $(printf '%s ' "\${@:3}")"
      [[ "$2" == mint ]] || return 0
      case ${JSON.stringify(mint)} in
        ok) echo "${PREVIEW}/auth/test-sign-in?token_hash=t" ;;
        busy) echo '{"owner":"shell","until":"x"}'; return 3 ;;
        *) return 1 ;;
      esac ;;
    */browser-report.mjs)
      c "render $(printf '%s ' "\${@:2}")"
      echo '{"status":"${render}","verdict":"pass"}' ;;
    *) c "UNSTUBBED node $*"; return 99 ;;
  esac
}
${extract("plan_probe")}
${extract("plan_probe_browser_run")}
rc=0
plan_probe_browser_run 492 ${SHA} || rc=$?
echo "rc=$rc"
`;
    const r = spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8" });
    const callLog = existsSync(calls) ? readFileSync(calls, "utf8") : "";
    const finalState = JSON.parse(readFileSync(stateFile, "utf8")).issues["492"];
    return { r, callLog, finalState, rc: /rc=(\d+)/.exec(r.stdout)?.[1] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("plan_probe_browser_run (extracted, stubbed)", () => {
  it("captures headers, then runs the checks through the runner's plan kind and ends the round", () => {
    const { r, callLog, rc, finalState } = runProbe();
    assert.equal(rc, "0", r.stdout + r.stderr);
    assert.match(
      callLog,
      /probe capture-headers --issue 492 [^\n]*--origin https:\/\/drafto-probe/,
    );
    assert.match(
      callLog,
      /bundle \{"runKind":"plan","checks":true,"probeId":"492-1762682400","headSha":"c{40}"\}/,
    );
    assert.match(callLog, /signin mint [^\n]*--owner browser:plan:492:c{12} /);
    assert.match(callLog, /task plan https:\/\/drafto-probe[^ ]* signin=https:[^ ]+ checks=true/);
    assert.match(callLog, /render --kind plan /);
    assert.match(callLog, /health ok/);
    assert.match(
      callLog,
      /end 492 reported --browser ok --verdict pass --run-dir \S+ --section \S+section\.md/,
    );
    // The PR kinds' keys are untouched.
    assert.equal(finalState.browserRunSha, "keep");
    assert.equal(finalState.browserRunAttempts, "keep:1");
    // Headers come before Chrome: the order of the calls.
    assert.ok(callLog.indexOf("capture-headers") < callLog.indexOf("preflight"));
  });

  it("doesn't capture headers twice", () => {
    const { callLog } = runProbe({ headersExist: true });
    assert.doesNotMatch(callLog, /capture-headers/);
  });

  it("skips a probe that isn't queued for this commit", () => {
    for (const opts of [{ status: "reported" }, { stateSha: "d".repeat(40) }]) {
      const { rc, callLog } = runProbe(opts);
      assert.equal(rc, "1");
      assert.equal(callLog, "");
    }
  });

  it("ends the round when the branch no longer points at the probe commit", () => {
    const { rc, callLog } = runProbe({ remote: "e".repeat(40) });
    assert.equal(rc, "1");
    assert.match(callLog, /end 492 failed:branch-moved/);
    assert.doesNotMatch(callLog, /task /);
  });

  it("ends a failed build, waits for a pending preview, and gives up past the wait", () => {
    assert.match(
      runProbe({ preview: { state: "failed", reason: "build", waitedMin: 4 } }).callLog,
      /end 492 failed:build/,
    );
    const waiting = runProbe({ preview: { state: "pending", waitedMin: 5 } });
    assert.equal(waiting.rc, "1");
    assert.doesNotMatch(waiting.callLog, /end 492/);
    assert.match(
      runProbe({ preview: { state: "pending", waitedMin: 15 } }).callLog,
      /end 492 failed:no-preview/,
    );
    // A build Vercel has started gets three times the wait.
    assert.doesNotMatch(
      runProbe({ preview: { state: "building", waitedMin: 30 } }).callLog,
      /end 492/,
    );
    assert.match(
      runProbe({ preview: { state: "building", waitedMin: 45 } }).callLog,
      /end 492 failed:no-preview/,
    );
  });

  it("stops the tick on a failed preflight, with a health record and no session", () => {
    const { rc, callLog } = runProbe({ preflight: "chrome-not-running" });
    assert.equal(rc, "2");
    assert.match(callLog, /health preflight:chrome-not-running/);
    assert.doesNotMatch(callLog, /task /);
  });

  it("defers while the sign-in lease is held, spending nothing", () => {
    const { rc, callLog } = runProbe({ mint: "busy" });
    assert.equal(rc, "2");
    assert.doesNotMatch(callLog, /probe attempt/);
    assert.doesNotMatch(callLog, /task /);
  });

  it("refunds an unavailable browser and retries later", () => {
    const { rc, callLog } = runProbe({ render: "unavailable" });
    assert.equal(rc, "2");
    assert.match(callLog, /probe attempt --issue 492 --op bump/);
    assert.match(callLog, /probe attempt --issue 492 --op refund/);
    assert.match(callLog, /health unavailable/);
    assert.doesNotMatch(callLog, /end 492/);
  });

  it("reports a sign-in a spike broke as the probe's result, not the browser's health", () => {
    const { rc, callLog } = runProbe({ render: "signin-failed" });
    assert.equal(rc, "0");
    assert.doesNotMatch(callLog, /health signin-failed/);
    assert.match(callLog, /end 492 reported --browser signin-failed/);
  });

  it("ends the round as failed:runner once its attempts are spent", () => {
    const spent = runProbe({ attempts: `${SHA}:2` });
    assert.equal(spent.rc, "1");
    assert.match(spent.callLog, /end 492 failed:runner/);
    const timedOut = runProbe({ attempts: `${SHA}:1`, taskResult: "timeout" });
    assert.equal(timedOut.rc, "2");
    assert.match(timedOut.callLog, /health timeout/);
    assert.match(timedOut.callLog, /end 492 failed:runner --run-dir/);
  });

  it("pauses on a session limit and gives the attempt back", () => {
    const { rc, callLog } = runProbe({ taskResult: "session-limit" });
    assert.equal(rc, "2");
    assert.match(callLog, /PAUSED/);
    assert.match(callLog, /--op refund/);
  });

  it("does nothing but log in a dry run", () => {
    const { rc, callLog, r } = runProbe({ dryRun: 1 });
    assert.equal(rc, "0");
    assert.match(r.stdout, /DRY-RUN: would run #492's plan probe checks/);
    assert.doesNotMatch(callLog, /capture-headers|signin mint|task /);
  });
});

describe("plan_probe_housekeeping (extracted, stubbed)", () => {
  function run(board, { enabled = true, state = null } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "plan-probe-hk-"));
    try {
      const calls = join(dir, "calls.txt");
      if (state) writeFileSync(join(dir, "state.json"), JSON.stringify(state));
      const snippet = `set -euo pipefail
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
STATE_FILE=${JSON.stringify(join(dir, "state.json"))}
SCRIPT_DIR=${JSON.stringify(scriptsDir)}
REPO_ROOT=${JSON.stringify(dir)}
PLAN_PROBE_ROOT=${JSON.stringify(join(dir, "pp"))}
DRY_RUN=0
log() { echo "[log] $*"; }
plan_probe_enabled() { return ${enabled ? 0 : 1}; }
plan_probe_post() { echo "post $1" >>${JSON.stringify(calls)}; }
node() {
  case "$1" in
    */factory-project.mjs)
      case ${JSON.stringify(board)} in
        fail) return 1 ;;
        empty) return 0 ;;
        *) [[ "$4" == "Plan Review" ]] && echo '[{"issueNumber":492}]' || echo '[]' ;;
      esac ;;
    */plan-probe.mjs)
      echo "probe $(printf '%s ' "\${@:2}")" >>${JSON.stringify(calls)}
      echo '{"actions":[{"issue":"7","action":"failed:expired","post":true},{"issue":"8","action":"cancelled:off","post":false}]}' ;;
  esac
}
${extract("plan_probe")}
${extract("plan_probe_housekeeping")}
plan_probe_housekeeping
`;
      const r = spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return existsSync(calls) ? readFileSync(calls, "utf8") : "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("hands the board's Plan Review and Planning cards over, and posts what needs a report", () => {
    const log = run("ok");
    assert.match(
      log,
      /probe housekeeping [^\n]*--plan-review 492 --planning {2}--enabled 1 --boards-ok 1/,
    );
    assert.match(log, /^post 7$/m);
    assert.doesNotMatch(log, /^post 8$/m);
  });

  it("marks the board unread when a query fails or answers nothing, so no probe is cancelled for it", () => {
    for (const board of ["fail", "empty"]) {
      assert.match(run(board), /--plan-review {2}--planning {2}--enabled 1 --boards-ok 0/, board);
    }
  });

  it("costs nothing while the probe is off and no probe is on record", () => {
    assert.equal(run("ok", { enabled: false }), "");
    assert.equal(run("ok", { enabled: false, state: { issues: { 1: { attempts: 0 } } } }), "");
    // Off, but a probe on record still gets ended and its branch reaped.
    const log = run("ok", {
      enabled: false,
      state: { issues: { 7: { planProbeId: "7-1762600000", planProbeStatus: "queued" } } },
    });
    assert.match(log, /--enabled 0 --boards-ok 1/);
  });
});
