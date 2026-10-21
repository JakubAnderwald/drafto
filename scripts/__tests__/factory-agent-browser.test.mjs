import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RENDER_KINDS } from "../lib/browser-report.mjs";
import { SIGN_IN_PATH } from "../lib/browser-signin.mjs";
import { BROWSER_RUN_KINDS } from "../lib/factory-bundle.mjs";

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
//   3. the switch is on by default, a bad value turns it off, and the knobs
//      are validated under bash 3.2;
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
const repoRoot = resolve(scriptsDir, "..");
const SIGNIN_ROUTE_PATH = script.match(/^FACTORY_SIGNIN_ROUTE_PATH="([^"]+)"$/m)?.[1];

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
      assert.match(c, /--effort "\$FACTORY(_PLAN)?_EFFORT" --no-chrome --strict-mcp-config/);
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

  it("keeps the operator's claude.ai connectors out of every factory call", () => {
    // --strict-mcp-config with no --mcp-config loads no MCP server at all: no
    // Gmail (with send), Drive, Calendar or plugin servers in an unattended
    // session that reads issue text. Measured 2026-10-17: 0 MCP tools, 26
    // built-ins. The browser runner keeps only the built-in claude-in-chrome.
    for (const c of claudeCalls(script)) {
      assert.match(c, /--strict-mcp-config/, c.split("\n")[0]);
      assert.doesNotMatch(c, /--mcp-config\b/, "no MCP config may be added back");
    }
  });

  it("passes --no-chrome and --strict-mcp-config on every support-agent and nightly-support call", () => {
    for (const [name, source, n] of [
      ["support-agent.sh", supportScript, 3],
      ["nightly-support.sh", nightlyScript, 2],
    ]) {
      const calls = claudeCalls(source);
      assert.equal(calls.length, n, `${name} call count`);
      for (const c of calls) {
        assert.match(c, /--no-chrome/, `${name}: ${c.split("\n")[0]}`);
        assert.doesNotMatch(c, /\s--chrome\b/, name);
        // These read raw customer email: the operator's connectors (Gmail with
        // send) must not be in the session either.
        assert.match(c, /--strict-mcp-config/, `${name}: ${c.split("\n")[0]}`);
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
    // Cleared as --watch's very first act, so a --watch that exits anywhere
    // (a failed query, a session-limit pause) never leaves --browser last
    // tick's list.
    const firstLines = watch.split("\n").slice(0, 6).join("\n");
    assert.match(firstLines, /: >"\$BROWSER_CANDIDATES_FILE"/, "cleared first in --watch");
    assert.equal(watch.split(': >"$BROWSER_CANDIDATES_FILE"').length, 2, "cleared exactly once");
    assert.match(
      watch,
      /browser_kind_enabled intest && \[\[ "\$INTEST_PENDING_FEEDBACK" -eq 0 \]\]/,
      "a card about to roll back to In Progress is never a candidate",
    );
    assert.match(watch, /\.web \/\/ false/);
    // Every In Test candidate carries its kind (ADR-0053's candidate format).
    assert.match(
      watch,
      /BROWSER_CANDIDATES="\$\{BROWSER_CANDIDATES:\+\$BROWSER_CANDIDATES \}intest:\$ISSUE_NUM:\$INTEST_PR_NUM:\$INTEST_HEAD_SHA"/,
    );
    // Written at the end of the tick, and on the In Test query's early exit,
    // so the Testing sweep's verify candidates reach --browser either way.
    assert.equal(watch.split("\n  browser_write_candidates\n").length, 2, "written at the end");
    assert.match(
      watch,
      /skipping feedback sweep this tick"\n\s*# [^\n]*\n\s*browser_write_candidates\n[^\n]*\n\s*exit 0/,
    );
    assert.doesNotMatch(watch, /browser_run "|intest_browser_run "/, "--watch never runs it");
    // The In Test sweep starts its own list afresh after the Testing sweep has
    // queued verify candidates, so they live in their own variable.
    const sweep = watch.indexOf("\n  verify_sweep\n");
    const reset = watch.indexOf('\n  BROWSER_CANDIDATES=""\n');
    assert.ok(sweep !== -1 && reset > sweep, "the reset comes after the Testing sweep");
    assert.doesNotMatch(watch, /VERIFY_BROWSER_CANDIDATES=""/, "never reset inside --watch");
  });

  it("writes the candidates verify first, atomically, never in a dry run", () => {
    const fn = extract("browser_write_candidates");
    assert.match(fn, /\[\[ "\$DRY_RUN" -eq 0 \]\] \|\| return 0/);
    assert.match(
      fn,
      /printf '%s\\n' \$\{VERIFY_BROWSER_CANDIDATES:-\} \$\{BROWSER_CANDIDATES:-\}/,
      "verify first",
    );
    assert.match(fn, /mv "\$BROWSER_CANDIDATES_FILE\.tmp" "\$BROWSER_CANDIDATES_FILE"/);
    assert.match(script, /^VERIFY_BROWSER_CANDIDATES=""$/m, "defined at the top level");
    const dir = mkdtempSync(join(tmpdir(), "browser-cands-"));
    const file = join(dir, "cands");
    const r = spawnSync(
      "/bin/bash",
      [
        "-c",
        `set -euo pipefail\nDRY_RUN=0\nLOG_FILE=/dev/null\nBROWSER_CANDIDATES_FILE=${JSON.stringify(file)}\n` +
          `VERIFY_BROWSER_CANDIDATES="verify:7:70:${SHA}"\nBROWSER_CANDIDATES="intest:8:80:${OTHER_SHA}"\n` +
          `${fn}\nbrowser_write_candidates`,
      ],
      { encoding: "utf8" },
    );
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(file, "utf8"), `verify:7:70:${SHA}\nintest:8:80:${OTHER_SHA}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs at most one candidate in --browser, re-checked against the board", () => {
    const start = script.indexOf('\nif [[ "$MODE_BROWSER" -eq 1 ]]; then');
    const block = script.slice(start, script.indexOf("# ── --release mode", start));
    assert.match(block, /browser_kind_enabled verify && ! browser_kind_enabled intest/);
    assert.match(block, /browser_kind_enabled "\$BROWSER_KIND"/);
    assert.match(block, /-mmin \+10/, "a stale list is ignored");
    assert.match(block, /'\^verify:\[0-9\]\+:\[0-9\]\+:\[0-9a-f\]\{40\}\$'/, "verify lines");
    assert.match(
      block,
      /'\^\(intest:\)\?\[0-9\]\+:\[0-9\]\+:\[0-9a-f\]\{40\}\$'/,
      "intest lines, bare ones included",
    );
    assert.match(block, /query-status-items \\\n\s*--status "Testing"/);
    assert.match(block, /query-status-items \\\n\s*--status "In Test"/);
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

describe("the browser run kinds stay in step everywhere they are listed", () => {
  it("has the same kinds in the bundle, the report renderer, the knob, browser_run and the prompt", () => {
    assert.deepEqual([...RENDER_KINDS], [...BROWSER_RUN_KINDS]);
    const words = (alt) => alt.split("|").sort();
    const knob = script.match(/^ {4}([a-z|]+)\) \[\[ ",\$_bk_out," == /m);
    assert.ok(knob, "the FACTORY_BROWSER_KINDS parser's case");
    assert.deepEqual(words(knob[1]), [...BROWSER_RUN_KINDS].sort());
    const runCase = extract("browser_run").match(/case "\$kind" in\n\s+([a-z|]+)\) ;;/);
    assert.ok(runCase, "browser_run's kind check");
    assert.deepEqual(words(runCase[1]), [...BROWSER_RUN_KINDS].sort());
    assert.match(script, /^FACTORY_BROWSER_KINDS="\$\{FACTORY_BROWSER_KINDS:-intest,verify\}"$/m);
    const prompt = readFileSync(resolve(scriptsDir, "factory-browser-prompt.md"), "utf8");
    for (const kind of BROWSER_RUN_KINDS) assert.ok(prompt.includes(`\`${kind}\``), kind);
  });
});

describe("factory-agent.sh browser runner: knobs under bash 3.2", () => {
  const block = script.match(
    /FACTORY_BROWSER="\$\{FACTORY_BROWSER-1\}"[\s\S]*?FACTORY_BROWSER_MAX_ATTEMPTS=2\n/,
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

  it("is on by default, with intest and verify as the default kinds", () => {
    // verify is inert while FACTORY_VERIFY=0: only the Testing sweep queues it.
    const r = runKnobs({});
    assert.match(
      r.stdout,
      /^B=1 K=intest,verify T=900 A=\/home\/test\/drafto-secrets\/browser-account\.env$/m,
    );
  });

  it("falls back to off on a non-0/1 switch", () => {
    const r = runKnobs({ FACTORY_BROWSER: "yes" });
    assert.match(r.stdout, /^B=0 /m);
    assert.match(r.stderr, /invalid FACTORY_BROWSER='yes'/);
  });

  it("falls back to off on an empty switch, rather than taking the default", () => {
    const r = runKnobs({ FACTORY_BROWSER: "" });
    assert.match(r.stdout, /^B=0 /m);
    assert.match(r.stderr, /invalid FACTORY_BROWSER=''/);
  });

  it("drops unknown kinds and keeps known ones", () => {
    const r = runKnobs({ FACTORY_BROWSER: "1", FACTORY_BROWSER_KINDS: " intest , repro,," });
    assert.match(r.stdout, /^B=1 K=intest /m);
    assert.match(r.stderr, /unknown FACTORY_BROWSER_KINDS entry 'repro'/);
  });

  it("takes verify on its own, and folds a repeated kind", () => {
    assert.match(runKnobs({ FACTORY_BROWSER_KINDS: "verify" }).stdout, /^B=1 K=verify /m);
    const r = runKnobs({ FACTORY_BROWSER_KINDS: "verify,intest,verify" });
    assert.match(r.stdout, /^B=1 K=verify,intest /m);
    assert.equal(r.stderr, "");
  });

  it("turns the runner off on a malformed device id", () => {
    const r = runKnobs({ FACTORY_BROWSER: "1", FACTORY_BROWSER_DEVICE_ID: "macbook" });
    assert.match(r.stdout, /^B=0 /m);
    assert.match(r.stderr, /invalid FACTORY_BROWSER_DEVICE_ID/);
  });

  it("expands a leading ~ in the file knobs, which a launchd plist won't", () => {
    const r = spawnSync(
      "/bin/bash",
      [
        "-c",
        `set -euo pipefail\nHOME=/home/test\n${block[0]}\n` +
          'echo "A=$FACTORY_BROWSER_ACCOUNT_FILE K=$FACTORY_BROWSER_SIGNIN_KEY_FILE"',
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          FACTORY_BROWSER_ACCOUNT_FILE: "~/drafto-secrets/a.env",
          FACTORY_BROWSER_SIGNIN_KEY_FILE: "~/drafto-secrets/k.env",
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /^A=\/home\/test\/drafto-secrets\/a\.env K=\/home\/test\/drafto-secrets\/k\.env$/m,
    );
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
      ["1", "intest,verify", "verify", 0],
      ["1", "intest", "verify", 1],
      ["0", "intest,verify", "verify", 1],
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

// browser_run's harness. kind "intest" goes through the intest_browser_run
// wrapper (its behaviour is pinned below); kind "verify" calls browser_run
// verify. The board (factory-project.mjs) answers the verify sink's "still in
// Testing?" check from `testingItems`.
function runBrowser({
  kind = "intest",
  state = {},
  preflight = "ok",
  preview = "https://drafto-x-jakubanderwalds-projects.vercel.app",
  scenarioNull = false,
  skipReason = "no-web-steps",
  taskResult = "ran",
  taskRc = 0,
  renderStatus = "ok",
  renderFails = false,
  dryRun = 0,
  liveHead = SHA,
  mintOk = true,
  signinRoute = "present",
  comments = "[]",
  commentOk = true,
  routePath = SIGNIN_ROUTE_PATH,
  testingItems = '[{"issueNumber":501,"labels":[]}]',
  boardFails = false,
  moveRoundDuringRun = false,
  lockStateDuringRun = false,
  previewWaitMin = 10,
  previewRc = 1,
  preflightFailedBefore = "",
} = {}) {
  {
    const dir = mkdtempSync(join(tmpdir(), "browser-intest-"));
    // Its own directory, so a test can make state writes fail (state-cli
    // writes a temp file beside it and renames it).
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({ issues: { 501: state } }));
    const calls = join(dir, "calls.txt");
    const bundle = JSON.stringify({
      kind: "factory_browser_run",
      target: { origin: "https://drafto-x-jakubanderwalds-projects.vercel.app" },
      scenario: scenarioNull
        ? null
        : { commentId: 1, webStepsEnveloped: "<scenario-web>1.</scenario-web>" },
      skipReason: scenarioNull ? skipReason : null,
    });
    const snippet = `set -euo pipefail
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
LOG_DIR=${JSON.stringify(dir)}
STATE_FILE=${JSON.stringify(stateFile)}
SCRIPT_DIR=${JSON.stringify(scriptsDir)}
DRY_RUN=${dryRun}
FACTORY_BROWSER_ACCOUNT_FILE=/nonexistent/account.env
FACTORY_BROWSER_SIGNIN_KEY_FILE=/nonexistent/dev-supabase-admin.env
FACTORY_BROWSER_DEVICE_ID=9796912b-8977-4d74-9c08-d9bb283b9496
FACTORY_BROWSER_MAX_ATTEMPTS=2
FACTORY_VERIFY_PREVIEW_WAIT_MIN=${previewWaitMin}
ADMIN_EMAIL=ops@example.com
log() { echo "[log] $*"; }
pause_for_session_limit() { echo "PAUSED"; }
fetch_issue_record() { echo '{"number":501,"title":"t"}'; }
fetch_issue_comments() { printf '%s\\n' ${JSON.stringify(comments)}; }
preview_url_for_sha() { ${preview ? `echo ${JSON.stringify(preview)}` : `return ${previewRc}`}; }
BROWSER_PREFLIGHT_FAILED=${JSON.stringify(preflightFailedBefore)}
gh() {
  if [[ "$1 $2" == "pr view" ]]; then echo ${JSON.stringify(liveHead)}; return 0; fi
  if [[ "$1" == api && "$2" == *"/contents/"* ]]; then
    echo "route $2" >>${JSON.stringify(calls)}
    case ${JSON.stringify(signinRoute)} in
      present) return 0 ;;
      missing) echo "gh: Not Found (HTTP 404)" >&2; return 1 ;;
      nocommit) echo "gh: No commit found for the ref $2 (HTTP 404)" >&2; return 1 ;;
      *) echo "gh: Bad Gateway (HTTP 502)" >&2; return 1 ;;
    esac
  fi
  echo "gh $*" >>${JSON.stringify(calls)}
  ${commentOk ? "" : 'if [[ "$1 $2" == "issue comment" ]]; then return 1; fi'}
}
transition_status() { echo "transition $*" >>${JSON.stringify(calls)}; }
run_browser_task() {
  echo "task $1 $3" >>${JSON.stringify(calls)}
  echo "rundir $2" >>${JSON.stringify(calls)}
  echo "bundle-signin $(printf '%s' "$4" | jq -r '.account.signInUrl // "none"')" >>${JSON.stringify(calls)}
  ${taskRc ? `return ${taskRc}` : ""}
  mkdir -p "$2"
  BROWSER_OUT="$2/runner-output.txt"
  echo 'browser=${renderStatus} verdict=pass' >"$BROWSER_OUT"
  BROWSER_RESULT=${JSON.stringify(taskResult)}
  ${moveRoundDuringRun ? `command node "$SCRIPT_DIR/lib/state-cli.mjs" factory:set-issue-field 501 verifySha ${OTHER_SHA} --state-file "$STATE_FILE" >/dev/null` : ""}
  ${lockStateDuringRun ? 'chmod 555 "$(dirname "$STATE_FILE")"' : ""}
}
node() {
  case "$1" in
    */state-cli.mjs) command node "$@" ;;
    */browser-health.mjs)
      echo "health $2 $(printf '%s ' "\${@:3}")" >>${JSON.stringify(calls)}
      if [[ "$2" == preflight ]]; then echo ${JSON.stringify(preflight)}; [[ ${JSON.stringify(preflight)} == ok ]]; fi ;;
    */factory-bundle.mjs)
      echo "bundle-input $(jq -r '.runKind // "none"')" >>${JSON.stringify(calls)}
      printf '%s' ${JSON.stringify(bundle)} ;;
    */browser-signin.mjs)
      echo "signin $(printf '%s ' "\${@:2}")" >>${JSON.stringify(calls)}
      ${mintOk ? 'echo "https://drafto-x-jakubanderwalds-projects.vercel.app/auth/test-sign-in?token_hash=tok&next=%2F"' : "return 1"} ;;
    */browser-report.mjs)
      echo "report $(printf '%s ' "\${@:2}")" >>${JSON.stringify(calls)}
      ${renderFails ? "return 1" : ""}
      out=$(printf '%s\\n' "$@" | grep -A1 -- '--out' | tail -1)
      echo "rendered body" >"$out"
      echo '{"status":"${renderStatus}","verdict":"pass","withheld":false,"secretHits":[]}' ;;
    */factory-project.mjs)
      echo "board $(printf '%s ' "\${@:2}")" >>${JSON.stringify(calls)}
      ${boardFails ? "return 1" : ""}
      printf '%s\\n' ${JSON.stringify(testingItems)} ;;
    *) echo "UNSTUBBED node $*" >>${JSON.stringify(calls)}; return 99 ;;
  esac
}
REPO_ROOT=${JSON.stringify(repoRoot)}
FACTORY_SIGNIN_ROUTE_PATH=${JSON.stringify(routePath)}
${extract("browser_record_result")}
${extract("browser_refund_attempt")}
${extract("head_has_signin_route")}
${extract("iso_age_min")}
${extract("verify_sha_value")}
${extract("verify_state_terminal")}
${extract("verify_browser_record")}
${extract("verify_browser_finish")}
${extract("verify_browser_preflight_reason")}
${extract("verify_browser_preview_wait")}
${extract("browser_claim_sha")}
${extract("browser_lane_end")}
${extract("browser_lane_finish")}
${extract("browser_run")}
${extract("intest_browser_run")}
rc=0
${kind === "intest" ? "intest_browser_run" : `browser_run ${kind}`} 501 77 ${SHA} || rc=$?
echo "rc=$rc"
`;
    const r = spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8" });
    const callLog = existsSync(calls) ? readFileSync(calls, "utf8") : "";
    const finalState = JSON.parse(readFileSync(stateFile, "utf8")).issues["501"] ?? {};
    chmodSync(stateDir, 0o700);
    rmSync(dir, { recursive: true, force: true });
    return { r, callLog, finalState };
  }
}

describe("intest_browser_run", () => {
  const run = (opts) => runBrowser({ ...opts, kind: "intest" });
  const ready = { intestCommentSha: SHA };

  it("runs once the scenario for the head exists, posts the rendered report, and records the SHA", () => {
    const { r, callLog, finalState } = run({ state: ready });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rc=0/);
    assert.match(callLog, /task intest https:\/\/drafto-x-jakubanderwalds-projects\.vercel\.app/);
    assert.match(callLog, /bundle-input intest/);
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

  it("mints a one-time sign-in link for the run's own preview and hands it to the runner", () => {
    const { r, callLog } = run({ state: ready });
    assert.match(r.stdout, /rc=0/);
    assert.match(
      callLog,
      /signin mint --key-file \/nonexistent\/dev-supabase-admin\.env --account-file \/nonexistent\/account\.env --origin https:\/\/drafto-x-jakubanderwalds-projects\.vercel\.app /,
    );
    assert.match(
      callLog,
      /bundle-signin https:\/\/drafto-x-[^ ]*\/auth\/test-sign-in\?token_hash=tok/,
    );
    assert.match(
      callLog,
      /health preflight .*--signin-key-file \/nonexistent\/dev-supabase-admin\.env/,
    );
  });

  it("records a failed mint and starts no browser session", () => {
    const { r, callLog, finalState } = run({ state: ready, mintOk: false });
    assert.match(r.stdout, /rc=2/);
    assert.match(callLog, /health record .*--result preflight:signin-mint /);
    assert.doesNotMatch(callLog, /task /);
    assert.equal(finalState.browserRunAttempts ?? null, null, "no attempt spent before a session");
  });

  it("posts nothing when the sign-in link didn't work, and keeps the attempt spent", () => {
    // The branch has the route, so this is the environment: no retry fixes it.
    const { r, callLog, finalState } = run({ state: ready, renderStatus: "signin-failed" });
    assert.match(r.stdout, /rc=2/);
    assert.match(callLog, /health record .*--result signin-failed /);
    assert.doesNotMatch(callLog, /gh issue comment/);
    assert.equal(finalState.browserRunAttempts, `${SHA}:1`);
  });

  it("checks the head for the sign-in route only once nothing else stands in the way", () => {
    // After the preflight and the Web-section check, so the note never promises
    // a run that a disabled runner or a fallback scenario would stop; before
    // the mint, so a stale branch costs no sign-in link and no session.
    assert.match(extract("intest_browser_run"), /^\s+browser_run intest "\$@"$/m, "a thin wrapper");
    const fn = extract("browser_run");
    const check = fn.indexOf('head_has_signin_route "$head_sha"');
    assert.ok(check > 0, "browser_run must call head_has_signin_route");
    assert.ok(check > fn.indexOf('browser-health.mjs" preflight'), "after the health preflight");
    assert.ok(check > fn.indexOf(".scenario == null"), "after the Web-section check");
    assert.ok(check < fn.indexOf("DRY-RUN: would run"), "before the dry-run exit");
    assert.ok(check < fn.indexOf('browser-signin.mjs" mint'), "before minting a sign-in link");
    assert.match(
      extract("head_has_signin_route"),
      /contents\/\$FACTORY_SIGNIN_ROUTE_PATH\?ref=\$1/,
    );
  });

  it("points the route check at the file that serves the sign-in link's path", () => {
    // One source of truth: browser-signin.mjs mints links to SIGN_IN_PATH, and
    // the check must look for the route that serves it, on main.
    assert.equal(SIGNIN_ROUTE_PATH, `apps/web/src/app${SIGN_IN_PATH}/route.ts`);
    assert.ok(existsSync(join(repoRoot, SIGNIN_ROUTE_PATH)), `${SIGNIN_ROUTE_PATH} must exist`);
  });

  it("skips a branch cut before the sign-in route: no session, no health strike, one note", () => {
    // #465: its branch predated /auth/test-sign-in, so the runner landed on
    // /login twice and the operator got a "browser checks failing" email.
    const { r, callLog, finalState } = run({ state: ready, signinRoute: "missing" });
    assert.match(r.stdout, /rc=1/, "try the next candidate");
    assert.match(
      callLog,
      new RegExp(
        `route repos/JakubAnderwald/drafto/contents/apps/web/src/app/auth/test-sign-in/route\\.ts\\?ref=${SHA}`,
      ),
    );
    assert.doesNotMatch(callLog, /health record|signin |task /);
    assert.match(
      callLog,
      /gh issue comment 501 --repo JakubAnderwald\/drafto --body [\s\S]*Update branch[\s\S]*not\s+"Update with rebase"[\s\S]*drafto-factory-browser-stale-branch:a{12} -->/,
    );
    assert.equal(finalState.browserRunSha, SHA, "recorded, so the next tick doesn't re-check");
    assert.equal(finalState.browserRunAttempts ?? null, null, "no attempt spent");
  });

  it("notes each stale commit once", () => {
    const noteFor = (sha) => ({
      body: `note\n<!-- drafto-factory-browser-stale-branch:${sha.slice(0, 12)} -->`,
    });
    let res = run({
      state: ready,
      signinRoute: "missing",
      comments: JSON.stringify([noteFor(SHA)]),
    });
    assert.match(res.r.stdout, /rc=1/);
    assert.doesNotMatch(res.callLog, /gh issue comment/, "this commit already has its note");
    assert.equal(res.finalState.browserRunSha, SHA);
    res = run({
      state: ready,
      signinRoute: "missing",
      comments: JSON.stringify([noteFor(OTHER_SHA)]),
    });
    assert.match(res.callLog, /gh issue comment 501 /, "a later stale commit gets its own note");
  });

  it("records nothing when the stale-branch note didn't post, so the next tick retries", () => {
    const { r, finalState } = run({ state: ready, signinRoute: "missing", commentOk: false });
    assert.match(r.stdout, /rc=1/);
    assert.equal(finalState.browserRunSha ?? null, null);
  });

  it("writes nothing for a stale branch in a dry run", () => {
    const { r, callLog, finalState } = run({ state: ready, signinRoute: "missing", dryRun: 1 });
    assert.match(r.stdout, /rc=1/);
    assert.doesNotMatch(callLog, /gh issue comment|health record|task /);
    assert.equal(finalState.browserRunSha ?? null, null);
  });

  for (const [signinRoute, why] of [
    ["error", "GitHub can't say whether the route is there"],
    ["nocommit", "GitHub doesn't know the commit yet (a 404 that isn't about the file)"],
  ]) {
    it(`runs anyway when ${why}`, () => {
      const { r, callLog, finalState } = run({ state: ready, signinRoute });
      assert.match(r.stdout, /rc=0/);
      assert.match(callLog, /task intest /);
      assert.equal(finalState.browserRunSha, SHA);
    });
  }

  it("runs anyway when the route isn't where the check looks on main", () => {
    // The route moved and FACTORY_SIGNIN_ROUTE_PATH didn't: calling every
    // branch stale would quietly stop every browser run.
    const { r, callLog } = run({
      state: ready,
      signinRoute: "missing",
      routePath: "apps/web/src/app/auth/moved/route.ts",
    });
    assert.match(r.stdout, /rc=0/);
    assert.match(callLog, /task intest /);
    assert.doesNotMatch(callLog, /^route /m, "no GitHub call for a path that can't be right");
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

  it("tells the health tracker which account file the factory uses", () => {
    // The emails quote the file's path in their fix text.
    assert.match(
      extract("browser_record_result"),
      /--account-file "\$FACTORY_BROWSER_ACCOUNT_FILE"/,
    );
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
    assert.doesNotMatch(
      callLog,
      /task |gh issue comment|health record|signin /,
      "a dry run mints no link",
    );
    assert.equal(finalState.browserRunAttempts ?? null, null);
  });
});

describe("browser_run verify (the Testing column's browser lane, ADR-0053)", () => {
  const run = (opts) => runBrowser({ ...opts, kind: "verify" });
  const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const round = (over = {}) => ({
    intestCommentSha: SHA,
    verifySha: SHA,
    verifyStartedAt: now(),
    ...over,
  });
  const RUN_DIR = /\/browser\/issue-501-a{12}-verify-\d{8}T\d{6}$/;

  it("records reported:<verdict> with its run dir, sets browserRunSha, and posts nothing", () => {
    const { r, callLog, finalState } = run({ state: round() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rc=0/);
    assert.match(callLog, /task verify https:\/\/drafto-x-jakubanderwalds-projects\.vercel\.app/);
    assert.match(callLog, /bundle-input verify/, "the runner's bundle says verify");
    assert.match(callLog, /report render --kind verify .*--sha a{40} .*--out \S+\/section\.md /);
    assert.match(callLog, /--json-out \S+\/render\.json/);
    assert.doesNotMatch(callLog, /gh issue comment/, "the verification report is the only post");
    assert.match(callLog, /health record .*--result ok /, "health recording is unchanged");
    assert.match(callLog, /board query-status-items --status Testing/, "still in Testing?");
    assert.equal(finalState.verifyBrowser, `${SHA}:reported:pass`);
    assert.match(finalState.verifyBrowserRunDir, RUN_DIR);
    assert.equal(finalState.browserRunSha, SHA, "so the In Test run doesn't run it again");
    assert.equal(finalState.browserRunAttempts, `${SHA}:1`);
    assert.doesNotMatch(callLog, /^transition /m, "it never moves the card");
  });

  it("records a blocked run as reported too: the report explains why it stopped", () => {
    const { r, finalState } = run({ state: round(), renderStatus: "blocked" });
    assert.match(r.stdout, /rc=0/);
    assert.equal(finalState.verifyBrowser, `${SHA}:reported:pass`);
  });

  it("records nothing for a card that left Testing during the run", () => {
    const { r, callLog, finalState } = run({ state: round(), testingItems: "[]" });
    assert.match(r.stdout, /rc=0/);
    assert.match(r.stdout, /left Testing during the browser run; not recording reported:pass/);
    assert.equal(finalState.verifyBrowser ?? null, null);
    assert.equal(finalState.browserRunSha ?? null, null, "the In Test run can still report");
    assert.equal(finalState.browserRunAttempts, `${SHA}:1`, "the session happened");
    assert.doesNotMatch(callLog, /gh issue comment/);
  });

  it("records nothing when the round moved on during the run", () => {
    const { r, callLog, finalState } = run({ state: round(), moveRoundDuringRun: true });
    assert.match(r.stdout, /round moved on during the browser run/);
    assert.equal(finalState.verifyBrowser ?? null, null);
    assert.equal(finalState.browserRunSha ?? null, null);
    assert.doesNotMatch(callLog, /^board /m, "no board query needed");
  });

  it("records, but doesn't claim the commit, when the board can't confirm the card is in Testing", () => {
    const { r, finalState } = run({ state: round(), boardFails: true });
    assert.match(r.stdout, /couldn't check that #501 is still in Testing/);
    assert.equal(finalState.verifyBrowser, `${SHA}:reported:pass`);
    assert.equal(finalState.browserRunSha ?? null, null, "the In Test run stays possible");
  });

  it("claims nothing when the result couldn't be written", () => {
    const { r, finalState } = run({ state: round(), lockStateDuringRun: true });
    assert.match(r.stdout, /couldn't record #501's browser lane result/);
    assert.equal(finalState.verifyBrowser ?? null, null);
    assert.equal(finalState.browserRunSha ?? null, null);
  });

  it("ends a stale branch's lane: no session, no health strike, no note, no attempt", () => {
    const { r, callLog, finalState } = run({ state: round(), signinRoute: "missing" });
    assert.match(r.stdout, /rc=1/, "try the next candidate");
    assert.doesNotMatch(callLog, /health record|signin |task |gh issue comment/);
    assert.equal(finalState.verifyBrowser, `${SHA}:stale-branch`);
    assert.equal(finalState.verifyBrowserRunDir ?? null, null, "no run, no run dir");
    assert.equal(finalState.browserRunSha, SHA, "and the In Test run won't note it again");
    assert.equal(finalState.browserRunAttempts ?? null, null);
  });

  for (const [renderStatus, reason] of [
    ["unavailable", "chrome"],
    ["auth-expired", "auth-expired"],
  ]) {
    it(`ends the lane as unavailable:${reason} at once and refunds the attempt (${renderStatus})`, () => {
      const { r, callLog, finalState } = run({ state: round(), renderStatus });
      assert.match(r.stdout, /rc=2/);
      assert.match(callLog, new RegExp(`health record .*--result ${renderStatus} `));
      assert.equal(finalState.verifyBrowser, `${SHA}:unavailable:${reason}`);
      assert.match(finalState.verifyBrowserRunDir, RUN_DIR);
      assert.equal(finalState.browserRunAttempts, `${SHA}:0`, "the In Test run is the fallback");
      assert.equal(finalState.browserRunSha ?? null, null);
      assert.doesNotMatch(callLog, /gh issue comment/);
    });
  }

  for (const [preflight, reason] of [
    ["chrome-not-running", "chrome-not-running"],
    ["disabled:guard-not-loaded", "runner-disabled"],
    ["account-mode", "account"],
    ["signin-key-missing", "signin-key"],
    ["something-new", "preflight"],
  ]) {
    it(`ends the lane as unavailable:${reason} on a failed preflight (${preflight})`, () => {
      const { r, callLog, finalState } = run({ state: round(), preflight });
      // 1, not 2: the next verify candidate's lane ends this tick as well.
      assert.match(r.stdout, /rc=1/);
      assert.match(callLog, new RegExp(`health record .*--result preflight:${preflight} `));
      assert.doesNotMatch(callLog, /task /);
      assert.equal(finalState.verifyBrowser, `${SHA}:unavailable:${reason}`);
      assert.equal(finalState.browserRunAttempts ?? null, null);
    });
  }

  it("reuses a preflight that already failed this --browser run: no second check or health record", () => {
    const { r, callLog, finalState } = run({
      state: round(),
      preflightFailedBefore: "chrome-not-running",
    });
    assert.match(r.stdout, /rc=1/);
    assert.doesNotMatch(callLog, /^health /m, "one preflight and one health record per run");
    assert.equal(finalState.verifyBrowser, `${SHA}:unavailable:chrome-not-running`);
    const intest = runBrowser({
      kind: "intest",
      state: { intestCommentSha: SHA },
      preflightFailedBefore: "chrome-not-running",
    });
    assert.match(intest.r.stdout, /rc=2/, "an In Test candidate still stops the loop");
    assert.doesNotMatch(intest.callLog, /^health |^task /m);
  });

  it("ends the lane when the sign-in link can't be minted, before any session", () => {
    const { r, callLog, finalState } = run({ state: round(), mintOk: false });
    assert.match(r.stdout, /rc=2/);
    assert.match(callLog, /health record .*--result preflight:signin-mint /);
    assert.doesNotMatch(callLog, /task /);
    assert.equal(finalState.verifyBrowser, `${SHA}:unavailable:signin-mint`);
  });

  it("ends the lane and refunds when the guard didn't load", () => {
    const { r, finalState } = run({ state: round(), taskResult: "guard-not-loaded" });
    assert.match(r.stdout, /rc=2/);
    assert.equal(finalState.verifyBrowser, `${SHA}:unavailable:guard`);
    assert.equal(finalState.browserRunAttempts, `${SHA}:0`);
  });

  it("ends the lane, refunds and pauses on a session limit", () => {
    const { r, callLog, finalState } = run({ state: round(), taskResult: "session-limit" });
    assert.match(r.stdout, /PAUSED/);
    assert.doesNotMatch(callLog, /health record/);
    assert.equal(finalState.verifyBrowser, `${SHA}:unavailable:session-limit`);
    assert.equal(finalState.browserRunAttempts, `${SHA}:0`);
  });

  it("ends the lane and refunds when the runner couldn't be started at all", () => {
    const { r, callLog, finalState } = run({ state: round(), taskRc: 1 });
    assert.match(r.stdout, /rc=2/);
    assert.match(callLog, /health record .*--result error /);
    assert.equal(finalState.verifyBrowser, `${SHA}:unavailable:runner-start`);
    assert.equal(finalState.verifyBrowserRunDir ?? null, null);
    assert.equal(finalState.browserRunAttempts, `${SHA}:0`);
  });

  it("ends the lane on a timeout, keeping the attempt spent", () => {
    const { r, finalState } = run({ state: round(), taskResult: "timeout" });
    assert.match(r.stdout, /rc=2/);
    assert.equal(finalState.verifyBrowser, `${SHA}:timeout`);
    assert.match(finalState.verifyBrowserRunDir, RUN_DIR);
    assert.equal(finalState.browserRunAttempts, `${SHA}:1`);
  });

  it("ends the lane when sign-in failed on the preview: no retry fixes it", () => {
    const { r, finalState } = run({ state: round(), renderStatus: "signin-failed" });
    assert.match(r.stdout, /rc=2/);
    assert.equal(finalState.verifyBrowser, `${SHA}:unavailable:signin-failed`);
    assert.equal(finalState.browserRunAttempts, `${SHA}:1`);
  });

  for (const [what, opts, reason] of [
    ["an error", { taskResult: "error" }, "runner-error"],
    ["a malformed run", { renderStatus: "malformed" }, "malformed"],
    ["a render failure", { renderFails: true }, "malformed"],
  ]) {
    it(`retries after ${what} while an attempt is left, and ends the lane after the last`, () => {
      let res = run({ state: round(), ...opts });
      assert.match(res.r.stdout, /rc=2/);
      assert.equal(res.finalState.verifyBrowser ?? null, null, "the next tick tries again");
      assert.equal(res.finalState.browserRunAttempts, `${SHA}:1`);
      res = run({ state: round({ browserRunAttempts: `${SHA}:1` }), ...opts });
      assert.equal(res.finalState.verifyBrowser, `${SHA}:unavailable:${reason}`);
      assert.equal(res.finalState.browserRunAttempts, `${SHA}:2`);
    });
  }

  it("ends the lane as unavailable:attempts once the commit's attempts are spent", () => {
    const { r, callLog, finalState } = run({
      state: round({ browserRunAttempts: `${SHA}:2` }),
    });
    assert.match(r.stdout, /rc=1/);
    assert.doesNotMatch(callLog, /task |health /);
    assert.equal(finalState.verifyBrowser, `${SHA}:unavailable:attempts`);
  });

  it("counts the preview wait from the lane's first miss, then ends as no-preview", () => {
    // A round can start while CI is still running, long before the lane is
    // first queued: the round's own start doesn't count.
    let res = run({ state: round({ verifyStartedAt: "2026-01-01T00:00:00Z" }), preview: "" });
    assert.match(res.r.stdout, /rc=1/);
    assert.match(
      res.finalState.verifyBrowser,
      /^a{40}:waiting-preview:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
      "non-terminal: the lane keeps waiting",
    );
    const firstMiss = res.finalState.verifyBrowser;
    res = run({ state: round({ verifyBrowser: firstMiss }), preview: "" });
    assert.equal(res.finalState.verifyBrowser, firstMiss, "the clock isn't restarted");
    res = run({
      state: round({ verifyBrowser: `${SHA}:waiting-preview:2026-01-01T00:00:00Z` }),
      preview: "",
    });
    assert.match(res.r.stdout, /rc=1/);
    assert.match(res.r.stdout, /10 min after the browser lane first looked/);
    assert.equal(res.finalState.verifyBrowser, `${SHA}:no-preview`);
    assert.equal(res.finalState.browserRunSha ?? null, null, "In Test can run it once it's up");
    assert.doesNotMatch(res.callLog, /task /);
  });

  it("runs once the preview appears while the lane waits for it", () => {
    const { r, finalState } = run({
      state: round({ verifyBrowser: `${SHA}:waiting-preview:2026-01-01T00:00:00Z` }),
    });
    assert.match(r.stdout, /rc=0/);
    assert.equal(finalState.verifyBrowser, `${SHA}:reported:pass`);
  });

  it("never counts a GitHub error toward the preview wait", () => {
    const { r, finalState } = run({
      state: round({ verifyBrowser: `${SHA}:waiting-preview:2026-01-01T00:00:00Z` }),
      preview: "",
      previewRc: 2,
    });
    assert.match(r.stdout, /rc=1/);
    assert.match(r.stdout, /couldn't ask GitHub for a{12}'s preview deployment/);
    assert.equal(finalState.verifyBrowser, `${SHA}:waiting-preview:2026-01-01T00:00:00Z`);
  });

  for (const skipReason of ["no-web-steps", "no-scenario"]) {
    it(`ends the lane as skipped:${skipReason} when there is nothing to run`, () => {
      const { r, callLog, finalState } = run({ state: round(), scenarioNull: true, skipReason });
      assert.match(r.stdout, /rc=1/);
      assert.doesNotMatch(callLog, /task /);
      assert.equal(finalState.verifyBrowser, `${SHA}:skipped:${skipReason}`);
      assert.equal(finalState.browserRunSha, SHA);
    });
  }

  it("runs only for the card's current round", () => {
    for (const state of [round({ verifySha: OTHER_SHA }), round({ verifySha: null })]) {
      const { r, callLog, finalState } = run({ state });
      assert.match(r.stdout, /rc=1/);
      assert.equal(callLog, "");
      assert.equal(finalState.verifyBrowser ?? null, null);
    }
  });

  it("does nothing once the lane has a result for this commit, and re-arms for a new one", () => {
    let res = run({ state: round({ verifyBrowser: `${SHA}:unavailable:chrome` }) });
    assert.match(res.r.stdout, /rc=1/);
    assert.equal(res.callLog, "");
    res = run({ state: round({ verifyBrowser: `${OTHER_SHA}:reported:pass` }) });
    assert.match(res.r.stdout, /rc=0/);
    assert.equal(res.finalState.verifyBrowser, `${SHA}:reported:pass`);
  });

  it("skips a commit whose In Test report is on the issue, saying so", () => {
    // The revision no-op path: back to Testing on the same head after In Test.
    const report = (assoc) =>
      JSON.stringify([
        {
          body: `report\n<!-- drafto-factory-browser-run-sha:${SHA} -->`,
          authorAssociation: assoc,
        },
      ]);
    const { r, callLog, finalState } = run({
      state: round({ browserRunSha: SHA }),
      comments: report("OWNER"),
    });
    assert.match(r.stdout, /rc=1/);
    assert.doesNotMatch(callLog, /task |health /);
    assert.equal(finalState.verifyBrowser, `${SHA}:skipped:already-run`);
    // A pasted marker isn't the factory's report.
    const pasted = run({ state: round({ browserRunSha: SHA }), comments: report("NONE") });
    assert.equal(pasted.finalState.verifyBrowser, `${SHA}:reported:pass`);
  });

  it("gives its own reason when the In Test pass on this commit left no report", () => {
    // That pass found no Web steps, or a stale branch: this run finds the same.
    let res = run({ state: round({ browserRunSha: SHA }), scenarioNull: true });
    assert.match(res.r.stdout, /rc=1/);
    assert.equal(res.finalState.verifyBrowser, `${SHA}:skipped:no-web-steps`);
    res = run({ state: round({ browserRunSha: SHA }), signinRoute: "missing" });
    assert.equal(res.finalState.verifyBrowser, `${SHA}:stale-branch`);
    assert.doesNotMatch(res.callLog, /task /);
  });

  it("does nothing but log in a dry run", () => {
    const { r, callLog, finalState } = run({ state: round(), dryRun: 1 });
    assert.match(r.stdout, /DRY-RUN: would run the Testing browser lane \(verify\) for #501/);
    assert.doesNotMatch(callLog, /task |health record|signin /);
    assert.equal(finalState.verifyBrowser ?? null, null);
    assert.equal(finalState.browserRunAttempts ?? null, null);
  });

  it("writes nothing for a stale branch or a failed preflight in a dry run", () => {
    for (const opts of [{ signinRoute: "missing" }, { preflight: "chrome-not-running" }]) {
      const { finalState } = run({ state: round(), dryRun: 1, ...opts });
      assert.equal(finalState.verifyBrowser ?? null, null, JSON.stringify(opts));
      assert.equal(finalState.browserRunSha ?? null, null);
    }
  });
});

describe("the In Test run is the fallback for a head the verify lane couldn't report on", () => {
  it("skips a head the verify lane reported on (they share browserRunSha)", () => {
    const verified = runBrowser({
      kind: "verify",
      state: { intestCommentSha: SHA, verifySha: SHA, verifyStartedAt: "2026-10-21T00:00:00Z" },
    }).finalState;
    assert.equal(verified.browserRunSha, SHA);
    const { r, callLog } = runBrowser({ kind: "intest", state: verified });
    assert.match(r.stdout, /rc=1/);
    assert.equal(callLog, "", "no second session for the same commit");
  });

  it("runs a head the verify lane ended as unavailable, with the refunded attempt", () => {
    const after = runBrowser({
      kind: "verify",
      state: { intestCommentSha: SHA, verifySha: SHA, verifyStartedAt: "2026-10-21T00:00:00Z" },
      renderStatus: "unavailable",
    }).finalState;
    assert.equal(after.verifyBrowser, `${SHA}:unavailable:chrome`);
    const { r, callLog, finalState } = runBrowser({ kind: "intest", state: after });
    assert.match(r.stdout, /rc=0/);
    assert.match(callLog, /task intest /);
    assert.match(callLog, /gh issue comment 501 /);
    assert.equal(finalState.browserRunAttempts, `${SHA}:1`);
  });
});

describe("--browser mode: the candidate loop", () => {
  const start = script.indexOf('\nif [[ "$MODE_BROWSER" -eq 1 ]]; then');
  const block = script.slice(start, script.indexOf("# ── --release mode", start));

  function loop({
    lines,
    testing = [{ issueNumber: 7, labels: [] }],
    intest = [
      { issueNumber: 8, labels: [] },
      { issueNumber: 9, labels: [] },
    ],
    kinds = "intest,verify",
    sw = "1",
    rcs = {},
    stale = false,
    failColumn = "",
  }) {
    const dir = mkdtempSync(join(tmpdir(), "browser-loop-"));
    const file = join(dir, "candidates");
    const calls = join(dir, "calls.txt");
    writeFileSync(file, lines.join("\n") + "\n");
    if (stale) spawnSync("touch", ["-t", "202001010000", file]);
    const snippet = `set -euo pipefail
MODE_BROWSER=1
START_TIME=$(date +%s)
LOG_FILE=/dev/null
SCRIPT_DIR=${JSON.stringify(scriptsDir)}
BROWSER_CANDIDATES_FILE=${JSON.stringify(file)}
FACTORY_BROWSER=${sw}
FACTORY_BROWSER_KINDS=${JSON.stringify(kinds)}
log() { echo "[log] $*"; }
node() {
  case "$1" in
    */factory-project.mjs)
      echo "board $4" >>${JSON.stringify(calls)}
      [[ "$4" != ${JSON.stringify(failColumn)} ]] || return 1
      case "$4" in
        Testing) printf '%s\\n' ${JSON.stringify(JSON.stringify(testing))} ;;
        "In Test") printf '%s\\n' ${JSON.stringify(JSON.stringify(intest))} ;;
      esac ;;
    *) echo "UNSTUBBED node $*" >>${JSON.stringify(calls)}; return 99 ;;
  esac
}
browser_run() {
  echo "run $1 $2 $3 $4" >>${JSON.stringify(calls)}
  case "$1:$2" in
${Object.entries(rcs)
  .map(([k, v]) => `    ${k}) return ${v} ;;`)
  .join("\n")}
    *) return 1 ;;
  esac
}
${extract("browser_kind_enabled")}
${block}
`;
    const r = spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8" });
    const callLog = existsSync(calls) ? readFileSync(calls, "utf8") : "";
    rmSync(dir, { recursive: true, force: true });
    return { r, callLog, runs: callLog.split("\n").filter((l) => l.startsWith("run ")) };
  }

  const V = `verify:7:70:${SHA}`;
  const I8 = `intest:8:80:${OTHER_SHA}`;
  const I9 = `9:90:${SHA}`;

  it("runs verify candidates before intest ones, whatever the file's order", () => {
    const { r, runs } = loop({ lines: [I8, V, I9] });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(runs, [
      `run verify 7 70 ${SHA}`,
      `run intest 8 80 ${OTHER_SHA}`,
      `run intest 9 90 ${SHA}`,
    ]);
  });

  it("reads a bare line as intest, and ignores malformed ones", () => {
    const { runs } = loop({
      lines: [
        I9,
        `verify:7:70:${SHA.slice(1)}`,
        `uicheck:8:80:${SHA}`,
        "junk",
        `verify:x:70:${SHA}`,
      ],
    });
    assert.deepEqual(runs, [`run intest 9 90 ${SHA}`]);
  });

  it("stops at the first candidate that ran or found the browser unavailable", () => {
    for (const rc of [0, 2]) {
      const { runs } = loop({ lines: [V, I8, I9], rcs: { "verify:7": rc } });
      assert.deepEqual(runs, [`run verify 7 70 ${SHA}`], `rc ${rc}`);
    }
  });

  it("re-checks each candidate against its own column", () => {
    // #7 left Testing; #8 is paused; #9 is still In Test.
    const { r, callLog, runs } = loop({
      lines: [V, I8, I9],
      testing: [],
      intest: [
        { issueNumber: 8, labels: ["factory-pause"] },
        { issueNumber: 9, labels: [] },
      ],
    });
    assert.deepEqual(runs, [`run intest 9 90 ${SHA}`]);
    assert.match(r.stdout, /#7: no longer a Testing candidate/);
    assert.match(r.stdout, /#8: no longer a In Test candidate/);
    assert.equal(callLog.match(/^board Testing$/gm).length, 1, "each column read once");
    assert.equal(callLog.match(/^board In Test$/gm).length, 1);
  });

  it("checks a verify candidate against Testing, never In Test", () => {
    const { runs } = loop({ lines: [V], testing: [], intest: [{ issueNumber: 7, labels: [] }] });
    assert.deepEqual(runs, []);
  });

  it("skips the candidates of a kind that is off, and does nothing with both off", () => {
    let res = loop({ lines: [V, I8], kinds: "intest" });
    assert.deepEqual(res.runs, [`run intest 8 80 ${OTHER_SHA}`]);
    assert.match(res.r.stdout, /#7: the browser runner's verify kind is off/);
    res = loop({ lines: [V, I8], kinds: "verify" });
    assert.deepEqual(res.runs, [`run verify 7 70 ${SHA}`]);
    res = loop({ lines: [V, I8], sw: "0" });
    assert.deepEqual(res.runs, []);
    assert.match(res.r.stdout, /Browser runner off/);
  });

  it("lets a failed board query hold back only its own column's candidates", () => {
    const { r, runs } = loop({ lines: [V, I8], failColumn: "Testing" });
    assert.deepEqual(runs, [`run intest 8 80 ${OTHER_SHA}`]);
    assert.match(r.stdout, /query-status-items 'Testing' failed/);
  });

  it("ignores a list older than two ticks", () => {
    const { r, runs } = loop({ lines: [V, I8], stale: true });
    assert.deepEqual(runs, []);
    assert.match(r.stdout, /no browser-run candidates this tick/);
  });
});
