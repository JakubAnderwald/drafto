// The weekly hosting-usage readout's bash wiring (ADR-0093): factory-agent.sh
// --usage-readout. The guard's read-only profile and the parser are tested in
// browser-guard.test.mjs and usage-readout.test.mjs; this locks in that the
// readout runs under --browser's lock, gives the guard exact pages and no
// capabilities, uses its own prompt, runs once a week, and hands every outcome
// to usage-readout.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(HERE, "..");
const script = readFileSync(resolve(scriptsDir, "factory-agent.sh"), "utf8");
const prompt = readFileSync(resolve(scriptsDir, "factory-usage-prompt.md"), "utf8");

function extract(name) {
  const fn = script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(fn, `could not extract ${name}`);
  return fn[0];
}

const VERCEL = "https://vercel.com/jakubanderwalds-projects/~/usage";
const SUPABASE = "https://supabase.com/dashboard/org/abcdefghijklmnop/usage";

describe("factory-agent.sh --usage-readout: static wiring", () => {
  it("is a --browser run, so it shares --browser's lock", () => {
    assert.match(script, /^ {4}--usage-readout\) MODE_BROWSER=1; USAGE_READOUT=1; shift ;;$/m);
    assert.match(script, /^LOCK_FILE="\$REPO_ROOT\/logs\/factory-\$MODE_NAME\.lock"$/m);
    assert.match(script, /^elif \[\[ "\$MODE_BROWSER" -eq 1 \]\]; then MODE_NAME="browser"$/m);
  });

  it("runs before the browser candidates and exits, never touching the board", () => {
    const readout = script.indexOf(
      'if [[ "$MODE_BROWSER" -eq 1 && "$USAGE_READOUT" -eq 1 ]]; then',
    );
    const candidates = script.indexOf(
      "if ! browser_kind_enabled verify && ! browser_kind_enabled intest",
    );
    assert.ok(readout > 0 && readout < candidates, "the readout branch comes first");
    assert.match(
      script,
      /if \[\[ -z "\$\{FACTORY_PROJECT_ID:-\}" && "\$USAGE_READOUT" -eq 0 \]\]; then/,
    );
    const fn = extract("usage_readout_run");
    assert.doesNotMatch(fn, /\bgh\b|factory-project\.mjs|transition_status/);
  });

  it("gives the guard exact pages and no capabilities for the usage kind", () => {
    const fn = extract("run_browser_task");
    assert.match(fn, /if \[\[ "\$kind" == usage \]\]; then\n\s+prompt_file="\$USAGE_PROMPT_FILE"/);
    assert.match(fn, /allow_args\+=\(--allow-url "\$_u"\)/);
    assert.match(fn, /if \[\[ "\$kind" != plan && "\$kind" != usage \]\]; then/);
    assert.match(fn, /"\$\{allow_args\[@\]\}" --log-dir/);
    assert.doesNotMatch(fn, /--allow-origin "\$origin" --log-dir/);
  });

  it("has a prompt that never clicks, types or signs in", () => {
    assert.match(prompt, /Never click\./);
    assert.match(prompt, /A login wall means stop\./);
    assert.match(prompt, /browser=<ok\|unavailable\|auth-expired\|blocked>/);
    assert.match(prompt, /<<<USAGE/);
    for (const key of [
      "fastDataTransfer",
      "cdnRequests",
      "functionInvocations",
      "activeCpu",
      "egress",
      "cachedEgress",
    ]) {
      assert.ok(prompt.includes(`\`${key}\``), key);
    }
  });
});

describe("usage_readout_run", () => {
  function run({
    env = {},
    chrome = true,
    browserResult = "ran",
    lastAgeMin = null,
    dryRun = 0,
    browserStatus = '{"streak":0}',
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "usage-readout-"));
    const calls = join(dir, "calls.txt");
    const bin = join(dir, "bin");
    const lastFile = join(dir, "logs", "usage-readout-last");
    spawnSync("mkdir", ["-p", bin, join(dir, "logs")]);
    writeFileSync(join(bin, "pgrep"), `#!/bin/sh\nexit ${chrome ? 0 : 1}\n`, { mode: 0o755 });
    if (lastAgeMin !== null) {
      writeFileSync(lastFile, "2026-11-22T19:00:00Z\n");
      const t = Date.now() / 1000 - lastAgeMin * 60;
      utimesSync(lastFile, t, t);
    }
    const snippet = `set -euo pipefail
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
LOG_DIR=${JSON.stringify(join(dir, "logs", "factory"))}
REPO_ROOT=${JSON.stringify(dir)}
STATE_FILE=${JSON.stringify(join(dir, "logs", "factory-state.json"))}
SCRIPT_DIR=${JSON.stringify(scriptsDir)}
ADMIN_EMAIL=operator@example.com
DRY_RUN=${dryRun}
FACTORY_BROWSER=\${FACTORY_BROWSER:-1}
FACTORY_BROWSER_DEVICE_ID=9796912b-8977-4d74-9c08-d9bb283b9496
FACTORY_USAGE_READOUT=\${FACTORY_USAGE_READOUT:-1}
FACTORY_USAGE_VERCEL_URL=${JSON.stringify(VERCEL)}
FACTORY_USAGE_SUPABASE_URL=\${FACTORY_USAGE_SUPABASE_URL-${SUPABASE}}
FACTORY_USAGE_POST_URL=https://drafto.eu/api/cron/hosted-usage
FACTORY_USAGE_SECRET_FILE=/x/hosted-usage.env
PATH=${JSON.stringify(bin)}:$PATH
log() { echo "[log] $*"; }
browser_record_result() { echo "record $1" >>${JSON.stringify(calls)}; }
run_browser_task() {
  echo "task $1 $2" >>${JSON.stringify(calls)}
  printf 'url %s\\n' "\${USAGE_READOUT_URLS[@]}" >>${JSON.stringify(calls)}
  echo "bundle $4" >>${JSON.stringify(calls)}
  BROWSER_RESULT=${browserResult}
  return 0
}
node() {
  case "$1" in
    */state-cli.mjs) echo ${JSON.stringify(browserStatus)}; return 0 ;;
  esac
  echo "node $*" >>${JSON.stringify(calls)}
  echo '{"posted":true}'
}
${extract("usage_readout_run")}
usage_readout_run
echo "rc=$?"
`;
    const r = spawnSync("/bin/bash", ["-c", snippet], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    const callLog = existsSync(calls) ? readFileSync(calls, "utf8") : "";
    const last = existsSync(lastFile) ? readFileSync(lastFile, "utf8") : null;
    rmSync(dir, { recursive: true, force: true });
    return { r, callLog, last };
  }

  it("reads both pages, hands the output to usage-readout.mjs, and records the run", () => {
    const { r, callLog, last } = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(callLog, /^task usage .*\/logs\/factory\/browser-runs\/usage-\d{8}T\d{6}Z$/m);
    assert.match(callLog, new RegExp(`^url ${VERCEL.replace(/[.~/]/g, "\\$&")}$`, "m"));
    assert.match(callLog, new RegExp(`^url ${SUPABASE.replace(/[.~/]/g, "\\$&")}$`, "m"));
    const bundle = JSON.parse(callLog.match(/^bundle (.*)$/m)[1]);
    assert.deepEqual(bundle.pages, { vercel: VERCEL, supabase: SUPABASE });
    assert.equal(bundle.runKind, "usage");
    const node = callLog.match(/^node (.*)$/m)[1];
    assert.match(node, /usage-readout\.mjs run --in .*runner-output\.txt --runner-result ran/);
    assert.match(
      node,
      /--url https:\/\/drafto\.eu\/api\/cron\/hosted-usage --secret-file \/x\/hosted-usage\.env --to operator@example\.com --providers vercel,supabase/,
    );
    assert.match(last, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    assert.match(r.stdout, /Usage readout \(ran\): \{"posted":true\}/);
  });

  it("reads Vercel only when the Supabase page isn't configured", () => {
    const { callLog, r } = run({ env: { FACTORY_USAGE_SUPABASE_URL: "" } });
    assert.equal((callLog.match(/^url /gm) ?? []).length, 1);
    assert.match(r.stdout, /FACTORY_USAGE_SUPABASE_URL is not set/);
    assert.equal(JSON.parse(callLog.match(/^bundle (.*)$/m)[1]).pages.supabase, null);
    assert.match(callLog, /--providers vercel$/m);
  });

  it("skips a later slot once this week's readout has run, unless forced", () => {
    const skipped = run({ lastAgeMin: 30 });
    assert.match(skipped.r.stdout, /already ran at .*skipping this slot/);
    assert.equal(skipped.callLog, "");
    const stale = run({ lastAgeMin: 60 * 24 * 6 });
    assert.match(stale.callLog, /^task usage/m);
    const forced = run({ lastAgeMin: 30, env: { FACTORY_USAGE_READOUT_FORCE: "1" } });
    assert.match(forced.callLog, /^task usage/m);
  });

  it("starts no session while the browser runner is disabled (guard-not-loaded latch)", () => {
    const { callLog } = run({
      browserStatus: '{"disabled":true,"disabledReason":"guard-not-loaded"}',
    });
    assert.doesNotMatch(callLog, /^task /m);
    assert.match(callLog, /--runner-result preflight:disabled:guard-not-loaded/);
  });

  it("reports Chrome not running without starting a session", () => {
    const { callLog } = run({ chrome: false });
    assert.doesNotMatch(callLog, /^task /m);
    assert.match(callLog, /--runner-result preflight:chrome-not-running/);
  });

  it("passes a failed run's result on, and turns the runner off on guard-not-loaded", () => {
    const timeout = run({ browserResult: "timeout" });
    assert.match(timeout.callLog, /--runner-result timeout/);
    assert.doesNotMatch(timeout.callLog, /^record /m);
    const unguarded = run({ browserResult: "guard-not-loaded" });
    assert.match(unguarded.callLog, /^record guard-not-loaded$/m);
  });

  it("does nothing when switched off or in a dry run", () => {
    for (const env of [{ FACTORY_USAGE_READOUT: "0" }, { FACTORY_BROWSER: "0" }]) {
      const { r, callLog, last } = run({ env });
      assert.match(r.stdout, /Usage readout off/);
      assert.equal(callLog, "");
      assert.equal(last, null);
    }
    const dry = run({ dryRun: 1 });
    assert.match(dry.r.stdout, /\[dry-run\] would read/);
    assert.equal(dry.callLog, "");
  });
});
