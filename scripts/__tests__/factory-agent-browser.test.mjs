import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The browser runner's bash wiring (ADR-0051). The guard, the report scanner and
// the health tracker are tested in their own files; what factory-agent.sh must
// guarantee is narrower, and is what these tests lock in:
//   1. Chrome reaches exactly ONE claude call — the locked-down runner — and
//      every other call in the factory, support agent and nightly runner
//      passes --no-chrome explicitly (claudeInChromeDefaultEnabled is on on
//      the Mac mini, so leaving it implicit is a bet on CLI defaults);
//   2. the runner is dontAsk with no built-in tools, a generated --settings
//      guard, a pinned session id, and its prompt on stdin (it carries a
//      password), and a guard that never loaded turns the runner off;
//   3. the knobs are off by default and validated under bash 3.2;
//   4. the In Test web run is once per head SHA, bounded per SHA, waits for
//      the scenario and the per-commit preview, never moves the card, and only
//      posts what browser-report.mjs rendered.
//
// Two layers, like factory-agent-cr-cli.test.mjs: static lock-ins over the
// script source, and the real functions run in bash with node and gh stubbed.

const HERE = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(HERE, "..");
const scriptPath = resolve(scriptsDir, "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");
const supportScript = readFileSync(resolve(scriptsDir, "support-agent.sh"), "utf8");
const nightlyScript = readFileSync(resolve(scriptsDir, "nightly-support.sh"), "utf8");

function extract(name) {
  const fn = script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(fn, `could not extract ${name}`);
  return fn[0];
}

// Each `node .../run-claude.mjs` invocation, with its continuation lines, so a
// flag on the second line of a call still counts as part of it.
function claudeCalls(source) {
  const lines = source.split("\n");
  const calls = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/run-claude\.mjs" -p\b/.test(lines[i])) continue;
    let call = lines[i];
    let j = i;
    while (/\\\s*$/.test(lines[j]) && j + 1 < lines.length) {
      j += 1;
      call += "\n" + lines[j];
    }
    calls.push(call);
  }
  return calls;
}

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

describe("factory-agent.sh browser runner: static wiring", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("gives Chrome to exactly one claude call and --no-chrome to every other one", () => {
    const calls = claudeCalls(script);
    assert.equal(calls.length, 7, "six stage calls plus the browser runner");
    const chrome = calls.filter((c) => /\s--chrome\b/.test(c));
    const noChrome = calls.filter((c) => /\s--no-chrome\b/.test(c));
    assert.equal(chrome.length, 1, "only run_browser_task may pass --chrome");
    assert.equal(noChrome.length, 6, "every stage call must pass --no-chrome explicitly");
    // --no-chrome sits AFTER --effort so factory-agent-effort.test.mjs's
    // `--dangerously-skip-permissions --effort "$X"` counts keep holding.
    for (const c of noChrome) {
      assert.match(c, /--effort "\$FACTORY(_PLAN)?_EFFORT" --no-chrome/);
    }
  });

  it("locks the runner call down", () => {
    const [runner] = claudeCalls(script).filter((c) => /\s--chrome\b/.test(c));
    assert.match(runner, /--permission-mode dontAsk/);
    assert.match(runner, /--tools ""/, "no built-in tools: no Bash, files, gh or subagents");
    assert.match(runner, /--allowedTools "\$allowed"/);
    assert.match(runner, /--settings "\$settings"/);
    // Nothing but the prompt and the guard reach the runner: no user/project
    // settings (plugins, hooks, the operator's CLAUDE.md) and no MCP server
    // but the built-in claude-in-chrome (no Gmail or Drive connectors).
    assert.match(runner, /--setting-sources ""/);
    assert.match(runner, /--strict-mcp-config/);
    assert.match(runner, /--session-id "\$uuid"/);
    assert.match(runner, /--effort "\$FACTORY_PLAN_EFFORT"/);
    assert.doesNotMatch(runner, /dangerously-skip-permissions/);
    // The prompt (and the password in it) goes in on stdin, never argv.
    assert.match(runner, /run-claude\.mjs" -p --chrome/);
    assert.match(
      extract("run_browser_task"),
      /printf '%s' "\$input" \| CLAUDE_CALL_TIMEOUT_SEC="\$FACTORY_BROWSER_TIMEOUT_SEC" \\\n\s+node "\$SCRIPT_DIR\/lib\/run-claude\.mjs" -p --chrome/,
    );
  });

  it("passes --no-chrome on every support-agent and nightly-support call", () => {
    for (const [name, source, n] of [
      ["support-agent.sh", supportScript, 3],
      ["nightly-support.sh", nightlyScript, 2],
    ]) {
      const calls = claudeCalls(source);
      assert.equal(calls.length, n, `${name} call count`);
      for (const c of calls) {
        assert.match(c, /--no-chrome/, `${name}: ${c.split("\n")[0]}`);
        assert.doesNotMatch(c, /\s--chrome\b/, name);
      }
    }
  });

  it("marks the deterministic fallback scenario so the runner never runs it", () => {
    const fallback = extract("intest_fallback_comment");
    assert.match(fallback, /<!-- drafto-factory-scenario-fallback -->/);
  });

  it("has --watch collect In Test candidates and hand them to --browser", () => {
    const modeStart = (m) => script.indexOf(`\nif [[ "$MODE_${m}" -eq 1 ]]; then`);
    const watchStart = modeStart("WATCH");
    const browserStart = modeStart("BROWSER");
    const releaseStart = modeStart("RELEASE");
    assert.ok(watchStart !== -1 && browserStart > watchStart && releaseStart > browserStart);
    const watch = script.slice(watchStart, browserStart);
    const sweepAt = watch.indexOf("# ── In Test feedback sweep");
    // Cleared BEFORE the sweep's first query, so a sweep that bails out early
    // never leaves --browser last tick's list.
    const clearAt = watch.indexOf(': >"$BROWSER_CANDIDATES_FILE"');
    assert.ok(clearAt !== -1 && clearAt < sweepAt, "the list is cleared before the sweep");
    assert.match(
      watch,
      /browser_kind_enabled intest && \[\[ "\$INTEST_PENDING_FEEDBACK" -eq 0 \]\]/,
      "a card about to roll back to In Progress is never a candidate",
    );
    assert.match(watch, /\.web \/\/ false/);
    assert.match(watch, /mv "\$BROWSER_CANDIDATES_FILE\.tmp" "\$BROWSER_CANDIDATES_FILE"/);
    assert.doesNotMatch(watch, /intest_browser_run "/, "--watch never runs the browser itself");
  });

  it("runs at most one candidate in --browser, re-checked against the board", () => {
    const start = script.indexOf('\nif [[ "$MODE_BROWSER" -eq 1 ]]; then');
    const block = script.slice(start, script.indexOf("# ── --release mode", start));
    assert.match(block, /browser_kind_enabled intest/);
    assert.match(block, /-mmin \+10/, "a stale list is ignored");
    assert.match(block, /\^\[0-9\]\+:\[0-9\]\+:\[0-9a-f\]\{40\}\$/, "only well-formed lines");
    assert.match(block, /query-status-items[\s\S]*--status "In Test"/);
    assert.match(block, /index\("factory-pause"\)/);
    assert.match(block, /\[\[ "\$BROWSER_RC" -eq 1 \]\] \|\| break/);
    assert.match(script, /"\$MODE_BROWSER" -eq 1 \) \]\]; then\n  log "Phase A:/, "Phase A no-op");
  });

  it("runs --browser last in the loop, after --release", () => {
    const loop = readFileSync(resolve(scriptsDir, "factory-agent-loop.sh"), "utf8");
    const release = loop.indexOf('"$AGENT" --release');
    const browser = loop.indexOf('"$AGENT" --browser');
    assert.ok(release !== -1 && browser > release, "a Chrome session must never delay a merge");
  });

  it("rotates browser run dirs and guard logs on the 30-day window", () => {
    assert.match(script, /find "\$LOG_DIR\/browser" -mindepth 1 -maxdepth 1 -type d -mtime \+30/);
    assert.match(script, /find "\$LOG_DIR\/browser-guard" -type f -name '\*\.jsonl' -mtime \+30/);
  });
});

describe("factory-agent.sh browser runner: knobs under bash 3.2", () => {
  const block = script.match(
    /FACTORY_BROWSER="\$\{FACTORY_BROWSER:-0\}"[\s\S]*?FACTORY_BROWSER_MAX_ATTEMPTS=2\n/,
  );

  function runKnobs(env) {
    assert.ok(block, "knob block not found");
    const r = spawnSync(
      "/bin/bash",
      [
        "-c",
        `set -euo pipefail\nHOME=/home/test\n${block[0]}\n` +
          'echo "B=$FACTORY_BROWSER K=$FACTORY_BROWSER_KINDS T=$FACTORY_BROWSER_TIMEOUT_SEC A=$FACTORY_BROWSER_ACCOUNT_FILE"',
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
    );
    assert.equal(r.status, 0, r.stderr);
    return r;
  }

  it("is off by default, with intest as the default kind", () => {
    const r = runKnobs({});
    assert.match(
      r.stdout,
      /^B=0 K=intest T=900 A=\/home\/test\/\.config\/drafto-factory\/browser-account\.env$/m,
    );
  });

  it("falls back to off on a non-0/1 switch", () => {
    const r = runKnobs({ FACTORY_BROWSER: "yes" });
    assert.match(r.stdout, /^B=0 /m);
    assert.match(r.stderr, /invalid FACTORY_BROWSER='yes'/);
  });

  it("drops unknown kinds and keeps known ones", () => {
    const r = runKnobs({ FACTORY_BROWSER: "1", FACTORY_BROWSER_KINDS: " intest , repro,," });
    assert.match(r.stdout, /^B=1 K=intest /m);
    assert.match(r.stderr, /unknown FACTORY_BROWSER_KINDS entry 'repro'/);
  });

  it("turns the runner off on a malformed device id", () => {
    const r = runKnobs({ FACTORY_BROWSER: "1", FACTORY_BROWSER_DEVICE_ID: "macbook" });
    assert.match(r.stdout, /^B=0 /m);
    assert.match(r.stderr, /invalid FACTORY_BROWSER_DEVICE_ID/);
  });

  it("validates the timeout", () => {
    const r = runKnobs({ FACTORY_BROWSER_TIMEOUT_SEC: "15m" });
    assert.match(r.stdout, / T=900 /);
  });

  it("enables a kind only when the master switch is on and the kind is listed", () => {
    const fn = extract("browser_kind_enabled");
    const cases = [
      ["0", "intest", "intest", 1],
      ["1", "intest", "intest", 0],
      ["1", "", "intest", 1],
      ["1", "intest", "intes", 1],
      ["1", "intest", "repro", 1],
    ];
    for (const [sw, kinds, kind, expected] of cases) {
      const r = spawnSync(
        "/bin/bash",
        [
          "-c",
          `${fn}\nFACTORY_BROWSER=${sw}\nFACTORY_BROWSER_KINDS=${JSON.stringify(kinds)}\nbrowser_kind_enabled ${kind}`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(r.status, expected, `switch=${sw} kinds=${kinds} kind=${kind}`);
    }
  });
});

describe("preview_url_for_sha", () => {
  function run({ deployments, statuses }) {
    const snippet = `set -euo pipefail
LOG_FILE=/dev/null
gh() {
  case "$2" in
    *"/deployments?sha="*) printf '%s' ${JSON.stringify(JSON.stringify(deployments))} | jq "$4" -r ;;
    *"/statuses") printf '%s' ${JSON.stringify(JSON.stringify(statuses))} | jq "$4" -r ;;
    *) return 1 ;;
  esac
}
${extract("preview_url_for_sha")}
preview_url_for_sha ${SHA}
`;
    return spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8" });
  }

  it("returns the per-commit vercel[bot] preview URL", () => {
    const r = run({
      deployments: [{ id: 7, creator: { login: "vercel[bot]" } }],
      statuses: [
        {
          state: "success",
          environment_url: "https://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app/",
        },
      ],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "https://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app");
  });

  it("ignores deployments created by anyone but vercel[bot]", () => {
    const r = run({
      deployments: [{ id: 7, creator: { login: "someone" } }],
      statuses: [
        {
          state: "success",
          environment_url: "https://drafto-x-jakubanderwalds-projects.vercel.app",
        },
      ],
    });
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
  });

  it("fails while the deployment hasn't succeeded", () => {
    const r = run({
      deployments: [{ id: 7, creator: { login: "vercel[bot]" } }],
      statuses: [{ state: "in_progress", environment_url: "" }],
    });
    assert.notEqual(r.status, 0);
  });

  it("rejects a URL outside the project's preview hosts", () => {
    const r = run({
      deployments: [{ id: 7, creator: { login: "vercel[bot]" } }],
      statuses: [
        {
          state: "success",
          environment_url: "https://evil.example/drafto-x-jakubanderwalds-projects.vercel.app",
        },
      ],
    });
    assert.notEqual(r.status, 0);
  });
});

describe("run_browser_task", () => {
  function run({ verifyRc = 0, runnerRc = 0, transcript = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "browser-task-"));
    const calls = join(dir, "calls.txt");
    const stdinFile = join(dir, "stdin.txt");
    const snippet = `set -euo pipefail
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
LOG_DIR=${JSON.stringify(dir)}
SCRIPT_DIR=${JSON.stringify(scriptsDir)}
BROWSER_PROMPT_FILE=${JSON.stringify(join(scriptsDir, "factory-browser-prompt.md"))}
FACTORY_BROWSER_DEVICE_ID=9796912b-8977-4d74-9c08-d9bb283b9496
FACTORY_BROWSER_TIMEOUT_SEC=60
FACTORY_PLAN_EFFORT=xhigh
log() { echo "[log] $*"; }
check_session_limit() { return 1; }
node() {
  case "$1" in
    */browser-guard.mjs)
      echo "guard $2" >>${JSON.stringify(calls)}
      case "$2" in
        config|settings) echo '{}' >"$(printf '%s\\n' "$@" | grep -A1 -- '--out' | tail -1)" ;;
        allowed-tools) echo "mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer" ;;
        verify) return ${verifyRc} ;;
      esac ;;
    */run-claude.mjs)
      shift
      printf 'arg:%s\\n' "$@" >>${JSON.stringify(calls)}
      sid=""; prev=""; for a in "$@"; do [[ "$prev" == "--session-id" ]] && sid="$a"; prev="$a"; done
      ${transcript ? 'mkdir -p "$HOME/.claude/projects/x" && : >"$HOME/.claude/projects/x/$sid.jsonl"' : ":"}
      echo "pwd:$(pwd)" >>${JSON.stringify(calls)}
      echo "timeout:$CLAUDE_CALL_TIMEOUT_SEC" >>${JSON.stringify(calls)}
      cat >${JSON.stringify(stdinFile)}
      echo 'browser=ok verdict=pass'
      return ${runnerRc} ;;
    *) command node "$@" ;;
  esac
}
${extract("run_browser_task")}
rc=0
run_browser_task intest ${JSON.stringify(join(dir, "run"))} https://drafto-x-jakubanderwalds-projects.vercel.app '{"account":{"password":"s3cret-pw"}}' || rc=$?
echo "rc=$rc result=$BROWSER_RESULT out=$BROWSER_OUT"
`;
    const env = { ...process.env, HOME: dir };
    delete env.CLAUDE_CONFIG_DIR;
    const r = spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8", env });
    const callLog = existsSync(calls) ? readFileSync(calls, "utf8") : "";
    const stdin = existsSync(stdinFile) ? readFileSync(stdinFile, "utf8") : "";
    return { r, dir, callLog, stdin };
  }

  it("runs claude locked down, in the run dir, with the prompt on stdin", () => {
    const { r, dir, callLog, stdin } = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rc=0 result=ran /);
    const args = callLog
      .split("\n")
      .filter((l) => l.startsWith("arg:"))
      .map((l) => l.slice(4));
    assert.deepEqual(args.slice(0, 2), ["-p", "--chrome"]);
    for (const [flag, value] of [
      ["--permission-mode", "dontAsk"],
      ["--tools", ""],
      ["--allowedTools", "mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer"],
      ["--settings", join(dir, "run", "guard-settings.json")],
      ["--effort", "xhigh"],
    ]) {
      const i = args.indexOf(flag);
      assert.ok(i !== -1, `missing ${flag}`);
      assert.equal(args[i + 1], value, flag);
    }
    assert.match(args[args.indexOf("--session-id") + 1], /^[0-9a-f-]{36}$/);
    assert.ok(!args.some((a) => a.includes("s3cret-pw")), "the password must never be in argv");
    assert.match(stdin, /s3cret-pw/, "the bundle reaches the runner on stdin");
    assert.match(stdin, /# Factory browser runner/, "with the runner prompt in front");
    // Outside the repo, so no project CLAUDE.md or project hooks load.
    const pwd = callLog.match(/^pwd:(.*)$/m)[1];
    assert.match(pwd, /factory-browser-cwd/);
    assert.ok(
      !pwd.startsWith(scriptsDir.replace(/\/scripts$/, "")),
      "cwd must not be inside the repo",
    );
    assert.match(callLog, /timeout:60/);
    assert.match(
      callLog,
      /guard config[\s\S]*guard settings[\s\S]*guard allowed-tools[\s\S]*guard verify/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports guard-not-loaded when a session ran without the guard's SessionStart record", () => {
    const { r, dir } = run({ verifyRc: 1 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rc=0 result=guard-not-loaded /);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a claude that never started a session as an error, not guard-not-loaded", () => {
    // e.g. a CLI update that rejects a flag: no transcript, no Chrome, so no
    // reason to latch the runner off.
    const { r, dir } = run({ verifyRc: 1, runnerRc: 1, transcript: false });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rc=0 result=error /);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a timeout as its own result", () => {
    const { r, dir } = run({ runnerRc: 124 });
    assert.match(r.stdout, /result=timeout /);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports any other non-zero exit as an error", () => {
    const { r, dir } = run({ runnerRc: 3 });
    assert.match(r.stdout, /result=error /);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("intest_browser_run", () => {
  function run({
    state = {},
    preflight = "ok",
    preview = "https://drafto-x-jakubanderwalds-projects.vercel.app",
    scenarioNull = false,
    taskResult = "ran",
    renderStatus = "ok",
    dryRun = 0,
    liveHead = SHA,
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "browser-intest-"));
    const stateFile = join(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify({ issues: { 501: state } }));
    const calls = join(dir, "calls.txt");
    const bundle = JSON.stringify({
      kind: "factory_browser_run",
      target: { origin: "https://drafto-x-jakubanderwalds-projects.vercel.app" },
      scenario: scenarioNull
        ? null
        : { commentId: 1, webStepsEnveloped: "<scenario-web>1.</scenario-web>" },
    });
    const snippet = `set -euo pipefail
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
LOG_DIR=${JSON.stringify(dir)}
STATE_FILE=${JSON.stringify(stateFile)}
SCRIPT_DIR=${JSON.stringify(scriptsDir)}
DRY_RUN=${dryRun}
FACTORY_BROWSER_ACCOUNT_FILE=/nonexistent/account.env
FACTORY_BROWSER_DEVICE_ID=9796912b-8977-4d74-9c08-d9bb283b9496
FACTORY_BROWSER_MAX_ATTEMPTS=2
ADMIN_EMAIL=ops@example.com
log() { echo "[log] $*"; }
pause_for_session_limit() { echo "PAUSED"; }
fetch_issue_record() { echo '{"number":501,"title":"t"}'; }
fetch_issue_comments() { echo '[]'; }
preview_url_for_sha() { ${preview ? `echo ${JSON.stringify(preview)}` : "return 1"}; }
gh() {
  if [[ "$1 $2" == "pr view" ]]; then echo ${JSON.stringify(liveHead)}; return 0; fi
  echo "gh $*" >>${JSON.stringify(calls)}
}
transition_status() { echo "transition $*" >>${JSON.stringify(calls)}; }
run_browser_task() {
  echo "task $1 $3" >>${JSON.stringify(calls)}
  mkdir -p "$2"
  BROWSER_OUT="$2/runner-output.txt"
  echo 'browser=${renderStatus} verdict=pass' >"$BROWSER_OUT"
  BROWSER_RESULT=${JSON.stringify(taskResult)}
}
node() {
  case "$1" in
    */state-cli.mjs) command node "$@" ;;
    */browser-health.mjs)
      echo "health $2 $(printf '%s ' "\${@:3}")" >>${JSON.stringify(calls)}
      if [[ "$2" == preflight ]]; then echo ${JSON.stringify(preflight)}; [[ ${JSON.stringify(preflight)} == ok ]]; fi ;;
    */factory-bundle.mjs) cat >/dev/null; printf '%s' ${JSON.stringify(bundle)} ;;
    */browser-report.mjs)
      echo "report $(printf '%s ' "\${@:2}")" >>${JSON.stringify(calls)}
      out=$(printf '%s\\n' "$@" | grep -A1 -- '--out' | tail -1)
      echo "rendered body" >"$out"
      echo '{"status":"${renderStatus}","verdict":"pass","withheld":false,"secretHits":[]}' ;;
    *) command node "$@" ;;
  esac
}
${extract("browser_record_result")}
${extract("browser_refund_attempt")}
${extract("intest_browser_run")}
rc=0
intest_browser_run 501 77 ${SHA} || rc=$?
echo "rc=$rc"
`;
    const r = spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8" });
    const callLog = existsSync(calls) ? readFileSync(calls, "utf8") : "";
    const finalState = JSON.parse(readFileSync(stateFile, "utf8")).issues["501"] ?? {};
    rmSync(dir, { recursive: true, force: true });
    return { r, callLog, finalState };
  }

  const ready = { intestCommentSha: SHA };

  it("runs once the scenario for the head exists, posts the rendered report, and records the SHA", () => {
    const { r, callLog, finalState } = run({ state: ready });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rc=0/);
    assert.match(callLog, /task intest https:\/\/drafto-x-jakubanderwalds-projects\.vercel\.app/);
    assert.match(callLog, /report render --kind intest .*--sha a{40} /);
    assert.match(
      callLog,
      /gh issue comment 501 --repo JakubAnderwald\/drafto --body-file .*comment\.md/,
    );
    assert.match(callLog, /health record .*--result ok /);
    assert.equal(finalState.browserRunSha, SHA);
    assert.equal(finalState.browserRunAttempts, `${SHA}:1`);
    assert.doesNotMatch(callLog, /^transition /m, "it never moves the card");
  });

  it("skips a candidate whose PR moved on since --watch listed it", () => {
    // --watch wrote the list minutes ago; a push in between must not cost a
    // whole browser session on the superseded commit's preview.
    for (const liveHead of [OTHER_SHA, ""]) {
      const { r, callLog } = run({ state: ready, liveHead });
      assert.match(r.stdout, /rc=1/);
      assert.doesNotMatch(callLog, /task |health /);
    }
  });

  it("skips a head it already reported on", () => {
    const { r, callLog } = run({ state: { ...ready, browserRunSha: SHA } });
    assert.match(r.stdout, /rc=1/);
    assert.equal(callLog, "");
  });

  it("waits for the scenario of this exact commit", () => {
    const { r, callLog } = run({ state: { intestCommentSha: OTHER_SHA } });
    assert.match(r.stdout, /rc=1/);
    assert.equal(callLog, "");
  });

  it("stops at the per-SHA attempt cap, and a new commit re-arms it", () => {
    let res = run({ state: { ...ready, browserRunAttempts: `${SHA}:2` } });
    assert.match(res.r.stdout, /rc=1/);
    assert.equal(res.callLog, "");
    res = run({ state: { ...ready, browserRunAttempts: `${OTHER_SHA}:2` } });
    assert.match(res.r.stdout, /rc=0/);
    assert.equal(res.finalState.browserRunAttempts, `${SHA}:1`);
  });

  it("records a failed preflight and stops the candidate loop", () => {
    const { r, callLog } = run({ state: ready, preflight: "chrome-not-running" });
    assert.match(r.stdout, /rc=2/);
    assert.match(callLog, /health record .*--result preflight:chrome-not-running /);
    assert.doesNotMatch(callLog, /task /);
  });

  it("still records a disabled runner's preflight, so a failed alert email is retried", () => {
    const { r, callLog } = run({ state: ready, preflight: "disabled:guard-not-loaded" });
    assert.match(r.stdout, /rc=2/);
    assert.match(callLog, /health record .*--result preflight:disabled:guard-not-loaded /);
    assert.doesNotMatch(callLog, /task /);
  });

  it("waits for the per-commit preview", () => {
    const { r, callLog } = run({ state: ready, preview: "" });
    assert.match(r.stdout, /rc=1/);
    assert.doesNotMatch(callLog, /task /);
  });

  it("records a scenario with no Web section as done, without starting a browser", () => {
    const { r, callLog, finalState } = run({ state: ready, scenarioNull: true });
    assert.match(r.stdout, /rc=1/);
    assert.doesNotMatch(callLog, /task /);
    assert.equal(finalState.browserRunSha, SHA);
  });

  for (const renderStatus of ["unavailable", "auth-expired"]) {
    it(`posts nothing and refunds the attempt when the browser was ${renderStatus}`, () => {
      // The operator's to fix; once fixed, the card must still get its run.
      const { r, callLog, finalState } = run({ state: ready, renderStatus });
      assert.match(r.stdout, /rc=2/);
      assert.match(callLog, new RegExp(`health record .*--result ${renderStatus} `));
      assert.doesNotMatch(callLog, /gh issue comment/);
      assert.equal(finalState.browserRunSha ?? null, null);
      assert.equal(finalState.browserRunAttempts, `${SHA}:0`);
    });
  }

  it("posts nothing for a malformed run, and keeps the attempt spent", () => {
    const { r, callLog, finalState } = run({ state: ready, renderStatus: "malformed" });
    assert.match(r.stdout, /rc=2/);
    assert.match(callLog, /health record .*--result malformed /);
    assert.doesNotMatch(callLog, /gh issue comment/);
    assert.equal(finalState.browserRunSha ?? null, null, "the next attempt may still report");
    assert.equal(finalState.browserRunAttempts, `${SHA}:1`);
  });

  it("posts a blocked run's report, so the person at the gate sees why", () => {
    const { r, callLog, finalState } = run({ state: ready, renderStatus: "blocked" });
    assert.match(r.stdout, /rc=0/);
    assert.match(callLog, /gh issue comment 501 /);
    assert.equal(finalState.browserRunSha, SHA);
  });

  it("turns the runner off when the guard didn't load, posts nothing, and refunds", () => {
    const { r, callLog, finalState } = run({ state: ready, taskResult: "guard-not-loaded" });
    assert.match(r.stdout, /rc=2/);
    assert.match(callLog, /health record .*--result guard-not-loaded /);
    assert.doesNotMatch(callLog, /report render|gh issue comment/);
    assert.equal(finalState.browserRunAttempts, `${SHA}:0`);
  });

  it("pauses the factory on a session limit without blaming the browser or spending an attempt", () => {
    const { r, callLog, finalState } = run({ state: ready, taskResult: "session-limit" });
    assert.match(r.stdout, /PAUSED/);
    assert.doesNotMatch(callLog, /health record/);
    assert.equal(finalState.browserRunAttempts, `${SHA}:0`);
  });

  it("keeps a timeout's attempt spent, so a hanging runner can't run every tick", () => {
    const { r, callLog, finalState } = run({ state: ready, taskResult: "timeout" });
    assert.match(r.stdout, /rc=2/);
    assert.match(callLog, /health record .*--result timeout /);
    assert.equal(finalState.browserRunAttempts, `${SHA}:1`);
  });

  it("does nothing but log in a dry run", () => {
    const { r, callLog, finalState } = run({ state: ready, dryRun: 1 });
    assert.match(r.stdout, /DRY-RUN: would run the In Test web steps for #501/);
    assert.doesNotMatch(callLog, /task |gh issue comment|health record/);
    assert.equal(finalState.browserRunAttempts ?? null, null);
  });
});
