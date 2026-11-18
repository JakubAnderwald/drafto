import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// apps/mobile/e2e/run-qa-10668-e2e.sh against stand-ins for adb, maestro and
// unzip, so its device-free logic is checked here: the production-bundle
// guard, the step table, the summary and its exit codes, and that the test
// password never reaches a saved log. Nothing here touches a device.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "..", "..", "apps", "mobile", "e2e", "run-qa-10668-e2e.sh");
const FIXTURES = path.join(HERE, "fixtures", "maestro-layout");
const PASSWORD = "Fake-Pass-4711";

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
// lists the bundle, prints assets/app.config, or prints the whole "APK".
stub(
  "unzip",
  `if [ "$1" = -l ]; then grep -q BUNDLE "$2"
elif [ "$3" = assets/app.config ]; then sed -n 's/^CONFIG=//p' "$2"
else cat "$2"; fi`,
);
stub(
  "adb",
  `[ "$1" = devices ] && { printf 'List of devices attached\\nemulator-5554\\tdevice\\n'; exit 0; }
shift 2
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
// Maestro: echoes the password the way a real run logs typed text, and fails
// any flow named in FAIL_FLOWS.
stub(
  "maestro",
  `flow="\${@: -1}"
for arg in "$@"; do case "$arg" in E2E_TEST_PASSWORD=*) echo "Input text \${arg#E2E_TEST_PASSWORD=}" ;; esac; done
case " \${FAIL_FLOWS:-} " in *" $(basename "$flow") "*) echo "Assertion failed"; exit 1 ;; esac
exit 0`,
);

function run(
  args,
  {
    apk = 'BUNDLE=var a=1\nCONFIG={"extra":{"supabaseUrl":"https://huhzactreblzcogqkbsd.supabase.co"}}',
    env = {},
  } = {},
) {
  const fakeApk = path.join(root, `apk-${Math.random().toString(36).slice(2)}`);
  writeFileSync(fakeApk, `${apk}\n`);
  const out = mkdtempSync(path.join(root, "out-"));
  const result = spawnSync("bash", [RUNNER, ...args, "--out", out], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
      MAESTRO: path.join(root, "bin", "maestro"),
      ADB: path.join(root, "bin", "adb"),
      QA_ENV_FILE: path.join(root, "env.local"),
      FAKE_APK: fakeApk,
      ...env,
    },
  });
  return { ...result, out };
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

  it("never saves the test password", () => {
    const result = run(["android"]);
    assert.equal(result.status, 0);
    const saved = savedText(result.out);
    assert.ok(saved.includes("Input text [redacted]"), "the maestro log was kept, scrubbed");
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
    // The Supabase URL ships in assets/app.config, not the Hermes bundle.
    const result = run(["android"], {
      apk: 'BUNDLE=var a=1\nCONFIG={"extra":{"supabaseUrl":"https://tbmjbxxseonkciqovnpl.supabase.co"}}',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /contains the production ref/);
  });

  it("refuses an installed build whose app.config does not name the dev project", () => {
    const result = run(["android"], { apk: 'BUNDLE=var a=1\nCONFIG={"extra":{}}' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /does not name the dev project/);
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
