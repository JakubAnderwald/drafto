// Tests for scripts/run-dev-live-tests.mjs, the `pnpm test:live:supabase`
// runner of the dev live tests. What must hold: the keys come only from
// mode-600 files for the dev project, every refusal names the file and the
// variable but never a value, --dry-run runs nothing, and a live test started
// with DRAFTO_LIVE_REQUIRED=1 fails instead of skipping when it can't run.
//
// Every value here is fake, and every CLI run gets explicit fixture paths and
// a temp HOME, so no test reads this machine's real key files or reaches dev.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEV_SUPABASE_URL } from "../lib/browser-signin.mjs";
import {
  LIVE_TESTS,
  REPO_ROOT,
  UsageError,
  defaultPaths,
  describePlan,
  parseArgs,
  planRuns,
  runPlan,
} from "../run-dev-live-tests.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, "..", "run-dev-live-tests.mjs");
const LIVE_GUARD_TEST = path.resolve(HERE, "profile-privilege-guard.live.test.mjs");

const SERVICE_KEY = "fake-service-role-key-7f3a9c1e5b2d8640";
const TXT_DEV_KEY = "fake-keys-txt-dev-key-41c8e2a7d9b3f560";
const TXT_PROD_KEY = "fake-keys-txt-prod-key-9e1b7c3a5d2f8046";
const ANON_KEY = "fake-anon-key-c2e8a4f6b1d3957a";
const FAKE_VALUES = [SERVICE_KEY, TXT_DEV_KEY, TXT_PROD_KEY, ANON_KEY];

const KEY_FILE_OK = `DEV_SUPABASE_URL=${DEV_SUPABASE_URL}\nDEV_SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}\n`;
const ENV_LOCAL_OK =
  `NEXT_PUBLIC_SUPABASE_URL=${DEV_SUPABASE_URL}\n` +
  `NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}\n` +
  "APP_URL=http://localhost:3000\n";
const KEYS_TXT_OK = `PROD: ${TXT_PROD_KEY}\nDEV: ${TXT_DEV_KEY}\n`;

/**
 * A temp dir with the three fixture files; a `null` content leaves that file
 * out. Calls fn({dir, home, keyFile, keysTxt, envLocal}) and cleans up.
 */
function withFixture(
  fn,
  {
    key = KEY_FILE_OK,
    keyMode = 0o600,
    keysTxt = null,
    keysTxtMode = 0o600,
    envLocal = ENV_LOCAL_OK,
  } = {},
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
  if (keysTxt !== null) {
    writeFileSync(files.keysTxt, keysTxt);
    chmodSync(files.keysTxt, keysTxtMode);
  }
  if (envLocal !== null) writeFileSync(files.envLocal, envLocal);
  try {
    return fn({ dir, home, ...files });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The runner's CLI with the fixture's paths, under the fixture's HOME. */
function runCli(fx, extraArgs = []) {
  const env = { ...process.env, HOME: fx.home };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(
    process.execPath,
    [
      RUNNER,
      "--key-file",
      fx.keyFile,
      "--keys-txt",
      fx.keysTxt,
      "--env-local",
      fx.envLocal,
      ...extraArgs,
    ],
    { encoding: "utf8", env },
  );
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
        /\[profile-guard\] node --test scripts\/__tests__\/profile-privilege-guard\.live\.test\.mjs/,
      );
      assert.match(
        r.stdout,
        /\[account-deletion\] pnpm --filter @drafto\/web exec vitest run __tests__\/integration\/account-deletion\.live\.test\.ts/,
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
      assert.ok(r.stdout.includes(fx.keyFile));
      assert.ok(r.stdout.includes(fx.envLocal));
      assertNoValues(r.all);
    });
  });

  it("refuses when the key file is missing and there's no keys.txt, naming both", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"]);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(`${fx.keyFile} is missing`), r.stderr);
        assert.ok(r.stderr.includes(fx.keysTxt), r.stderr);
        assert.match(r.stderr, /factory-runbook\.md/);
        assert.equal(r.stdout, "");
      },
      { key: null },
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
        const r = runCli(fx, ["--dry-run"]);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(fx.keyFile), r.stderr);
        assert.match(r.stderr, /not for the dev project \(huhzactreblzcogqkbsd\)/);
        assertNoValues(r.all);
      },
      {
        key: `DEV_SUPABASE_URL=https://tbmjbxxseonkciqovnpl.supabase.co\nDEV_SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}\n`,
        keysTxt: KEYS_TXT_OK,
      },
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
          "NEXT_PUBLIC_SUPABASE_URL=https://tbmjbxxseonkciqovnpl.supabase.co\n" +
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

  it("falls back to the DEV: line of keys.txt when the key file is missing", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /SUPABASE_SERVICE_ROLE_KEY {2}\(.*supabase service keys\.txt\)/);
        assertNoValues(r.all);
      },
      { key: null, keysTxt: KEYS_TXT_OK },
    );
  });

  it("refuses a keys.txt with no DEV: line, or one other users can read", () => {
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"]);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(`${fx.keysTxt} has no DEV: line`), r.stderr);
        assertNoValues(r.all);
      },
      { key: null, keysTxt: `PROD: ${TXT_PROD_KEY}\n` },
    );
    withFixture(
      (fx) => {
        const r = runCli(fx, ["--dry-run"]);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(`${fx.keysTxt} is open to other users`), r.stderr);
      },
      { key: null, keysTxt: KEYS_TXT_OK, keysTxtMode: 0o644 },
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

  it("accepts the `--` pnpm may pass through, and exits 2 on bad arguments", () => {
    withFixture((fx) => {
      const ok = runCli(fx, ["--", "--only", "profile-guard", "--dry-run"]);
      assert.equal(ok.status, 0, ok.stderr);
      assert.doesNotMatch(ok.stdout, /\[account-deletion\]/);
      for (const bad of [["--only", "everything"], ["--bogus", "x"], ["stray"], ["--only"]]) {
        const r = runCli(fx, [...bad, "--dry-run"]);
        assert.equal(r.status, 2, `${bad.join(" ")}: ${r.stderr}`);
        assert.match(r.stderr, /run-dev-live-tests: /);
      }
    });
  });
});

describe("parseArgs", () => {
  const defaults = { keyFile: "/k", keysTxt: "/t", envLocal: "/e" };

  it("uses the defaults and reads every flag", () => {
    assert.deepEqual(parseArgs([], defaults), { ...defaults, only: null, dryRun: false });
    assert.deepEqual(
      parseArgs(
        ["--key-file", "/a", "--keys-txt=/b", "--env-local", "/c", "--only", "profile-guard"],
        defaults,
      ),
      { keyFile: "/a", keysTxt: "/b", envLocal: "/c", only: "profile-guard", dryRun: false },
    );
    assert.equal(parseArgs(["--dry-run"], defaults).dryRun, true);
  });

  it("throws UsageError on unknown flags, stray words and a bad --only", () => {
    for (const argv of [["--nope", "1"], ["x"], ["--only", "all"], ["--key-file"]]) {
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
  it("sets the dev URL, both keys and DRAFTO_LIVE_REQUIRED=1", () => {
    withFixture((fx) => {
      const plan = planRuns({ ...fx, only: null });
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
      assertNoValues(describePlan(plan));
    });
  });
});

describe("runPlan", () => {
  const plan = {
    runs: [
      { name: "a", command: "node", args: ["--test", "x"], display: "node --test x" },
      { name: "b", command: "pnpm", args: ["exec", "y"], display: "pnpm exec y" },
    ],
    env: { SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, DRAFTO_LIVE_REQUIRED: "1" },
  };

  function stubSpawn(results) {
    const calls = [];
    const spawnImpl = (command, args, opts) => {
      calls.push({ command, args, opts });
      return results[calls.length - 1];
    };
    return { calls, spawnImpl };
  }

  it("runs every test from the repo root with the env merged over the base env", () => {
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
      assert.equal(c.opts.env.PATH, "/bin");
      assert.equal(c.opts.env.SUPABASE_SERVICE_ROLE_KEY, SERVICE_KEY);
      assert.equal(c.opts.env.DRAFTO_LIVE_REQUIRED, "1");
    }
    assert.match(lines.join("\n"), /a: passed\n.*b: passed/);
    assertNoValues(lines.join("\n"));
  });

  it("runs the rest after a failure and exits 1", () => {
    for (const first of [
      { status: 1 },
      { status: null, signal: "SIGTERM" },
      { error: Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }) },
    ]) {
      const { calls, spawnImpl } = stubSpawn([first, { status: 0 }]);
      const lines = [];
      const code = runPlan({ ...plan, baseEnv: {}, spawnImpl, log: (l) => lines.push(l) });
      assert.equal(code, 1);
      assert.equal(calls.length, 2, "the second test still ran");
      assert.match(lines.join("\n"), /a: (failed \(exit 1\)|killed by SIGTERM|could not start)/);
    }
  });
});

describe("live tests with DRAFTO_LIVE_REQUIRED", () => {
  // A clean env: no Supabase vars from the caller's shell, so the live test
  // can never actually run (and reach dev) here.
  function liveEnv(extra) {
    const env = { ...process.env };
    for (const name of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "DRAFTO_LIVE_REQUIRED",
      "NODE_TEST_CONTEXT",
    ]) {
      delete env[name];
    }
    return { ...env, ...extra };
  }

  function runLive(extra) {
    const r = spawnSync(process.execPath, ["--test", LIVE_GUARD_TEST], {
      encoding: "utf8",
      env: liveEnv(extra),
    });
    return { ...r, all: `${r.stdout}\n${r.stderr}` };
  }

  it("skips (exit 0) without DRAFTO_LIVE_REQUIRED, as in CI", () => {
    const r = runLive({});
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /SKIP|skipped/i);
  });

  it("fails naming every missing variable with DRAFTO_LIVE_REQUIRED=1", () => {
    const r = runLive({ DRAFTO_LIVE_REQUIRED: "1" });
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.all, /DRAFTO_LIVE_REQUIRED=1, but the live test can't run/);
    for (const name of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]) {
      assert.ok(r.all.includes(name), name);
    }
  });

  it("fails on a non-dev URL without printing the keys", () => {
    const r = runLive({
      DRAFTO_LIVE_REQUIRED: "1",
      NEXT_PUBLIC_SUPABASE_URL: "https://tbmjbxxseonkciqovnpl.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    });
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.all, /NEXT_PUBLIC_SUPABASE_URL \(not https:\/\/huhzactreblzcogqkbsd/);
    assert.doesNotMatch(r.all, /Missing or wrong: .*SUPABASE_SERVICE_ROLE_KEY/);
    assertNoValues(r.all);
  });
});
