import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Guards the session-limit pause wiring added after issue #463 burned all 5 of
// its implement retries against a limit that hadn't reset. A claude call that
// dies on a session/usage limit must pause the factory until reset (via
// factory:pause-until) instead of bumping the per-issue attempts counter.
//
// Two layers, matching factory-agent-install.test.mjs:
//   1. static lock-ins over the script source (branch structure), and
//   2. an extracted-bash-function harness that runs the real helpers with
//      node/log/jq stubbed.

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");

describe("factory-agent session-limit pause: static wiring (#463)", () => {
  it("defines both helpers and the fallback knob", () => {
    assert.match(script, /^check_session_limit\(\) \{/m, "check helper must exist");
    assert.match(script, /^pause_for_session_limit\(\) \{/m, "pause helper must exist");
    assert.match(
      script,
      /FACTORY_LIMIT_FALLBACK_MIN="\$\{FACTORY_LIMIT_FALLBACK_MIN:-30\}"/,
      "fallback-minutes knob must exist with a 30-minute default",
    );
  });

  it("check_session_limit invokes session-limit.mjs with --since and --fallback-min", () => {
    const fn = script.match(/check_session_limit\(\) \{[\s\S]*?\n\}/);
    assert.ok(fn, "could not extract check_session_limit");
    assert.match(fn[0], /session-limit\.mjs" check --cwd "\$cwd" --since "\$since"/);
    assert.match(fn[0], /--fallback-min "\$FACTORY_LIMIT_FALLBACK_MIN"/);
    // Fail-open: a non-zero CLI exit must short-circuit to the normal path.
    assert.match(fn[0], /\|\| return 1/);
  });

  it("pause_for_session_limit pauses until reset and never bumps attempts", () => {
    const fn = script.match(/pause_for_session_limit\(\) \{[\s\S]*?\n\}/);
    assert.ok(fn, "could not extract pause_for_session_limit");
    assert.match(fn[0], /factory:pause-until "\$SESSION_LIMIT_RESET_AT"/);
    assert.doesNotMatch(fn[0], /bump-attempts/, "the pause path must not bump attempts");
  });

  it("captures CLAUDE_START_ISO and checks the limit at all four claude call sites", () => {
    const starts = script.match(/CLAUDE_START_ISO=\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)/g) || [];
    assert.equal(starts.length, 4, "one start-timestamp capture per claude invocation");
    const checks =
      script.match(/check_session_limit "\$(?:REPO_ROOT|WT_PATH)" "\$CLAUDE_START_ISO"/g) || [];
    assert.equal(checks.length, 4, "one limit check per failure branch");
  });

  it("runs the limit check BEFORE bumping attempts in every failure branch", () => {
    // Each failure branch is the span from its `claude exited` log line to the
    // `factory:bump-attempts` in that branch; the check must appear inside it.
    const branches = [
      /claude exited non-zero \(\$EXIT_CODE\) for #\$ISSUE_NUM --plan"[\s\S]*?factory:bump-attempts "\$ISSUE_NUM"/,
      /claude exited non-zero \(\$EXIT_CODE\) for #\$ISSUE_NUM --plan replan"[\s\S]*?factory:bump-attempts "\$ISSUE_NUM"/,
      /claude exited non-zero \(\$EXIT_CODE\) for #\$ISSUE_NUM --implement"[\s\S]*?factory:bump-attempts "\$ISSUE_NUM"/,
    ];
    for (const re of branches) {
      const block = script.match(re);
      assert.ok(block, `branch not found: ${re}`);
      assert.match(
        block[0],
        /check_session_limit /,
        "check must precede bump-attempts in the branch",
      );
    }
  });

  it("gates the watch-fix check on a non-timeout exit (124 is a genuine timeout)", () => {
    assert.match(
      script,
      /if \[\[ \$EXIT_CODE -ne 124 \]\] && check_session_limit "\$WT_PATH" "\$CLAUDE_START_ISO"; then/,
      "the watch branch mixes timeout + failure; a 124 must not be read as a limit",
    );
  });

  it("exits 0 on a detected limit so the failure trap files no bogus issue", () => {
    // Every pause_for_session_limit call must be immediately followed by a
    // completed-log line and `exit 0` (not `continue`, which would fall
    // through, and not a non-zero exit, which the cleanup trap treats as a
    // fault).
    const spans = script.match(/pause_for_session_limit\n[\s\S]{0,200}?exit 0/g) || [];
    assert.equal(spans.length, 4, "each pause site must exit 0 right after pausing");
  });
});

describe("check_session_limit / pause_for_session_limit (real helpers, stubbed node)", () => {
  function extract(name) {
    const fn = script.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(fn, `could not extract ${name}`);
    return fn[0];
  }

  // Runs both helpers in a bash harness. `limitStub` decides what the stubbed
  // `node session-limit.mjs` call prints + returns. Returns { status, stdout,
  // calls } where `calls` is every stubbed state-cli.mjs invocation.
  function runHarness({ limited }) {
    const dir = mkdtempSync(join(tmpdir(), "factory-limit-"));
    const callsLog = join(dir, "calls.log");
    try {
      const limitStub = limited
        ? `echo '{"limited":true,"resetAt":"2026-07-21T08:32:00Z","reason":"You'"'"'ve hit your session limit"}'`
        : `return 1`;
      const harness = [
        "set -uo pipefail",
        `SCRIPT_DIR="/stub"`,
        `LOG_FILE=/dev/null`,
        `STATE_FILE="${join(dir, "state.json")}"`,
        `FACTORY_LIMIT_FALLBACK_MIN=30`,
        `CALLS_LOG="${callsLog}"`,
        "log() { :; }",
        "node() {",
        '  case "$*" in',
        `    *session-limit.mjs*) ${limitStub} ;;`,
        `    *state-cli.mjs*) echo "$*" >> "$CALLS_LOG" ;;`,
        "  esac",
        "}",
        extract("check_session_limit"),
        extract("pause_for_session_limit"),
        // Drive both helpers exactly as the script does.
        'if check_session_limit "/some/cwd" "2026-07-21T08:00:00Z"; then',
        '  echo "CHECK=ok RESET=$SESSION_LIMIT_RESET_AT"',
        "  pause_for_session_limit",
        "else",
        '  echo "CHECK=fail"',
        "fi",
      ].join("\n");
      const res = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
      let calls = "";
      try {
        calls = readFileSync(callsLog, "utf8");
      } catch {
        calls = "";
      }
      return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("on a limit: sets the reset time and calls factory:pause-until, not bump-attempts", () => {
    const r = runHarness({ limited: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CHECK=ok RESET=2026-07-21T08:32:00Z/);
    assert.match(r.calls, /factory:pause-until 2026-07-21T08:32:00Z/);
    assert.doesNotMatch(r.calls, /bump-attempts/);
  });

  it("when session-limit.mjs reports no limit: check returns non-zero, no pause", () => {
    const r = runHarness({ limited: false });
    assert.match(r.stdout, /CHECK=fail/);
    assert.doesNotMatch(r.calls, /factory:pause-until/);
  });
});
