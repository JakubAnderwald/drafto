import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// apps/desktop/scripts/verify-testflight-build.sh check 2 looks for the prod and dev
// Supabase refs in the installed app's JS bundle. The whole script runs under
// `set -euo pipefail`, and check 2 used to be `strings "$BUNDLE" | grep -q <ref>`:
// grep -q exits on the first match, strings dies of SIGPIPE (141), and pipefail fails
// the pipeline. On a real 5 MB Hermes bundle (desktop build 78, #558) that reported a
// found prod ref as missing and a found dev ref as absent. These tests run the check-2
// block on its own, against a bundle shaped like that one.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = "apps/desktop/scripts/verify-testflight-build.sh";
const script = readFileSync(resolve(root, SCRIPT), "utf8");

const PROD_REF = "tbmjbxxseonkciqovnpl";
const DEV_REF = "huhzactreblzcogqkbsd";

// The check-2 block: from its header comment to the next test's header.
function checkTwoBlock() {
  const start = script.indexOf("# --- Test 2:");
  const end = script.indexOf("# --- Test 3:");
  assert.ok(start !== -1 && end > start, `cannot find the check-2 block in ${SCRIPT}`);
  return script.slice(start, end);
}

// A 5 MB binary bundle with `refs` written about 1.1 MB in, like build 78's. The
// filler has a printable run every 9 bytes, so `strings` would have megabytes left
// to write after the match: the condition that made it die of SIGPIPE.
function writeBundle(appDir, refs) {
  const size = 5 * 1024 * 1024;
  const buf = Buffer.alloc(size);
  const unit = Buffer.from("hermesbc\0", "latin1");
  for (let i = 0; i + unit.length <= size; i += unit.length) unit.copy(buf, i);
  let offset = 1100 * 1024;
  for (const ref of refs) {
    const bytes = Buffer.from(`\0https://${ref}.supabase.co\0`, "latin1");
    bytes.copy(buf, offset);
    offset += bytes.length + 64;
  }
  const resources = join(appDir, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, "main.jsbundle"), buf);
}

// Runs the check-2 block under the script's own shell options, with `check` stubbed
// to print "<result> <name>". Returns those lines.
function runCheckTwo(appDir) {
  const program = [
    "set -euo pipefail",
    'check() { printf "%s %s\\n" "$2" "$1"; }',
    `APP_PATH=${JSON.stringify(appDir)}`,
    checkTwoBlock(),
  ].join("\n");
  const res = spawnSync("bash", ["-c", program], { encoding: "utf8" });
  assert.equal(res.status, 0, `check 2 exited ${res.status}: ${res.stderr}`);
  return res.stdout.split("\n").filter((line) => /^(pass|fail) /.test(line));
}

describe("verify-testflight-build.sh check 2 (Supabase refs in the bundle)", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "drafto-verify-bundle-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never pipes strings into grep -q", () => {
    assert.match(script, /^set -euo pipefail$/m, "the script no longer runs under pipefail");
    const piped = script
      .split("\n")
      .filter((line) => /\bstrings\b[^|]*\|\s*grep\s+-[a-zA-Z]*q/.test(line));
    assert.deepEqual(
      piped,
      [],
      "`strings ... | grep -q` fails under pipefail once grep exits early",
    );
  });

  it("passes both checks on a prod bundle", () => {
    const app = join(dir, "prod.app");
    writeBundle(app, [PROD_REF]);
    assert.deepEqual(runCheckTwo(app), [
      "pass Production Supabase URL found in bundle",
      "pass Dev Supabase URL absent from bundle",
    ]);
  });

  it("fails the dev check when the bundle also holds the dev ref", () => {
    const app = join(dir, "both.app");
    writeBundle(app, [PROD_REF, DEV_REF]);
    assert.deepEqual(runCheckTwo(app), [
      "pass Production Supabase URL found in bundle",
      "fail Dev Supabase URL absent from bundle",
    ]);
  });

  it("fails the prod check on a dev bundle", () => {
    const app = join(dir, "dev.app");
    writeBundle(app, [DEV_REF]);
    assert.deepEqual(runCheckTwo(app), [
      "fail Production Supabase URL found in bundle (found dev URL instead)",
      "fail Dev Supabase URL absent from bundle",
    ]);
  });

  it("fails when the bundle is missing", () => {
    const app = join(dir, "empty.app");
    mkdirSync(app, { recursive: true });
    const lines = runCheckTwo(app);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^fail JS bundle exists at /);
  });
});
