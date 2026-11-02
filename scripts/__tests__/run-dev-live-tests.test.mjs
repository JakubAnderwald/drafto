// Tests for scripts/run-dev-live-tests.mjs, the `pnpm test:live:supabase`
// runner of the dev live tests. What must hold: the keys come only from
// mode-600 files for the dev project, every refusal names the file and the
// variable but never a value, --dry-run runs nothing, unattended sessions and
// node --test are refused before any key file is read, and a live test started
// with DRAFTO_LIVE_REQUIRED=1 fails instead of skipping when it can't run.
//
// Every value here is fake, and every CLI run gets fixture paths and a temp
// HOME, so no test reads this machine's real key files or reaches dev.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEV_SUPABASE_URL } from "../lib/browser-signin.mjs";
import {
  LIVE_TESTS,
  REPO_ROOT,
  TEST_TIMEOUT_MS,
  USAGE,
  UsageError,
  defaultPaths,
  describePlan,
  inspectServiceKey,
  parseArgs,
  planRuns,
  refusalReason,
  runPlan,
} from "../run-dev-live-tests.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, "..", "run-dev-live-tests.mjs");
const LIVE_GUARD_TEST = path.resolve(HERE, "profile-privilege-guard.live.test.mjs");

const DEV_REF = "huhzactreblzcogqkbsd";
const PROD_REF = "tbmjbxxseonkciqovnpl";

/** A JWT-shaped fake key with <claims>; the signature is never checked. */
function fakeJwt(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.ZmFrZS1zaWduYXR1cmUtMDEyMzQ1Njc4OQ`;
}

const SERVICE_KEY = "fake-service-role-key-7f3a9c1e5b2d8640";
const TXT_DEV_KEY = "sb_secret_fake-keys-txt-dev-key-41c8e2a7d9b3f560";
const TXT_PROD_KEY = "fake-keys-txt-prod-key-9e1b7c3a5d2f8046";
const ANON_KEY = "fake-anon-key-c2e8a4f6b1d3957a";
const DEV_JWT = fakeJwt({ iss: "supabase", ref: DEV_REF, role: "service_role" });
const PROD_JWT = fakeJwt({ iss: "supabase", ref: PROD_REF, role: "service_role" });
const DEV_ANON_JWT = fakeJwt({ iss: "supabase", ref: DEV_REF, role: "anon" });
const GARBLED_JWT = "eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24.ZmFrZS1zaWduYXR1cmU";
const FAKE_VALUES = [
  SERVICE_KEY,
  TXT_DEV_KEY,
  TXT_PROD_KEY,
  ANON_KEY,
  DEV_JWT,
  PROD_JWT,
  DEV_ANON_JWT,
  GARBLED_JWT,
];

const KEY_FILE_OK = `DEV_SUPABASE_URL=${DEV_SUPABASE_URL}\nDEV_SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}\n`;
const ENV_LOCAL_OK =
  `NEXT_PUBLIC_SUPABASE_URL=${DEV_SUPABASE_URL}\n` +
  `NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}\n` +
  "APP_URL=http://localhost:3000\n";
const keysTxt = (dev) => `PROD: ${TXT_PROD_KEY}\nDEV: ${dev}\n`;

/**
 * A temp dir with the three fixture files; a `null` content leaves that file
 * out. The key files sit where the defaults look under the temp HOME. Calls
 * fn({dir, home, keyFile, keysTxt, envLocal}) and cleans up.
 */
function withFixture(
  fn,
  { key = KEY_FILE_OK, keyMode = 0o600, txt = null, txtMode = 0o600, envLocal = ENV_LOCAL_OK } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "run-dev-live-tests-"));
  const home = path.join(dir, "home");
  mkdirSync(path.join(home, "drafto-secrets"), { recursive: true });
  const files = {
    keyFile: path.join(home, "drafto-secrets", "dev-supabase-admin.env"),
    keysTxt: path.join(home, "drafto-secrets", "supabase service keys.txt"),
    envLocal: path.join(dir, "web.env.local"),
  };
  if (key !== null) {
    writeFileSync(files.keyFile, key);
    chmodSync(files.keyFile, keyMode);
  }
  if (txt !== null) {
    writeFileSync(files.keysTxt, txt);
    chmodSync(files.keysTxt, txtMode);
  }
  if (envLocal !== null) writeFileSync(files.envLocal, envLocal);
  try {
    return fn({ dir, home, ...files });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The caller's env minus anything that would change what the child does:
// Supabase keys, the live-test switch, and the unattended / test-runner
// markers the runner refuses under (the factory exports DRAFTO_UNATTENDED, and
// node --test sets NODE_TEST_CONTEXT for this file).
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DRAFTO_LIVE_REQUIRED",
    "DRAFTO_UNATTENDED",
    "NODE_TEST_CONTEXT",
  ]) {
    delete env[name];
  }
  return { ...env, ...extra };
}

/**
 * The runner's CLI under the fixture's HOME. --key-file is passed unless
 * keyFileFlag is false (then the default path, inside the temp HOME, is used).
 */
function runCli(fx, extraArgs = [], { keyFileFlag = true, env = {} } = {}) {
  const args = [
    RUNNER,
    ...(keyFileFlag ? ["--key-file", fx.keyFile] : []),
    "--keys-txt",
    fx.keysTxt,
    "--env-local",
    fx.envLocal,
    ...extraArgs,
  ];
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: cleanEnv({ HOME: fx.home, ...env }),
  });
  return { ...r, all: `${r.stdout}\n${r.stderr}` };
}

function assertNoValues(text) {
  for (const value of FAKE_VALUES) assert.ok(!text.includes(value), "a key value was printed");
}

describe("run-dev-live-tests CLI --dry-run", () => {
  it("prints both commands and the env var names, and no value", () => {
    withFixture((fx) => {
      const r = runCli(fx, ["--dry-run"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Dry run: nothing executed/);
      assert.match(
        r.stdout,
        /\[profile-guard\] node --test scripts\/__tests__\/profile-privilege-guard\.live\.test\.mjs\n {6}sets NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DRAFTO_LIVE_REQUIRED\n/,
      );
      assert.match(
        r.stdout,
        /\[account-deletion\] pnpm --filter @drafto\/web exec vitest run __tests__\/integration\/account-deletion\.live\.test\.ts\n {6}sets NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DRAFTO_LIVE_REQUIRED\n/,
      );
      for (const name of [
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "DRAFTO_LIVE_REQUIRED",
      ]) {
        assert.match(r.stdout, new RegExp(`^  ${name}  \\(`, "m"), name);
      }
      // It says where each key came from, by file.
      assert.ok(r.stdout.includes(`SUPABASE_SERVICE_ROLE_KEY  (${fx.keyFile})`));
      assert.ok(r.stdout.includes(fx.envLocal));
      assertNoValues(r.all);
    });
  });

  it("refuses when the default key file is missing and there's no keys.txt, naming both", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"], { keyFileFlag: false });
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(`${fx.keyFile} is missing`), r.stderr);
        assert.ok(r.stderr.includes(fx.keysTxt), r.stderr);
        assert.match(r.stderr, /factory-runbook\.md/);
        assert.equal(r.stdout, "");
      },
      { key: null },
    );
  });

  it("never falls back to keys.txt from an explicit --key-file", () => {
    withFixture(
      (fx) => {
        const missing = path.join(fx.dir, "nope.env");
        const r = runCli(fx, ["--key-file", missing, "--dry-run"], { keyFileFlag: false });
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(`${missing} is missing`), r.stderr);
        assert.match(r.stderr, /given with --key-file, so keys\.txt isn't tried/);
        assert.equal(r.stdout, "");
        assertNoValues(r.all);
        // An empty --key-file is a usage error, not the default path.
        for (const empty of [["--key-file="], ["--key-file", ""]]) {
          const e = runCli(fx, [...empty, "--dry-run"], { keyFileFlag: false });
          assert.equal(e.status, 2, e.stderr);
          assert.match(e.stderr, /--key-file needs a path/);
        }
      },
      { key: null, txt: keysTxt(DEV_JWT) },
    );
  });

  it("refuses a key file other users can read", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"]);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(`${fx.keyFile} is open to other users`), r.stderr);
        assert.match(r.stderr, /chmod 600/);
        assertNoValues(r.all);
      },
      { keyMode: 0o644 },
    );
  });

  it("refuses a key file that isn't for the dev project, and doesn't fall back", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"], { keyFileFlag: false });
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(fx.keyFile), r.stderr);
        assert.match(r.stderr, /not for the dev project \(huhzactreblzcogqkbsd\)/);
        assertNoValues(r.all);
      },
      {
        key: `DEV_SUPABASE_URL=https://${PROD_REF}.supabase.co\nDEV_SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}\n`,
        txt: keysTxt(DEV_JWT),
      },
    );
  });

  it("refuses a key file whose JWT key is another project's, under the dev URL", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"]);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(`${fx.keyFile}: its key is not for the dev project`));
        assertNoValues(r.all);
      },
      { key: `DEV_SUPABASE_URL=${DEV_SUPABASE_URL}\nDEV_SUPABASE_SERVICE_ROLE_KEY=${PROD_JWT}\n` },
    );
  });

  it("names the missing variable of a key file without its service-role key", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"]);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(fx.keyFile), r.stderr);
        assert.match(r.stderr, /no DEV_SUPABASE_SERVICE_ROLE_KEY/);
      },
      { key: `DEV_SUPABASE_URL=${DEV_SUPABASE_URL}\n` },
    );
  });

  it("refuses an .env.local whose URL isn't the dev project", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"]);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(fx.envLocal), r.stderr);
        assert.match(r.stderr, /NEXT_PUBLIC_SUPABASE_URL is not the dev project/);
        assertNoValues(r.all);
      },
      {
        envLocal:
          `NEXT_PUBLIC_SUPABASE_URL=https://${PROD_REF}.supabase.co\n` +
          `NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}\n`,
      },
    );
  });

  it("names the anon key when .env.local lacks it, or the file when it's gone", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"]);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(`${fx.envLocal} has no NEXT_PUBLIC_SUPABASE_ANON_KEY`));
        assertNoValues(r.all);
      },
      { envLocal: `NEXT_PUBLIC_SUPABASE_URL=${DEV_SUPABASE_URL}\n` },
    );
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"]);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(`${fx.envLocal} is missing`), r.stderr);
        assert.match(r.stderr, /worktree-bootstrap\.sh/);
      },
      { envLocal: null },
    );
  });

  it("falls back to a dev JWT on the DEV: line of keys.txt when the default file is missing", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"], { keyFileFlag: false });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.stdout.includes(`SUPABASE_SERVICE_ROLE_KEY  (${fx.keysTxt})`), r.stdout);
        assertNoValues(r.all);
      },
      { key: null, txt: keysTxt(DEV_JWT) },
    );
  });

  it("uses a non-JWT DEV: key but says its project couldn't be verified", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"], { keyFileFlag: false });
        assert.equal(r.status, 0, r.stderr);
        assert.match(
          r.stdout,
          /SUPABASE_SERVICE_ROLE_KEY {2}\(.*supabase service keys\.txt; not a JWT, so its project couldn't be verified\)/,
        );
        assertNoValues(r.all);
      },
      { key: null, txt: keysTxt(TXT_DEV_KEY) },
    );
  });

  it("refuses a DEV: line whose JWT is prod's, an anon key, or unreadable", () => {
    for (const [dev, why] of [
      [PROD_JWT, /its key is not for the dev project \(huhzactreblzcogqkbsd\)/],
      [DEV_ANON_JWT, /its key is not a service_role key/],
      [GARBLED_JWT, /payload can't be read/],
    ]) {
      withFixture(
        (fx) => {
          const r = runCli(fx, ["--dry-run"], { keyFileFlag: false });
          assert.equal(r.status, 1, r.all);
          assert.ok(r.stderr.includes(`${fx.keysTxt}: `), r.stderr);
          assert.match(r.stderr, why);
          assert.equal(r.stdout, "");
          assertNoValues(r.all);
        },
        { key: null, txt: keysTxt(dev) },
      );
    }
  });

  it("refuses a keys.txt with no DEV: line, or one other users can read", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"], { keyFileFlag: false });
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(`${fx.keysTxt} has no DEV: line`), r.stderr);
        assertNoValues(r.all);
      },
      { key: null, txt: `PROD: ${TXT_PROD_KEY}\n` },
    );
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"], { keyFileFlag: false });
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(`${fx.keysTxt} is open to other users`), r.stderr);
      },
      { key: null, txt: keysTxt(DEV_JWT), txtMode: 0o644 },
    );
  });

  it("--only account-deletion plans one command and needs no .env.local", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--only", "account-deletion", "--dry-run"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /\[account-deletion\]/);
        assert.doesNotMatch(r.stdout, /\[profile-guard\]/);
        assert.doesNotMatch(r.stdout, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
        assertNoValues(r.all);
      },
      { envLocal: null },
    );
  });

  it("accepts the `--` pnpm may pass through, prints --help, and exits 2 on bad arguments", () => {
    withFixture((fx) => {
      const ok = runCli(fx, ["--", "--only", "profile-guard", "--dry-run"]);
      assert.equal(ok.status, 0, ok.stderr);
      assert.doesNotMatch(ok.stdout, /\[account-deletion\]/);
      for (const help of ["--help", "-h"]) {
        const h = runCli(fx, [help]);
        assert.equal(h.status, 0, h.stderr);
        assert.equal(h.stdout, `${USAGE}\n`);
      }
      for (const bad of [["--only", "everything"], ["--bogus", "x"], ["stray"], ["--only"]]) {
        const r = runCli(fx, [...bad, "--dry-run"]);
        assert.equal(r.status, 2, `${bad.join(" ")}: ${r.stderr}`);
        assert.match(r.stderr, /run-dev-live-tests: /);
      }
    });
  });
});

describe("run-dev-live-tests refuses unattended and test-runner sessions", () => {
  it("refuses under DRAFTO_UNATTENDED=1 or NODE_TEST_CONTEXT before reading a key file", () => {
    // No key file and no keys.txt: a run that got as far as reading keys would
    // fail with "is missing" instead of the refusal.
    withFixture(
      (fx) => {
        // Any value of the marker refuses, so an unexpected one fails closed.
        for (const env of [
          { DRAFTO_UNATTENDED: "1" },
          { DRAFTO_UNATTENDED: "true" },
          { DRAFTO_UNATTENDED: "0" },
          { NODE_TEST_CONTEXT: "child-v8" },
        ]) {
          const r = runCli(fx, ["--dry-run"], { keyFileFlag: false, env });
          assert.equal(r.status, 1, r.all);
          assert.match(r.stderr, /run-dev-live-tests: refused: /);
          assert.doesNotMatch(r.stderr, /is missing/);
          assert.equal(r.stdout, "");
        }
        // An empty marker is no marker: the run goes on and finds no key.
        const r = runCli(fx, ["--dry-run"], {
          keyFileFlag: false,
          env: { DRAFTO_UNATTENDED: "" },
        });
        assert.match(r.stderr, /is missing/);
      },
      { key: null },
    );
  });

  it("refuses when started as a test file by node --test, in either isolation", () => {
    // Node 22 spells the no-isolation flag --experimental-test-isolation (CI's
    // version); later releases spell it --test-isolation. Use whichever this
    // node accepts.
    const noIsolation = ["--test-isolation=none", "--experimental-test-isolation=none"].find(
      (flag) =>
        !/bad option/.test(
          spawnSync(process.execPath, [flag, "-e", "0"], { encoding: "utf8" }).stderr,
        ),
    );
    assert.ok(noIsolation, "this node accepts neither spelling of the test-isolation flag");
    withFixture(
      (fx) => {
        for (const isolation of [[], [noIsolation]]) {
          const r = spawnSync(process.execPath, ["--test", ...isolation, RUNNER], {
            encoding: "utf8",
            env: cleanEnv({ HOME: fx.home }),
          });
          const all = `${r.stdout}\n${r.stderr}`;
          assert.notEqual(r.status, 0, all);
          assert.match(all, /refused: running under node --test/, isolation.join(" "));
          assert.doesNotMatch(all, /is missing/);
        }
      },
      { key: null },
    );
  });

  it("refusalReason names the marker and the test runner", () => {
    assert.equal(refusalReason({ env: {}, execArgv: [] }), null);
    assert.equal(refusalReason({ env: { DRAFTO_UNATTENDED: "" }, execArgv: [] }), null);
    for (const value of ["1", "0", "true"]) {
      assert.match(
        refusalReason({ env: { DRAFTO_UNATTENDED: value }, execArgv: [] }),
        /DRAFTO_UNATTENDED is set/,
      );
    }
    assert.match(
      refusalReason({ env: { NODE_TEST_CONTEXT: "child" }, execArgv: [] }),
      /node --test/,
    );
    assert.match(refusalReason({ env: {}, execArgv: ["--test"] }), /node --test/);
  });

  it("the factory, support and nightly scripts all export the marker", () => {
    for (const script of [
      "factory-agent.sh",
      "support-agent.sh",
      "nightly-support.sh",
      "nightly-audit.sh",
    ]) {
      const text = readFileSync(path.join(REPO_ROOT, "scripts", script), "utf8");
      assert.match(text, /^export DRAFTO_UNATTENDED=1$/m, script);
    }
  });
});

describe("inspectServiceKey", () => {
  it("accepts a dev service_role JWT, and a JWT with no role claim", () => {
    assert.deepEqual(inspectServiceKey(DEV_JWT), { jwt: true, problem: null });
    assert.deepEqual(inspectServiceKey(fakeJwt({ ref: DEV_REF })), { jwt: true, problem: null });
  });

  it("names the problem of another project's, an anon or a garbled JWT, never a claim", () => {
    for (const [key, why] of [
      [PROD_JWT, /not for the dev project/],
      [fakeJwt({ role: "service_role" }), /not for the dev project/],
      [DEV_ANON_JWT, /not a service_role key/],
      [GARBLED_JWT, /payload can't be read/],
    ]) {
      const r = inspectServiceKey(key);
      assert.equal(r.jwt, true);
      assert.match(r.problem, why);
      assert.ok(!r.problem.includes(PROD_REF));
    }
  });

  it("can't check a key that isn't a JWT", () => {
    for (const key of [TXT_DEV_KEY, SERVICE_KEY, "a.b", "a.b.c.d"]) {
      assert.deepEqual(inspectServiceKey(key), { jwt: false, problem: null }, key);
    }
  });
});

describe("parseArgs", () => {
  const defaults = { keyFile: "/k", keysTxt: "/t", envLocal: "/e" };

  it("uses the defaults and reads every flag", () => {
    assert.deepEqual(parseArgs([], defaults), {
      ...defaults,
      keyFileGiven: false,
      only: null,
      dryRun: false,
      help: false,
    });
    assert.deepEqual(
      parseArgs(
        ["--key-file", "/a", "--keys-txt=/b", "--env-local", "/c", "--only", "profile-guard"],
        defaults,
      ),
      {
        keyFile: "/a",
        keyFileGiven: true,
        keysTxt: "/b",
        envLocal: "/c",
        only: "profile-guard",
        dryRun: false,
        help: false,
      },
    );
    assert.equal(parseArgs(["--dry-run"], defaults).dryRun, true);
    assert.equal(parseArgs(["--help"], defaults).help, true);
  });

  it("throws UsageError on unknown flags, stray words, empty paths and a bad --only", () => {
    for (const argv of [
      ["--nope", "1"],
      ["x"],
      ["--only", "all"],
      ["--key-file"],
      ["--key-file="],
      ["--keys-txt", ""],
      ["--env-local="],
    ]) {
      assert.throws(() => parseArgs(argv, defaults), UsageError, argv.join(" "));
    }
  });

  it("defaults to ~/drafto-secrets and the repo's apps/web/.env.local", () => {
    const d = defaultPaths({ home: "/h", repoRoot: "/r" });
    assert.equal(d.keyFile, "/h/drafto-secrets/dev-supabase-admin.env");
    assert.equal(d.keysTxt, "/h/drafto-secrets/supabase service keys.txt");
    assert.equal(d.envLocal, "/r/apps/web/.env.local");
  });
});

describe("planRuns + describePlan", () => {
  it("sets the dev URL, both keys and DRAFTO_LIVE_REQUIRED=1, each test only what it needs", () => {
    withFixture((fx) => {
      const plan = planRuns({ ...fx, keyFileGiven: true, only: null });
      assert.deepEqual(plan.env, {
        NEXT_PUBLIC_SUPABASE_URL: DEV_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
        DRAFTO_LIVE_REQUIRED: "1",
      });
      assert.deepEqual(
        plan.runs.map((r) => r.name),
        Object.keys(LIVE_TESTS),
      );
      const byName = Object.fromEntries(plan.runs.map((r) => [r.name, r.env]));
      assert.deepEqual(byName["profile-guard"], plan.env);
      assert.deepEqual(byName["account-deletion"], {
        NEXT_PUBLIC_SUPABASE_URL: DEV_SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
        DRAFTO_LIVE_REQUIRED: "1",
      });
      assertNoValues(describePlan(plan));
    });
  });

  it("reads and sets only what the selected tests need", () => {
    const tests = {
      "service-only": { command: "node", args: ["x"], needs: ["SUPABASE_SERVICE_ROLE_KEY"] },
      "url-only": { command: "node", args: ["y"], needs: ["NEXT_PUBLIC_SUPABASE_URL"] },
    };
    // No .env.local: nothing here needs the anon key.
    withFixture(
      (fx) => {
        const s = planRuns({ ...fx, keyFileGiven: true, only: "service-only" }, tests);
        assert.deepEqual(s.env, {
          SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
          DRAFTO_LIVE_REQUIRED: "1",
        });
        assert.deepEqual(Object.keys(s.sources), [
          "SUPABASE_SERVICE_ROLE_KEY",
          "DRAFTO_LIVE_REQUIRED",
        ]);
      },
      { envLocal: null },
    );
    // No key file either: a test that needs only the URL reads no key at all.
    withFixture(
      (fx) => {
        const u = planRuns({ ...fx, keyFileGiven: true, only: "url-only" }, tests);
        assert.deepEqual(u.env, {
          NEXT_PUBLIC_SUPABASE_URL: DEV_SUPABASE_URL,
          DRAFTO_LIVE_REQUIRED: "1",
        });
      },
      { key: null, envLocal: null },
    );
  });
});

describe("runPlan", () => {
  const plan = {
    runs: [
      {
        name: "a",
        command: "node",
        args: ["--test", "x"],
        display: "node --test x",
        env: { SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, DRAFTO_LIVE_REQUIRED: "1" },
      },
      {
        name: "b",
        command: "pnpm",
        args: ["exec", "y"],
        display: "pnpm exec y",
        env: { NEXT_PUBLIC_SUPABASE_URL: DEV_SUPABASE_URL, DRAFTO_LIVE_REQUIRED: "1" },
      },
    ],
  };

  function stubSpawn(results) {
    const calls = [];
    const spawnImpl = (command, args, opts) => {
      calls.push({ command, args, opts });
      return results[calls.length - 1];
    };
    return { calls, spawnImpl };
  }

  it("runs every test from the repo root with its env over the base env, under a timeout", () => {
    const { calls, spawnImpl } = stubSpawn([{ status: 0 }, { status: 0 }]);
    const lines = [];
    const code = runPlan({
      ...plan,
      baseEnv: { PATH: "/bin", SUPABASE_SERVICE_ROLE_KEY: "stale" },
      spawnImpl,
      log: (l) => lines.push(l),
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, process.execPath, "node is this Node binary");
    assert.equal(calls[1].command, "pnpm");
    for (const c of calls) {
      assert.equal(c.opts.cwd, REPO_ROOT);
      assert.equal(c.opts.stdio, "inherit");
      assert.equal(c.opts.timeout, TEST_TIMEOUT_MS);
      assert.equal(c.opts.env.PATH, "/bin");
      assert.equal(c.opts.env.DRAFTO_LIVE_REQUIRED, "1");
    }
    assert.equal(calls[0].opts.env.SUPABASE_SERVICE_ROLE_KEY, SERVICE_KEY);
    assert.equal(calls[1].opts.env.NEXT_PUBLIC_SUPABASE_URL, DEV_SUPABASE_URL);
    assert.equal(TEST_TIMEOUT_MS, 15 * 60_000);
    assert.match(lines.join("\n"), /a: passed\n.*b: passed/);
    assertNoValues(lines.join("\n"));
  });

  it("runs the rest after a failure, a kill, a failed start or a timeout, and exits 1", () => {
    for (const [first, outcome] of [
      [{ status: 1 }, /a: failed \(exit 1\)/],
      [{ status: null, signal: "SIGKILL" }, /a: killed by SIGKILL/],
      [
        { error: Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" }) },
        /a: could not start \(ENOENT\)/,
      ],
      [
        {
          status: null,
          signal: "SIGTERM",
          error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }),
        },
        /a: timed out after 15 min/,
      ],
    ]) {
      const { calls, spawnImpl } = stubSpawn([first, { status: 0 }]);
      const lines = [];
      const code = runPlan({ ...plan, baseEnv: {}, spawnImpl, log: (l) => lines.push(l) });
      assert.equal(code, 1);
      assert.equal(calls.length, 2, "the second test still ran");
      assert.match(lines.join("\n"), outcome);
    }
  });
});

describe("live tests with DRAFTO_LIVE_REQUIRED", () => {
  // cleanEnv drops every Supabase var from the caller's shell, so the live
  // tests can never actually run (and reach dev) here.
  function runGuard(extra) {
    const r = spawnSync(process.execPath, ["--test", LIVE_GUARD_TEST], {
      encoding: "utf8",
      env: cleanEnv(extra),
    });
    return { ...r, all: `${r.stdout}\n${r.stderr}` };
  }

  function runAccountDeletion(extra) {
    const r = spawnSync("pnpm", LIVE_TESTS["account-deletion"].args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: cleanEnv(extra),
      timeout: 120_000,
    });
    return { ...r, all: `${r.stdout}\n${r.stderr}` };
  }

  it("profile guard: skips (exit 0) without DRAFTO_LIVE_REQUIRED, as in CI", () => {
    const r = runGuard({});
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /SKIP|skipped/i);
  });

  it("profile guard: fails naming every missing variable with DRAFTO_LIVE_REQUIRED=1", () => {
    const r = runGuard({ DRAFTO_LIVE_REQUIRED: "1" });
    assert.notEqual(r.status, 0, r.all);
    assert.match(
      r.all,
      /DRAFTO_LIVE_REQUIRED=1, but the live test can't run\. Missing or wrong: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY/,
    );
  });

  it("profile guard: fails on a non-dev or plain-http URL without printing the keys", () => {
    for (const url of [`https://${PROD_REF}.supabase.co`, `http://${DEV_REF}.supabase.co`]) {
      const r = runGuard({
        DRAFTO_LIVE_REQUIRED: "1",
        NEXT_PUBLIC_SUPABASE_URL: url,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      });
      assert.notEqual(r.status, 0, r.all);
      assert.match(
        r.all,
        /Missing or wrong: NEXT_PUBLIC_SUPABASE_URL \(not https:\/\/huhzactreblzcogqkbsd\.supabase\.co\)(?!, )/,
      );
      assertNoValues(r.all);
    }
  });

  it(
    "account deletion (vitest): skips without the flag, fails naming the variables with it",
    { timeout: 300_000 },
    () => {
      const skipped = runAccountDeletion({});
      assert.equal(skipped.status, 0, skipped.all);
      assert.match(skipped.all, /skipped/);

      const failed = runAccountDeletion({ DRAFTO_LIVE_REQUIRED: "1" });
      assert.notEqual(failed.status, 0, failed.all);
      assert.match(
        failed.all,
        /DRAFTO_LIVE_REQUIRED=1, but the live test can't run\. Missing or wrong: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/,
      );

      const http = runAccountDeletion({
        DRAFTO_LIVE_REQUIRED: "1",
        NEXT_PUBLIC_SUPABASE_URL: `http://${DEV_REF}.supabase.co`,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      });
      assert.notEqual(http.status, 0, http.all);
      assert.match(
        http.all,
        /Missing or wrong: NEXT_PUBLIC_SUPABASE_URL \(not https:\/\/huhzactreblzcogqkbsd\.supabase\.co\)/,
      );
      assertNoValues(http.all);
    },
  );
});
