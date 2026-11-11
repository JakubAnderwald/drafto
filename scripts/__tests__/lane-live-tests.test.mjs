import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  filterLiveOutput,
  liveTestNames,
  liveTestsMain,
  outcomeFrom,
  runLiveTest,
  runScenarioLiveTests,
} from "../lib/lane-live-tests.mjs";

const DEV = "https://huhzactreblzcogqkbsd.supabase.co";
const KEY = "test-service-role-key-0123456789";

function tempConfig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lane-live-"));
  const keyFile = path.join(dir, "key.env");
  writeFileSync(keyFile, `DEV_SUPABASE_URL=${DEV}\nDEV_SUPABASE_SERVICE_ROLE_KEY=${KEY}\n`, {
    mode: 0o600,
  });
  const envLocal = path.join(dir, ".env.local");
  writeFileSync(envLocal, "NEXT_PUBLIC_SUPABASE_URL=x\n");
  const worktree = path.join(dir, "wt");
  mkdirSync(path.join(worktree, "scripts"), { recursive: true });
  writeFileSync(path.join(worktree, "scripts", "run-dev-live-tests.mjs"), "");
  return {
    keyFile,
    envLocal,
    worktree,
    node: "/usr/bin/node",
    home: dir,
    tmpdir: dir,
    path: "/usr/bin:/bin",
  };
}

/** A fake spawn that prints <output> and exits <code>; records its call. */
function fakeSpawn(output, code = 0) {
  const calls = [];
  const fn = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.pid = 999999;
    setImmediate(() => {
      child.stdout.end(output);
      child.stderr.end();
      child.emit("close", code, null);
    });
    return child;
  };
  return { fn, calls };
}

const SPEC_OUTPUT = [
  "[run-dev-live-tests] storage-quota: node --test scripts/__tests__/storage-quota.live.test.mjs",
  "▶ per-user attachment storage quota (live, dev project)",
  "  ✔ refuses a row past the quota (450ms)",
  "  ✖ counts the objects a user stored without rows (12ms)",
  "    AssertionError: expected 350, got 0",
  "      at TestContext.<anonymous> (file:///x.mjs:10:5)",
  "ℹ tests 2",
  "ℹ fail 1",
  "",
  "[run-dev-live-tests] summary:",
  "  storage-quota: failed (exit 1)",
].join("\n");

describe("filterLiveOutput", () => {
  it("keeps result lines and totals, and drops messages and stack traces", () => {
    const { lines, withheld } = filterLiveOutput(SPEC_OUTPUT);
    assert.equal(withheld, false);
    assert.deepEqual(lines, [
      "  ✔ refuses a row past the quota (450ms)",
      "  ✖ counts the objects a user stored without rows (12ms)",
      "ℹ tests 2",
      "ℹ fail 1",
      "  storage-quota: failed (exit 1)",
    ]);
  });

  it("keeps TAP and vitest lines", () => {
    const { lines } = filterLiveOutput(
      ["ok 1 - a", "not ok 2 - b", " ✓ c > d", " × e", " Test Files  1 passed (1)", "noise"].join(
        "\n",
      ),
    );
    assert.deepEqual(lines, [
      "ok 1 - a",
      "not ok 2 - b",
      " ✓ c > d",
      " × e",
      " Test Files  1 passed (1)",
    ]);
  });

  it("withholds everything when a kept line carries the key", () => {
    const r = filterLiveOutput(`  ✔ leaks ${KEY}\n  ✔ fine`, { secrets: [KEY] });
    assert.deepEqual(r, { lines: [], withheld: true });
  });

  it("withholds everything when a kept line looks like a JWT or a secret key", () => {
    assert.equal(filterLiveOutput("  ✔ eyJhbGciOiJIUzI1.eyJyb2xlIjoic2Vy.x").withheld, true);
    assert.equal(filterLiveOutput("  ✔ sb_secret_abcdefghijkl").withheld, true);
  });

  it("ignores a secret on a dropped line", () => {
    const r = filterLiveOutput(`AssertionError: ${KEY}\n  ✔ ok`, { secrets: [KEY] });
    assert.deepEqual(r, { lines: ["  ✔ ok"], withheld: false });
  });

  it("caps line length", () => {
    const { lines } = filterLiveOutput(`  ✔ ${"x".repeat(500)}`);
    assert.ok(lines[0].length <= 201);
  });
});

describe("outcomeFrom", () => {
  it("reads the runner's summary line, or falls back to the exit code", () => {
    assert.equal(outcomeFrom(["  storage-quota: passed"], "storage-quota", 0), "passed");
    assert.equal(outcomeFrom([], "storage-quota", 1), "failed (exit 1)");
  });
});

describe("liveTestNames", () => {
  it("reads the names from the scenario's ### Live tests section only", () => {
    const sections = [
      "<scenario-section>### Web\n\n1. open /settings\n- storage-quota</scenario-section>",
      "<scenario-section>### Live tests\n\n- storage-quota\n- `profile-guard`\n1. account-deletion\n- not a name; rm -rf /\n- storage-quota</scenario-section>",
    ];
    assert.deepEqual(liveTestNames(sections), [
      "storage-quota",
      "profile-guard",
      "account-deletion",
    ]);
  });

  it("is empty without the section, and caps the list", () => {
    assert.deepEqual(liveTestNames(null), []);
    const many = Array.from({ length: 9 }, (_, i) => `- t${i}`).join("\n");
    assert.equal(liveTestNames([`### Live tests\n${many}`]).length, 5);
  });
});

describe("runLiveTest", () => {
  it("runs the PR head's runner for one test with the key and env files, in a scrubbed env and its own group", async () => {
    const config = tempConfig();
    const { fn, calls } = fakeSpawn(SPEC_OUTPUT, 1);
    const r = await runLiveTest("storage-quota", { config, spawnFn: fn });
    assert.equal(r.outcome, "failed (exit 1)");
    assert.equal(calls.length, 1);
    const { command, args, opts } = calls[0];
    assert.equal(command, config.node);
    assert.deepEqual(args, [
      path.join(config.worktree, "scripts", "run-dev-live-tests.mjs"),
      "--only",
      "storage-quota",
      "--key-file",
      config.keyFile,
      "--env-local",
      config.envLocal,
    ]);
    assert.equal(opts.cwd, config.worktree);
    assert.equal(opts.detached, true);
    assert.equal(opts.env.DRAFTO_UNATTENDED, undefined);
    assert.deepEqual(Object.keys(opts.env).sort(), [
      "CI",
      "HOME",
      "LANG",
      "NO_COLOR",
      "PATH",
      "TMPDIR",
    ]);
    // The key is never on the command line or in the env.
    assert.ok(!JSON.stringify(calls[0]).includes(KEY));
  });

  it("withholds the output when the test prints the key", async () => {
    const { fn } = fakeSpawn(`  ✔ ${KEY}\n  storage-quota: passed`, 0);
    const r = await runLiveTest("storage-quota", { config: tempConfig(), spawnFn: fn });
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.deepEqual(r.results, []);
    assert.match(r.withheld, /secret pattern/);
  });

  it("says when the commit has no such live test", async () => {
    const { fn } = fakeSpawn(
      "run-dev-live-tests: --only must be one of: profile-guard, account-deletion\n",
      2,
    );
    const r = await runLiveTest("storage-quota", { config: tempConfig(), spawnFn: fn });
    assert.match(
      r.outcome,
      /not a live test at this commit \(LIVE_TESTS: profile-guard, account-deletion\)/,
    );
  });

  it("refuses a bad name, and a machine without the env file, without running anything", async () => {
    const { fn, calls } = fakeSpawn("", 0);
    assert.match(
      (await runLiveTest("a;ls", { config: tempConfig(), spawnFn: fn })).outcome,
      /not a live-test name/,
    );
    const config = { ...tempConfig(), envLocal: "/nonexistent/.env.local" };
    assert.match((await runLiveTest("storage-quota", { config, spawnFn: fn })).outcome, /anon key/);
    assert.equal(calls.length, 0);
  });
});

describe("runScenarioLiveTests", () => {
  it("runs each name while there is time, and lists the rest as not run", async () => {
    const { fn, calls } = fakeSpawn("  storage-quota: passed", 0);
    let t = 0;
    const r = await runScenarioLiveTests(["storage-quota", "profile-guard"], {
      config: tempConfig(),
      deadlineMs: 200_000,
      now: () => (t += 100_000),
      spawnFn: fn,
    });
    assert.equal(r.ran.length, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(r.skipped, [
      { test: "profile-guard", outcome: "not run: no time left before the session" },
    ]);
  });
});

describe("liveTestsMain (the session's wrapper)", () => {
  const results = {
    ran: [
      { test: "storage-quota", outcome: "passed", results: ["  ✔ a"] },
      { test: "profile-guard", outcome: "failed (exit 1)", results: [] },
    ],
    skipped: [],
  };

  it("prints a stored result and runs nothing", () => {
    assert.deepEqual(liveTestsMain(["storage-quota"], { results }), {
      exitCode: 0,
      out: results.ran[0],
    });
    assert.equal(liveTestsMain(["profile-guard"], { results }).exitCode, 1);
  });

  it("prints every result with no name", () => {
    assert.deepEqual(
      liveTestsMain([], { results }).out.tests.map((r) => r.test),
      ["storage-quota", "profile-guard"],
    );
  });

  it("says a test that wasn't in the scenario wasn't run", () => {
    const r = liveTestsMain(["account-deletion"], { results });
    assert.equal(r.exitCode, 2);
    assert.match(r.out.error, /wasn't in the scenario/);
  });

  it("refuses bad arguments and a run without results", () => {
    assert.equal(liveTestsMain(["a;ls"], { results }).exitCode, 2);
    assert.equal(liveTestsMain(["a", "b"], { results }).exitCode, 2);
    assert.equal(liveTestsMain(["storage-quota"], { results: null }).exitCode, 2);
  });
});
