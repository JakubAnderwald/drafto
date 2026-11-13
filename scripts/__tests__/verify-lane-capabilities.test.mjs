// The verification shell lane's opt-in wrappers (ADR-0073): bin/dev-inspect
// and bin/live-tests, their private configs, and the knobs that decide
// whether a run gets them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LANE_BINS,
  laneBinScript,
  main,
  readKnobs,
  runCapability,
  prepareCapabilities,
} from "../lib/verify-lane.mjs";
import { INSPECT_TABLES } from "../lib/dev-inspect.mjs";
import {
  INSPECT_CFG,
  LANE_BIN_NAMES,
  LIVE_TESTS_CFG,
  PRIVATE_FILE_NAMES,
} from "../lib/verify-guard.mjs";

function runDirs() {
  const runDir = mkdtempSync(path.join(os.tmpdir(), "verify-cap-"));
  const privateDir = path.join(runDir, "private");
  const binDir = path.join(runDir, "bin");
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(binDir, { mode: 0o700 });
  return { runDir, privateDir, binDir };
}

const meta = (capabilities) => ({
  capabilities,
  worktree: "/factory/worktrees/verify-7-aaaaaaaaaaaa",
  bins: { node: "/opt/homebrew/bin/node", pnpm: "/opt/homebrew/bin/pnpm" },
  paths: {
    module: "/factory/scripts/lib/verify-lane.mjs",
    signinKeyFile: "/home/drafto-secrets/dev-supabase-admin.env",
    accountFile: "/home/drafto-secrets/browser-account.env",
    envLocal: "/factory/apps/web/.env.local",
  },
});

describe("readKnobs: opt-in capabilities", () => {
  it("are off unless exactly 1", () => {
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      const k = readKnobs({
        HOME: "/h",
        FACTORY_DEV_INSPECT: value,
        FACTORY_VERIFY_LIVE_TESTS: value,
      });
      assert.equal(k.devInspect, false, String(value));
      assert.equal(k.liveTests, false, String(value));
    }
    const on = readKnobs({ HOME: "/h", FACTORY_DEV_INSPECT: "1", FACTORY_VERIFY_LIVE_TESTS: "1" });
    assert.equal(on.devInspect, true);
    assert.equal(on.liveTests, true);
  });
});

describe("prepareCapabilities", () => {
  const usable = { keyProblem: () => null, accountProblem: () => null };
  const withBundle = (d, sections) => {
    const m = meta({ devInspect: true, liveTests: true });
    m.paths.bundle = path.join(d.runDir, "bundle.json");
    m.paths.envLocal = path.join(d.runDir, "env.local");
    writeFileSync(m.paths.envLocal, "x");
    writeFileSync(m.paths.bundle, JSON.stringify({ scenario: sections ? { sections } : null }));
    return m;
  };
  const LIVE = ["<scenario-section>### Live tests\n\n- storage-quota</scenario-section>"];

  it("writes nothing when both are off", async () => {
    const d = runDirs();
    const written = await prepareCapabilities(
      { meta: meta({}), ...d, env: { HOME: "/h" } },
      usable,
    );
    assert.deepEqual(written, []);
    assert.ok(!existsSync(path.join(d.binDir, "dev-inspect")));
    assert.ok(!existsSync(path.join(d.privateDir, INSPECT_CFG)));
  });

  it("writes dev-inspect's mode-600 config (paths only) and its wrapper", async () => {
    const d = runDirs();
    const written = await prepareCapabilities(
      { meta: meta({ devInspect: true }), ...d, env: { HOME: "/h" } },
      usable,
    );
    assert.deepEqual(written, ["dev-inspect"]);
    assert.equal(statSync(path.join(d.binDir, "dev-inspect")).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(d.privateDir, INSPECT_CFG)).mode & 0o777, 0o600);
    assert.match(
      readFileSync(path.join(d.binDir, "dev-inspect"), "utf8"),
      new RegExp(`verify-lane\\.mjs' dev-inspect --run-dir '${d.runDir}' -- "\\$@"`),
    );
    assert.deepEqual(JSON.parse(readFileSync(path.join(d.privateDir, INSPECT_CFG), "utf8")), {
      keyFile: "/home/drafto-secrets/dev-supabase-admin.env",
      accounts: { user: "/home/drafto-secrets/browser-account.env" },
    });
  });

  it("offers nothing whose files aren't usable", async () => {
    const d = runDirs();
    const m = withBundle(d, LIVE);
    let ran = false;
    const written = await prepareCapabilities(
      { meta: m, ...d, env: { HOME: "/h" } },
      {
        keyProblem: () => "mode",
        accountProblem: () => null,
        runTests: async () => {
          ran = true;
          return { ran: [], skipped: [] };
        },
      },
    );
    assert.deepEqual(written, []);
    assert.equal(ran, false);
  });

  it("runs the scenario's live tests before the session and stores only their results", async () => {
    const d = runDirs();
    const m = withBundle(d, LIVE);
    let seen = null;
    const stored = {
      ran: [{ test: "storage-quota", outcome: "passed", results: [] }],
      skipped: [],
    };
    const written = await prepareCapabilities(
      { meta: m, ...d, env: { HOME: "/h", TMPDIR: "/t" }, deadlineMs: 123 },
      {
        ...usable,
        runTests: async (names, opts) => {
          seen = { names, opts };
          return stored;
        },
      },
    );
    assert.deepEqual(written, ["dev-inspect", "live-tests"]);
    assert.deepEqual(seen.names, ["storage-quota"]);
    assert.equal(seen.opts.deadlineMs, 123);
    assert.equal(seen.opts.config.worktree, m.worktree);
    assert.equal(seen.opts.config.keyFile, m.paths.signinKeyFile);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(d.privateDir, LIVE_TESTS_CFG), "utf8")),
      stored,
    );
    assert.equal(statSync(path.join(d.privateDir, LIVE_TESTS_CFG)).mode & 0o777, 0o600);
  });

  it("offers no live-tests without a ### Live tests section", async () => {
    const d = runDirs();
    const m = withBundle(d, ["<scenario-section>### Web\n\n1. x</scenario-section>"]);
    m.capabilities = { liveTests: true };
    assert.deepEqual(
      await prepareCapabilities(
        { meta: m, ...d, env: { HOME: "/h" } },
        { ...usable, runTests: async () => assert.fail("ran") },
      ),
      [],
    );
  });

  it("never throws: a failure costs the wrapper, not the run", async () => {
    const d = runDirs();
    const m = withBundle(d, LIVE);
    const written = await prepareCapabilities(
      { meta: m, ...d, env: { HOME: "/h" } },
      {
        ...usable,
        runTests: async () => {
          throw new Error("boom");
        },
      },
    );
    assert.deepEqual(written, ["dev-inspect"]);
  });
});

describe("the guard knows every wrapper and config", () => {
  it("names the same wrappers and protects the configs", () => {
    assert.deepEqual(Object.keys(LANE_BINS).sort(), [...LANE_BIN_NAMES].sort());
    assert.ok(PRIVATE_FILE_NAMES.includes(INSPECT_CFG));
    assert.ok(PRIVATE_FILE_NAMES.includes(LIVE_TESTS_CFG));
  });

  it("refuses an unknown wrapper name", () => {
    assert.throws(
      () => laneBinScript({ nodePath: "/n", modulePath: "/m", runDir: "/r", sub: "sh" }),
      /no lane wrapper/,
    );
  });
});

describe("runCapability", () => {
  it("says so when the run doesn't have the wrapper's config", async () => {
    const d = runDirs();
    let out = "";
    const code = await runCapability(
      "dev-inspect",
      { runDir: d.runDir, argv: ["whoami"] },
      { stdout: { write: (s) => (out += s) } },
    );
    assert.equal(code, 2);
    assert.match(JSON.parse(out).error, /isn't available in this run/);
  });

  it("reads private/, never meta.json", async () => {
    const d = runDirs();
    // A config planted beside meta.json, where the session can write, is ignored.
    writeFileSync(
      path.join(d.runDir, "meta.json"),
      JSON.stringify({ paths: { signinKeyFile: "/elsewhere" }, capabilities: { liveTests: true } }),
    );
    writeFileSync(path.join(d.runDir, LIVE_TESTS_CFG), JSON.stringify({ ran: [] }));
    let out = "";
    const code = await runCapability(
      "live-tests",
      { runDir: d.runDir, argv: ["storage-quota"] },
      { stdout: { write: (s) => (out += s) } },
    );
    assert.equal(code, 2);
    assert.match(out, /isn't available/);
  });

  it("prints stored live-test results through main", async () => {
    const d = runDirs();
    writeFileSync(
      path.join(d.privateDir, LIVE_TESTS_CFG),
      JSON.stringify({ ran: [{ test: "storage-quota", outcome: "passed", results: [] }] }),
    );
    let out = "";
    const code = await runCapability(
      "live-tests",
      { runDir: d.runDir, argv: ["storage-quota"] },
      { stdout: { write: (x) => (out += x) } },
    );
    assert.equal(code, 0);
    assert.equal(JSON.parse(out).outcome, "passed");
  });

  it("is reached through main with the arguments after --", async () => {
    const d = runDirs();
    const r = await main(["dev-inspect", "--run-dir", d.runDir, "--", "whoami"]);
    assert.equal(r.exitCode, 2);
  });
});

describe("the prompts match the commands", () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  for (const file of ["factory-verify-prompt.md", "factory-intest-prompt.md"]) {
    it(`${file} names every dev-inspect command and table`, () => {
      const text = read(file);
      for (const cmd of ["whoami", "profile", "usage", "orphans", "objects [--note <id>]"]) {
        assert.ok(text.includes(cmd), `${file} lacks ${cmd}`);
      }
      assert.ok(
        text.includes(`rows <${Object.keys(INSPECT_TABLES).join("|")}>`),
        `${file} lacks the table list`,
      );
    });
  }

  it("factory-agent.sh validates and exports both knobs", () => {
    const sh = read("factory-agent.sh");
    for (const knob of ["FACTORY_DEV_INSPECT", "FACTORY_VERIFY_LIVE_TESTS"]) {
      assert.match(sh, new RegExp(`${knob}="\\$\\{${knob}:-0\\}"`));
      assert.match(sh, new RegExp(`export [^\\n]*(\\\\\\n[^\\n]*)*${knob}`));
    }
  });
});
