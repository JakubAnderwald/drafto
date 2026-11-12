// The browser runner's opt-in capabilities around the guard (ADR-0073):
// fixtures, the admin sign-in link, dev-inspect setup, email redaction, the
// bundle's fields and the bash wiring in factory-agent.sh.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FixtureSpecError,
  MAX_FIXTURE_BYTES,
  makeFixtures,
  paddedImage,
  parseFixtureSpecs,
  parseSize,
} from "../lib/browser-fixtures.mjs";
import {
  adminAccountFileProblem,
  readAdminAccountFile,
  redactAccountEmails,
  redactEmailsCommand,
} from "../lib/browser-report.mjs";
import { mint } from "../lib/browser-signin.mjs";
import { buildFactoryBrowserRunBundle } from "../lib/factory-bundle.mjs";
import { setupInspect } from "../lib/verify-lane.mjs";
import { INSPECT_CFG } from "../lib/verify-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(path.join(HERE, "..", "factory-agent.sh"), "utf8");
const DEV = "https://huhzactreblzcogqkbsd.supabase.co";
const PREVIEW = "https://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app";
const SHA = "c".repeat(40);

function files() {
  const dir = mkdtempSync(path.join(tmpdir(), "browser-caps-"));
  const write = (name, text, mode = 0o600) => {
    const f = path.join(dir, name);
    writeFileSync(f, text);
    chmodSync(f, mode);
    return f;
  };
  return {
    dir,
    keyFile: write(
      "key.env",
      `DEV_SUPABASE_URL=${DEV}\nDEV_SUPABASE_SERVICE_ROLE_KEY=k-0123456789\n`,
    ),
    accountFile: write(
      "account.env",
      "FACTORY_BROWSER_EMAIL=bot@example.com\nFACTORY_BROWSER_PASSWORD=pw-123456\n",
    ),
    adminFile: write("admin.env", "FACTORY_BROWSER_ADMIN_EMAIL=Admin@Example.com\n"),
    write,
  };
}

function extract(name) {
  const start = SCRIPT.indexOf(`\n${name}() {`);
  assert.ok(start >= 0, `${name} not found`);
  const end = SCRIPT.indexOf("\n}\n", start);
  return SCRIPT.slice(start + 1, end + 2);
}

describe("fixtures", () => {
  it("parses the scenario's bullets", () => {
    const specs = parseFixtureSpecs(
      [
        "- small.jpg 1.5MB",
        "- `big.png` 3MB",
        "1. notes.txt 2KB",
        "- q.enex notes=4 image=1MB",
        "- sample.enex",
        "prose line",
      ].join("\n"),
    );
    assert.deepEqual(specs, [
      { name: "small.jpg", kind: "jpg", bytes: 1572864 },
      { name: "big.png", kind: "png", bytes: 3145728 },
      { name: "notes.txt", kind: "txt", bytes: 2048 },
      { name: "q.enex", kind: "enex", notes: 4, imageBytes: 1048576 },
      { name: "sample.enex", kind: "sample" },
    ]);
  });

  for (const [text, why] of [
    ["- ../evil.jpg 1KB", /fixture name/],
    ["- evil.sh 1KB", /fixture name/],
    ["- a.jpg 1GB", /size/],
    ["- a.jpg 11MB", /out of range/],
    ["- a.jpg 0B", /out of range/],
    ["- a.jpg 1KB\n- a.jpg 2KB", /twice/],
    ["- x.enex", /notes=N image=SIZE/],
    ["- x.enex notes=50 image=1KB", /1 to 20/],
    [Array.from({ length: 11 }, (_, i) => `- f${i}.txt 1KB`).join("\n"), /at most 10/],
  ]) {
    it(`refuses ${JSON.stringify(text).slice(0, 40)}`, () => {
      assert.throws(
        () => parseFixtureSpecs(text),
        (e) => e instanceof FixtureSpecError && why.test(e.message),
      );
    });
  }

  it("makes files of the asked size in a private directory", () => {
    const { dir } = files();
    const out = path.join(dir, "fixtures");
    const made = makeFixtures(
      parseFixtureSpecs(
        "- a.jpg 20KB\n- b.png 3KB\n- c.txt 100B\n- q.enex notes=2 image=1KB\n- sample.enex",
      ),
      out,
    );
    assert.deepEqual(
      made.map((f) => [f.name, f.size]),
      [
        ["a.jpg", 20480],
        ["b.png", 3072],
        ["c.txt", 100],
        ["q.enex", made[3].size],
        ["sample.enex", 1152],
      ],
    );
    assert.equal(statSync(out).mode & 0o777, 0o700);
    for (const f of made) assert.equal(path.dirname(f.path), out);
    // Valid image headers: JPEG SOI and the PNG signature.
    assert.deepEqual([...readFileSync(made[0].path).subarray(0, 2)], [0xff, 0xd8]);
    assert.equal(readFileSync(made[1].path).subarray(1, 4).toString(), "PNG");
    const enex = readFileSync(made[3].path, "utf8");
    assert.equal((enex.match(/<note>/g) ?? []).length, 2);
  });

  it("reads the Fixtures section's text from stdin, never a bundle file", async () => {
    const { main } = await import("../lib/browser-fixtures.mjs");
    const { dir } = files();
    let out = "";
    const code = main(["make", "--out", path.join(dir, "fx")], {
      stdinText: "- a.txt 10B",
      stdout: { write: (x) => (out += x) },
    });
    assert.equal(code, 0);
    assert.deepEqual(
      JSON.parse(out).map((f) => f.name),
      ["a.txt"],
    );
    assert.equal(main(["make"], { stdinText: "", stdout: { write: () => {} } }), 2);
  });

  it("sizes and pads images as asked", () => {
    assert.equal(parseSize("1.5MB"), 1572864);
    assert.equal(paddedImage("jpg", 5000).length, 5000);
    assert.ok(paddedImage("png", 1).length > 1);
    assert.throws(() => parseSize(`${MAX_FIXTURE_BYTES + 1}B`), /out of range/);
  });
});

describe("the admin account file", () => {
  it("holds only an email, checked like the other secret files", () => {
    const f = files();
    assert.equal(adminAccountFileProblem(f.adminFile), null);
    assert.deepEqual(readAdminAccountFile(f.adminFile), { email: "Admin@Example.com" });
    assert.equal(
      adminAccountFileProblem(f.write("loose.env", "FACTORY_BROWSER_ADMIN_EMAIL=a@b.c\n", 0o644)),
      "mode",
    );
    assert.equal(adminAccountFileProblem(f.write("empty.env", "X=1\n")), "keys");
    assert.equal(adminAccountFileProblem(path.join(f.dir, "missing.env")), "missing");
  });

  it("mint --account admin mints for the admin's email", async () => {
    const f = files();
    const calls = [];
    const link = await mint({
      keyFile: f.keyFile,
      accountFile: f.adminFile,
      account: "admin",
      origin: PREVIEW,
      fetchImpl: async (url, init) => {
        calls.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ hashed_token: "a".repeat(56) }), { status: 200 });
      },
    });
    assert.match(link, /\/auth\/test-sign-in\?token_hash=a{56}/);
    assert.equal(calls[0].email, "Admin@Example.com");
    await assert.rejects(
      () =>
        mint({ keyFile: f.keyFile, accountFile: f.adminFile, account: "root", origin: PREVIEW }),
      /unknown account/,
    );
  });
});

describe("setupInspect (the browser run's dev-inspect)", () => {
  it("writes the wrapper and a mode-600 config with both accounts", () => {
    const f = files();
    const runDir = path.join(f.dir, "run");
    const r = setupInspect({
      runDir,
      keyFile: f.keyFile,
      accountFile: f.accountFile,
      adminAccountFile: f.adminFile,
      nodePath: "/opt/homebrew/bin/node",
    });
    assert.deepEqual(r.accounts, ["user", "admin"]);
    const cfg = path.join(runDir, "private", INSPECT_CFG);
    assert.equal(statSync(cfg).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(cfg, "utf8")), {
      keyFile: f.keyFile,
      accounts: { user: f.accountFile, admin: f.adminFile },
    });
    assert.equal(statSync(path.join(runDir, "bin", "dev-inspect")).mode & 0o777, 0o700);
  });

  it("leaves the admin out when its file isn't usable, and writes nothing without a usable key", () => {
    const f = files();
    const runDir = path.join(f.dir, "run");
    const r = setupInspect({
      runDir,
      keyFile: f.keyFile,
      accountFile: f.accountFile,
      adminAccountFile: path.join(f.dir, "nope.env"),
    });
    assert.deepEqual(r.accounts, ["user"]);
    const other = path.join(f.dir, "run2");
    chmodSync(f.keyFile, 0o644);
    assert.equal(
      setupInspect({ runDir: other, keyFile: f.keyFile, accountFile: f.accountFile }).ok,
      false,
    );
    assert.ok(!existsSync(other));
  });
});

describe("email redaction", () => {
  it("replaces both accounts' emails, any case", () => {
    assert.equal(
      redactAccountEmails("Signed in as BOT@example.com, then admin@example.com.", [
        ["bot@example.com", "the test account"],
        ["Admin@Example.com", "the admin account"],
      ]),
      "Signed in as the test account, then the admin account.",
    );
  });

  it("rewrites the runner output in place", () => {
    const f = files();
    const out = f.write(
      "runner-output.txt",
      "<<<REPORT\nuser bot@example.com admin admin@example.com\nREPORT>>>\n",
    );
    assert.deepEqual(
      redactEmailsCommand([
        "--in",
        out,
        "--account-file",
        f.accountFile,
        "--admin-account-file",
        f.adminFile,
      ]),
      { redacted: 1 },
    );
    const text = readFileSync(out, "utf8");
    assert.ok(!/example\.com/.test(text), text);
  });
});

describe("the browser-run bundle", () => {
  const scenario = (extra) =>
    [
      "## Test scenario",
      "",
      "### Web",
      "",
      "1. Open /settings — expected: Storage card.",
      "2. (admin) Open /admin and set the quota — expected: Saved.",
      "",
      ...extra,
      "<!-- drafto-factory-test-scenario -->",
      `<!-- drafto-factory-scenario-sha:${SHA} -->`,
    ].join("\n");

  function build(body) {
    const f = files();
    return buildFactoryBrowserRunBundle({
      issue: { number: 501, title: "t" },
      headSha: SHA,
      prNumber: 7,
      targetUrl: `${PREVIEW}/`,
      deviceId: "9796912b-8977-4d74-9c08-d9bb283b9496",
      accountFile: f.accountFile,
      comments: [
        {
          id: 9,
          body,
          authorAssociation: "OWNER",
          createdAt: "2026-11-11T10:00:00Z",
          user: { login: "x" },
        },
      ],
    });
  }

  it("carries the Fixtures section and notes admin steps, with every capability off", () => {
    const b = build(scenario(["### Fixtures", "", "- small.jpg 1.5MB", ""]));
    assert.match(b.fixtureSpecs, /- small\.jpg 1\.5MB/);
    assert.equal(b.hasAdminSteps, true);
    assert.deepEqual(b.capabilities, { uploads: false, js: false, inspect: false, admin: false });
    assert.deepEqual(b.fixtures, []);
    assert.equal(b.adminAccount, null);
  });

  it("has no fixtures or admin steps when the scenario has none", () => {
    const b = build(scenario([]).replace("2. (admin) ", "2. "));
    assert.equal(b.fixtureSpecs, "");
    assert.equal(b.hasAdminSteps, false);
  });
});

describe("factory-agent.sh wiring", () => {
  it("validates the three runner switches and defaults them off", () => {
    for (const knob of ["FACTORY_BROWSER_UPLOADS", "FACTORY_BROWSER_JS", "FACTORY_BROWSER_ADMIN"]) {
      assert.ok(SCRIPT.includes(`${knob}="\${${knob}:-0}"`), knob);
    }
    assert.match(
      SCRIPT,
      /for _bk in FACTORY_BROWSER_UPLOADS FACTORY_BROWSER_JS FACTORY_BROWSER_ADMIN; do/,
    );
  });

  it("sets capabilities up only for intest and verify, before the guard config", () => {
    const fn = extract("run_browser_task");
    assert.match(fn, /if \[\[ "\$kind" != plan \]\]; then/);
    const caps = fn.indexOf("--capability uploads");
    assert.ok(caps > 0 && caps < fn.indexOf('node "$guard" config'));
    assert.match(fn, /--tools "\$tools"/);
    assert.ok(fn.indexOf("browser_capabilities_cleanup") > 0);
    assert.match(fn, /redact-emails --in "\$BROWSER_OUT"/);
  });

  it("returns the bundle unchanged unless admin steps are wanted and switched on", () => {
    const snippet = `set -euo pipefail
log() { :; }
node() { echo "NODE CALLED" >&2; return 1; }
${extract("browser_admin_link")}
browser_admin_link intest 1 ${SHA} ${PREVIEW} '{"hasAdminSteps":true}'; echo "$BROWSER_ADMIN_BUNDLE"
FACTORY_BROWSER_ADMIN=1 browser_admin_link plan 1 ${SHA} ${PREVIEW} '{"hasAdminSteps":true}'; echo "$BROWSER_ADMIN_BUNDLE"
FACTORY_BROWSER_ADMIN=1 browser_admin_link intest 1 ${SHA} ${PREVIEW} '{"hasAdminSteps":false}'; echo "$BROWSER_ADMIN_BUNDLE"
`;
    const r = spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n"), [
      '{"hasAdminSteps":true}',
      '{"hasAdminSteps":true}',
      '{"hasAdminSteps":false}',
    ]);
    assert.doesNotMatch(r.stderr, /NODE CALLED/);
  });

  it("goes on without admin steps when the admin link can't be minted", () => {
    const snippet = `set -euo pipefail
log() { echo "[12:00:00] $*"; }
node() { return 1; }
LOG_FILE=/dev/null; LOG_DIR=/tmp; SCRIPT_DIR=/x; FACTORY_BROWSER_SIGNIN_KEY_FILE=/k; FACTORY_SIGNIN_LEASE_SEC=300
BROWSER_ADMIN_LEASE_OWNER=""
${extract("browser_admin_link")}
FACTORY_BROWSER_ADMIN=1 browser_admin_link verify 1 ${SHA} ${PREVIEW} '{"hasAdminSteps":true}'
echo "BUNDLE=$BROWSER_ADMIN_BUNDLE OWNER=$BROWSER_ADMIN_LEASE_OWNER"
`;
    const r = spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    // The log line goes to stdout, but never into the bundle.
    assert.match(r.stdout, /admin steps will be SKIP/);
    assert.match(r.stdout, /BUNDLE=\{"hasAdminSteps":true\} OWNER=$/m);
  });

  it("keeps the admin lease's owner in the caller's shell, for release", () => {
    const snippet = `set -euo pipefail
log() { :; }
node() {
  case "$2" in
    mint) echo "https://drafto-x-jakubanderwalds-projects.vercel.app/auth/test-sign-in?token_hash=t" ;;
    admin-email) printf 'admin@example.com' ;;
  esac
}
LOG_FILE=/dev/null; LOG_DIR=/tmp; SCRIPT_DIR=/x; FACTORY_BROWSER_SIGNIN_KEY_FILE=/k; FACTORY_SIGNIN_LEASE_SEC=300
BROWSER_ADMIN_LEASE_OWNER=""
${extract("browser_admin_link")}
FACTORY_BROWSER_ADMIN=1 browser_admin_link verify 7 ${SHA} ${PREVIEW} '{"hasAdminSteps":true,"capabilities":{}}'
echo "OWNER=$BROWSER_ADMIN_LEASE_OWNER"
echo "$BROWSER_ADMIN_BUNDLE" | jq -c '{a: .adminAccount, c: .capabilities.admin}'
`;
    const r = spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OWNER=browser-admin:verify:7:cccccccccccc/);
    assert.match(r.stdout, /"email":"admin@example.com"/);
    assert.match(r.stdout, /"c":true/);
  });

  it("releases the admin lease in cleanup() too", () => {
    const fn = extract("cleanup");
    assert.match(
      fn,
      /BROWSER_ADMIN_LEASE_OWNER[\s\S]*release --lease-file "\$ADMIN_SIGNIN_LEASE_FILE"/,
    );
  });

  it("never writes the bundle to disk for the fixtures", () => {
    const fn = extract("run_browser_task");
    assert.doesNotMatch(fn, /bundle-in\.json/);
    assert.match(
      fn,
      /jq -r '\.fixtureSpecs \/\/ ""' \\\n\s+\| node "\$SCRIPT_DIR\/lib\/browser-fixtures\.mjs" make --out/,
    );
  });
});
