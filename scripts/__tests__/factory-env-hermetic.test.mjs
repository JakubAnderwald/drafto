// The factory runs this suite with its own knobs exported: launchd hands the
// plist's FACTORY_* settings to factory-agent.sh, and every Claude session it
// starts (and the `node --test` that session runs) inherits them. A test whose
// harness passed process.env through then took a path it never set up, and
// failed on the Mac mini while CI stayed green: FACTORY_DEV_INSPECT=1 alone
// broke eight run_browser_task cases, and the factory spent watch passes on
// them. Harnesses that run factory code build their env with hermeticEnv()
// (helpers/hermetic-env.mjs); this runs the files that broke, and the one that
// only passed by accident, with those knobs exported, and expects them green.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(HERE, "..");

// Every key the live plist (eu.drafto.factory.plist) exports, plus a
// non-default value for each other knob these files' harnesses read.
const FACTORY_KNOBS = {
  FACTORY_PHASE: "C",
  FACTORY_PLAN_TIMEOUT_SEC: "900",
  FACTORY_MIN_FREE_DISK_GB: "999",
  FACTORY_BROWSER_UPLOADS: "1",
  FACTORY_BROWSER_JS: "1",
  FACTORY_BROWSER_ADMIN: "1",
  FACTORY_BROWSER_MODEL: "claude-sonnet-5-5",
  FACTORY_BROWSER_TIMEOUT_SEC: "1800",
  FACTORY_DEV_INSPECT: "1",
  FACTORY_VERIFY: "1",
  FACTORY_VERIFY_LIVE_TESTS: "1",
  FACTORY_INTEST_MODEL: "claude-sonnet-5-5",
  FACTORY_INTEST_BETA: "1",
  FACTORY_INTEST_BETA_DESKTOP: "1",
  FACTORY_INTEST_TIMEOUT_SEC: "1200",
  FACTORY_IMPLEMENT_DETACHED: "1",
  FACTORY_PLAN_PROBE: "1",
  FACTORY_CR_CLI: "1",
  FACTORY_IMPLEMENT_RESUME: "0",
  FACTORY_IMPLEMENT_SOFT_MARGIN_MIN: "22",
  FACTORY_USAGE_READOUT: "0",
  FACTORY_USAGE_SUPABASE_URL: "https://supabase.com/dashboard/org/abcdefghijklmnop/usage",
  FACTORY_LSOF_BIN: "/nonexistent/lsof",
  FACTORY_GH_TIMEOUT_SEC: "7",
};

const SENSITIVE_FILES = [
  "factory-agent-browser.test.mjs",
  "factory-browser-capabilities.test.mjs",
  "factory-agent-implement-detached.test.mjs",
  "factory-agent-implement-resume.test.mjs",
  "factory-agent-usage-readout.test.mjs",
  // The FACTORY_LSOF_BIN leak that started this, and the other converted
  // harnesses, so a later `...process.env` there goes red too.
  "factory-agent-intest.test.mjs",
  "factory-agent-install.test.mjs",
  "gh-timeout.test.mjs",
  "factory-support-forward-gate.test.mjs",
];

// The nested run must end on its own; a hung case fails this test instead of
// stalling the whole suite.
const NESTED_TIMEOUT_MS = 10 * 60 * 1000;

describe("hermeticEnv", () => {
  it("drops every FACTORY_* key and keeps the rest of the caller's env", () => {
    const saved = { ...process.env };
    try {
      process.env.FACTORY_DEV_INSPECT = "1";
      process.env.FACTORY_X = "y";
      process.env.NOT_FACTORY_KNOB = "kept";
      const env = hermeticEnv();
      assert.equal(Object.keys(env).filter((k) => k.startsWith("FACTORY_")).length, 0);
      assert.equal(env.NOT_FACTORY_KNOB, "kept");
      assert.equal(env.PATH, process.env.PATH);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("applies the extras last, so a test still sets the knobs it means to", () => {
    const env = hermeticEnv({ FACTORY_BROWSER_MODEL: "m", HOME: "/h" });
    assert.equal(env.FACTORY_BROWSER_MODEL, "m");
    assert.equal(env.HOME, "/h");
  });
});

describe("the factory's exported knobs don't change the suite's results", () => {
  it("lists only files that exist", () => {
    for (const f of SENSITIVE_FILES) assert.ok(existsSync(join(HERE, f)), f);
  });

  it("runs the knob-sensitive files green with the factory's knobs exported", () => {
    const env = { ...process.env, ...FACTORY_KNOBS, DRAFTO_UNATTENDED: "1" };
    // A nested `node --test` that sees the parent's NODE_TEST_CONTEXT reports to
    // the parent's runner instead of running as a run of its own.
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(
      process.execPath,
      [
        "--test",
        // Two files at a time: the outer suite runs these same files alongside,
        // and timing-sensitive tests elsewhere flake under the extra CPU load.
        "--test-concurrency=2",
        "--test-reporter=spec",
        ...SENSITIVE_FILES.map((f) => join("__tests__", f)),
      ],
      {
        cwd: scriptsDir,
        encoding: "utf8",
        env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: NESTED_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    assert.equal(r.signal, null, `nested run killed (${r.signal}) after ${NESTED_TIMEOUT_MS}ms`);
    const out = `${r.stdout}\n${r.stderr}`;
    const failures = out.slice(Math.max(0, out.indexOf("✖ failing tests:")));
    assert.equal(r.status, 0, failures.slice(-8000));
    assert.match(out, /ℹ fail 0/);
    assert.doesNotMatch(out, /ℹ pass 0\b/);
  });
});
