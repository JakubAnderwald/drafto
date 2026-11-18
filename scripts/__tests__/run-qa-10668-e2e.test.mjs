import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// apps/mobile/e2e/run-qa-10668-e2e.sh against stand-ins for adb, maestro,
// unzip, xcrun and (for the iOS offline legs) sudo, networksetup, ipconfig,
// pgrep and curl, so its device-free logic is checked here: the
// production-build guards, the step table, the summary and its exit codes,
// and that the test password never reaches argv or a saved log. Nothing here
// touches a device or this Mac's network: the sudo stand-in never runs the
// root watchdog, and net.sh's own networksetup calls resolve to the stand-in.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const RUNNER = path.join(REPO, "apps", "mobile", "e2e", "run-qa-10668-e2e.sh");
const FIXTURES = path.join(HERE, "fixtures", "maestro-layout");
const PASSWORD = "Fake-Pass-4711";
const DEV_CONFIG = '{"extra":{"supabaseUrl":"https://huhzactreblzcogqkbsd.supabase.co"}}';
const PROD_CONFIG = '{"extra":{"supabaseUrl":"https://tbmjbxxseonkciqovnpl.supabase.co"}}';

const root = mkdtempSync(path.join(tmpdir(), "qa-10668-runner-"));
mkdirSync(path.join(root, "bin"));
after(() => rmSync(root, { recursive: true, force: true }));

function stub(name, body) {
  const file = path.join(root, "bin", name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

writeFileSync(
  path.join(root, "env.local"),
  `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9\nE2E_TEST_EMAIL=e2e@example.com\nE2E_TEST_PASSWORD=${PASSWORD}\n`,
);
// The "APK" is a text file of BUNDLE= and CONFIG= lines. The unzip stand-in
// lists the bundle, prints assets/app.config, or prints the whole "APK". Like a
// real multi-MB APK, it keeps writing after the part that matters, so a
// `unzip -p | grep -q` reader that stops early kills it with SIGPIPE.
stub(
  "unzip",
  `if [ "$1" = -l ]; then grep -q BUNDLE "$2"; exit; fi
if [ "$3" = assets/app.config ]; then sed -n 's/^CONFIG=//p' "$2"; else cat "$2"; fi
head -c 8000000 /dev/zero`,
);
// adb: \`adb shell\` reads stdin, as the real one does.
stub(
  "adb",
  `[ "$1" = devices ] && { printf 'List of devices attached\\nemulator-5554\\tdevice\\n'; exit 0; }
shift 2
[ "$1" = shell ] && cat > /dev/null
echo "$*" >> "\${ADB_LOG:-/dev/null}"
case "$*" in
  "shell pm path eu.drafto.mobile") echo "package:/data/app/x/base.apk" ;;
  pull*) cp "$FAKE_APK" "$3" ;;
  "shell settings get secure navigation_mode") echo 2 ;;
  "shell cmd uimode night") echo "Night mode: no" ;;
  "shell wm density") cat "${FIXTURES}/wm-density-420.txt" ;;
  "shell dumpsys window") cat "${FIXTURES}/dumpsys-window-3button-light.txt" ;;
  *) : ;;
esac`,
);
// Maestro: logs its argv to MAESTRO_ARGV_LOG, reads stdin, prints
// FAKE_HIERARCHY for \`hierarchy\`, logs the typed password (from the
// MAESTRO_ env var a flow reads) to stdout and to a commands JSON under
// --debug-output, as a real run does, and fails any flow named in FAIL_FLOWS.
stub(
  "maestro",
  `printf '%s\\n' "$*" >> "\${MAESTRO_ARGV_LOG:-/dev/null}"
cat > /dev/null
[ "$1" = --device ] && shift 2
if [ "$1" = hierarchy ]; then [ -n "\${FAKE_HIERARCHY:-}" ] && cat "$FAKE_HIERARCHY"; exit 0; fi
flow="\${@: -1}"
debug="" prev=""
for arg in "$@"; do [ "$prev" = --debug-output ] && debug="$arg"; prev="$arg"; done
echo "Input text \${MAESTRO_E2E_TEST_PASSWORD:-}"
if [ -n "$debug" ]; then
  mkdir -p "$debug"
  printf '{"inputText":"%s"}\\n' "\${MAESTRO_E2E_TEST_PASSWORD:-}" > "$debug/commands-flow.json"
fi
case " \${FAIL_FLOWS:-} " in *" $(basename "$flow") "*) echo "Assertion failed"; exit 1 ;; esac
exit 0`,
);
stub(
  "xcrun",
  `case "$1 $2" in
  "simctl list") echo "    iPhone 16 (11111111-2222-3333-4444-555555555555) (Booted)" ;;
  "simctl get_app_container") echo "$FAKE_APP" ;;
  *) : ;;
esac`,
);
// The host-offline stand-ins. sudo logs its argv and runs the command after
// its flags, except \`-b\` (the root watchdog), which it only logs.
stub(
  "sudo",
  `printf '%s\\n' "$*" >> "\${SUDO_LOG:-/dev/null}"
background=0
while [ $# -gt 0 ]; do case "$1" in -b) background=1; shift ;; -*) shift ;; *) break ;; esac; done
[ $# -eq 0 ] || [ "$background" = 1 ] && exit 0
exec "$@"`,
);
stub(
  "networksetup",
  `if [ "$1" = -listnetworkserviceorder ]; then
  printf '(1) Wi-Fi\\n(Hardware Port: Wi-Fi, Device: en0)\\n\\n'
else
  printf '%s\\n' "$*" >> "\${NET_LOG:-/dev/null}"
fi`,
);
stub("ipconfig", `[ "$1" = getifaddr ] && echo 10.0.0.2`);
// Only Maestro's own iOS driver is running: not a build, so no wait.
stub("pgrep", `echo "4242 /usr/bin/xcodebuild test-without-building -xctestrun /tmp/x.xctestrun"`);
stub("curl", "exit 0");

// A copy of the runner in a fake repo where every report flow exists, so the
// steps that later PRs' flows enable can run here. scripts/ and apps/desktop/
// link back to the real ones (the checks and net.sh).
const ALL_FLOWS = [
  "01-login.yaml",
  "09-password-visibility.yaml",
  "10-swipe-hint.yaml",
  "11-sign-out-confirm.yaml",
  "android-only/05-offline-mode.yaml",
  "android-only/06-offline-notebook-sync.yaml",
  "android-only/08-fab-above-nav-bar.yaml",
  "android-only/09-offline-image.yaml",
  "android-only/10-offline-banner-header.yaml",
  "android-only/11-dark-nav-bar.yaml",
  "ios-only/05-offline-mode.yaml",
  "ios-only/06-offline-notebook-sync.yaml",
  "ios-only/08-fab-above-home-indicator.yaml",
  "ios-only/09-attach-image-offline.yaml",
  "ios-only/10-offline-banner-header.yaml",
];
// Only the flows that existed before the report PRs: the login and the
// rewritten 05/06 offline flows. The default runner, so the "skipped until it
// exists" cases hold whichever report flows the real repo has by now.
const BASE_FLOWS = [
  "01-login.yaml",
  "android-only/05-offline-mode.yaml",
  "android-only/06-offline-notebook-sync.yaml",
  "ios-only/05-offline-mode.yaml",
  "ios-only/06-offline-notebook-sync.yaml",
];
function fakeRunner(name, flows) {
  const repo = path.join(root, name);
  const e2e = path.join(repo, "apps", "mobile", "e2e");
  mkdirSync(path.join(e2e, "android-only"), { recursive: true });
  mkdirSync(path.join(e2e, "ios-only"), { recursive: true });
  for (const flow of flows) {
    writeFileSync(path.join(e2e, flow), "appId: eu.drafto.mobile\n---\n- launchApp\n");
  }
  copyFileSync(RUNNER, path.join(e2e, "run-qa-10668-e2e.sh"));
  mkdirSync(path.join(repo, "apps", "desktop"));
  symlinkSync(path.join(REPO, "apps", "desktop", "e2e"), path.join(repo, "apps", "desktop", "e2e"));
  symlinkSync(path.join(REPO, "scripts"), path.join(repo, "scripts"));
  return path.join(e2e, "run-qa-10668-e2e.sh");
}
const FAKE_RUNNER = fakeRunner("repo", ALL_FLOWS);
const BASE_RUNNER = fakeRunner("base-repo", BASE_FLOWS);

/** A fake installed iOS app: EXConstants.bundle/app.config, plus any extra files. */
function fakeApp(files = {}) {
  const app = mkdtempSync(path.join(root, "Drafto.app-"));
  const all = { "EXConstants.bundle/app.config": DEV_CONFIG, ...files };
  for (const [name, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(app, name)), { recursive: true });
    writeFileSync(path.join(app, name), content);
  }
  return app;
}

function run(
  args,
  { apk = `BUNDLE=var a=1\nCONFIG=${DEV_CONFIG}`, env = {}, runner = BASE_RUNNER } = {},
) {
  const id = Math.random().toString(36).slice(2);
  const fakeApk = path.join(root, `apk-${id}`);
  writeFileSync(fakeApk, `${apk}\n`);
  const out = mkdtempSync(path.join(root, "out-"));
  const logs = {
    adb: path.join(root, `adb-${id}.log`),
    maestro: path.join(root, `maestro-argv-${id}.log`),
    sudo: path.join(root, `sudo-${id}.log`),
    net: path.join(root, `net-${id}.log`),
  };
  const childEnv = {
    ...process.env,
    PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
    MAESTRO: path.join(root, "bin", "maestro"),
    ADB: path.join(root, "bin", "adb"),
    QA_ENV_FILE: path.join(root, "env.local"),
    FAKE_APK: fakeApk,
    ADB_LOG: logs.adb,
    MAESTRO_ARGV_LOG: logs.maestro,
    SUDO_LOG: logs.sudo,
    NET_LOG: logs.net,
    ...env,
  };
  delete childEnv.NET_WATCHDOG_S;
  const result = spawnSync("bash", [runner, ...args, "--out", out], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: childEnv,
  });
  const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
  return {
    ...result,
    out,
    summary: read(path.join(out, "summary.md")),
    logs: Object.fromEntries(Object.entries(logs).map(([key, file]) => [key, read(file)])),
  };
}

function savedText(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(path.join(entry.parentPath ?? entry.path, entry.name), "utf8"))
    .join("\n");
}

describe("run-qa-10668-e2e.sh", () => {
  it("runs the steps that exist, skips the rest, and writes a summary", () => {
    const result = run(["android"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const summary = readFileSync(path.join(result.out, "summary.md"), "utf8");
    assert.match(summary, /\| setup \| passed \| nav-mode: pass \(navigation mode: three-button\)/);
    assert.match(summary, /\| setup-login \| passed \|/);
    assert.match(summary, /\| offline-mode \| passed \|/);
    assert.match(summary, /\| offline-notebook-sync \| passed \|/);
    // Flows other PRs add are skipped until they exist.
    assert.match(summary, /\| fab-above-nav-bar \| skipped \|/);
  });

  it("never puts the test password in argv or a saved file", () => {
    const result = run(["android"]);
    assert.equal(result.status, 0);
    // Maestro gets it from the environment (MAESTRO_E2E_TEST_PASSWORD), not -e.
    assert.match(result.logs.maestro, /--debug-output /);
    assert.ok(!result.logs.maestro.includes(PASSWORD), "the password reached maestro's argv");
    const saved = savedText(result.out);
    assert.ok(saved.includes("Input text [redacted]"), "the maestro log was kept, scrubbed");
    assert.ok(saved.includes('{"inputText":"[redacted]"}'), "the debug output was kept, scrubbed");
    assert.ok(!saved.includes(PASSWORD));
    assert.ok(!result.stdout.includes(PASSWORD));
  });

  it("fails the run when a flow fails, and --require-all fails a missing flow", () => {
    const failed = run(["android"], { env: { FAIL_FLOWS: "05-offline-mode.yaml" } });
    assert.equal(failed.status, 1);
    assert.match(
      readFileSync(path.join(failed.out, "summary.md"), "utf8"),
      /\| offline-mode \| FAILED \|/,
    );
    const strict = run(["android", "--require-all", "--only", "08-fab"]);
    assert.equal(strict.status, 1);
    assert.match(strict.summary, /\| fab-above-nav-bar \| FAILED \|/);
  });

  it("in --before, a failing regression flow isn't a report check", () => {
    const result = run(["android", "--before"], {
      env: { FAIL_FLOWS: "06-offline-notebook-sync.yaml" },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(
      readFileSync(path.join(result.out, "summary.md"), "utf8"),
      /\| offline-notebook-sync \| failed \(not a report check\) \|/,
    );
  });

  it("refuses an installed build that names production anywhere in the APK", () => {
    // The Supabase URL ships in assets/app.config, not the Hermes bundle. The
    // unzip stand-in keeps writing after the ref, so under pipefail a
    // \`unzip -p | grep -q\` guard reads its SIGPIPE as "no match".
    const result = run(["android"], { apk: `BUNDLE=var a=1\nCONFIG=${PROD_CONFIG}` });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /contains the production ref/);
    assert.ok(!existsSync(path.join(result.out, "installed.apk.contents")));
  });

  it("refuses an installed build whose app.config does not name the dev project", () => {
    const result = run(["android"], { apk: 'BUNDLE=var a=1\nCONFIG={"extra":{}}' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /does not name the dev project/);
  });

  it("refuses an iOS app that names production anywhere in the .app", () => {
    // In EXConstants.bundle/app.config (where the URL ships) or any other file.
    for (const files of [
      { "EXConstants.bundle/app.config": PROD_CONFIG },
      { "Frameworks/Some.framework/Some": `x${PROD_CONFIG}y`, "main.jsbundle": "var a=1" },
    ]) {
      const result = run(["ios"], { env: { FAKE_APP: fakeApp(files) } });
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /contains the production ref/);
    }
  });

  it("requires the dev ref in the iOS app.config, debug builds included", () => {
    const debug = run(["ios"], {
      env: { FAKE_APP: fakeApp({ "EXConstants.bundle/app.config": "{}" }) },
    });
    assert.equal(debug.status, 2);
    assert.match(debug.stderr, /app\.config does not name the dev project/);
    const ok = run(["ios"], { env: { FAKE_APP: fakeApp() } });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(readFileSync(path.join(ok.out, "run.log"), "utf8"), /debug .*dev project/);
  });

  it("runs all four dark-nav-bar cases (adb shell can't eat the case list)", () => {
    const result = run(["android", "--only", "11-dark-nav-bar"], { runner: FAKE_RUNNER });
    const steps = readFileSync(path.join(result.out, "results.tsv"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("dark-nav-bar-") && line.split("\t")[1] === "flow")
      .map((line) => line.split("\t")[0]);
    assert.deepEqual(steps, [
      "dark-nav-bar-A-os-light-app-dark",
      "dark-nav-bar-B-os-dark-app-light",
      "dark-nav-bar-C1-system-follows-dark-os",
      "dark-nav-bar-C2-system-follows-light-os",
    ]);
    assert.match(result.logs.adb, /shell cmd uimode night yes/);
  });

  it("in --before, only a measured check failing cleanly is 'reproduced'", () => {
    const measured = run(["android", "--before", "--only", "08-fab"], {
      runner: FAKE_RUNNER,
      env: { FAKE_HIERARCHY: path.join(FIXTURES, "android-notebook-fab-no-inset.json") },
    });
    assert.equal(measured.status, 0, measured.stdout);
    assert.match(measured.summary, /\| fab-above-nav-bar \| reproduced \|/);

    // No FAB on screen: the check exits 2, which proves nothing.
    const absent = run(["android", "--before", "--only", "08-fab"], {
      runner: FAKE_RUNNER,
      env: { FAKE_HIERARCHY: path.join(FIXTURES, "android-offline-note-banner-clear.json") },
    });
    assert.equal(absent.status, 1, absent.stdout);
    assert.match(absent.summary, /\| fab-above-nav-bar \| NOT MEASURED \|.*no element with id/);

    // An empty capture is bad input, not a reproduction either.
    const empty = run(["android", "--before", "--only", "08-fab"], { runner: FAKE_RUNNER });
    assert.equal(empty.status, 1);
    assert.match(empty.summary, /\| fab-above-nav-bar \| NOT MEASURED \|/);

    // Nor is a flow that doesn't exist.
    const missing = run(["android", "--before", "--require-all", "--only", "08-fab"]);
    assert.equal(missing.status, 1);
    assert.match(missing.summary, /\| fab-above-nav-bar \| NOT MEASURED \|.*does not exist/);
  });

  it("in --before, an iOS offline check skipped without host-offline is skipped", () => {
    const result = run(["ios", "--before", "--only", "09-attach-image-offline"], {
      runner: FAKE_RUNNER,
      env: { FAKE_APP: fakeApp() },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.summary, /\| offline-image \| skipped \(its check didn't run\) \|/);
  });

  it("takes the Mac offline through net.sh, with sudo kept alive and a 300 s watchdog", () => {
    const result = run(["ios", "--allow-host-offline", "--only", "09-attach-image-offline"], {
      runner: FAKE_RUNNER,
      env: {
        FAKE_APP: fakeApp(),
        FAKE_HIERARCHY: path.join(FIXTURES, "android-note-image-rendered.json"),
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.summary, /\| offline-image \| passed \|/);
    // The keepalive loop, and the watchdog armed for 300 s (sudo -b, never run here).
    assert.match(result.logs.sudo, /^-n true$/m);
    assert.match(result.logs.sudo, /^-n -b nohup \/bin\/sh -c .* sh 300 \S+net-restored Wi-Fi$/m);
    // Maestro's driver (xcodebuild test-without-building) didn't hold it up.
    assert.doesNotMatch(readFileSync(path.join(result.out, "run.log"), "utf8"), /waiting: a build/);
    assert.equal(
      result.logs.net,
      "-setnetworkserviceenabled Wi-Fi off\n-setnetworkserviceenabled Wi-Fi on\n",
    );
    assert.ok(!existsSync(path.join(result.out, "net", ".hdr-anon")));
  });

  it("refuses an env file pointing at production, and bad arguments", () => {
    writeFileSync(
      path.join(root, "prod.env"),
      "NEXT_PUBLIC_SUPABASE_URL=https://tbmjbxxseonkciqovnpl.supabase.co\nE2E_TEST_EMAIL=a\nE2E_TEST_PASSWORD=b\n",
    );
    const prod = run(["android"], { env: { QA_ENV_FILE: path.join(root, "prod.env") } });
    assert.equal(prod.status, 2);
    assert.match(prod.stderr, /production project/);
    assert.equal(run(["windows"]).status, 2);
    assert.equal(run(["android", "--allow-host-offline"]).status, 2);
  });
});
