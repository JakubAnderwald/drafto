// Unit tests for scripts/lib/device-lane.mjs — the factory's device lane
// (ADR-0099). Every exec (git, pnpm, gradle, xcodebuild, emulator, adb,
// simctl, maestro, gh) goes through injected fakes, so nothing here touches a
// device or builds anything. The ledger, run dirs, locks and build roots are
// real files in a temp dir.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  androidBuildArgs as androidBuildArgsForJdk,
  findJdkHomes,
  jdkMajor,
  DEV_REF,
  EMULATOR_SERIAL,
  INVALID_API_URL,
  OUTPUT_FILE,
  PROD_REF,
  STOP_REQUEST_FILE,
  androidApkPath,
  attemptsFor,
  buildEnv,
  buildExpoValues,
  classifyDeviceRun,
  deviceAccountProblem,
  deviceLockPath,
  deviceRootFor,
  devEnvProblem,
  emulatorArgs,
  ensureNative,
  filterJunit,
  iosAppPath,
  judgeArtifact,
  ledgerPath,
  loadLedger,
  lockHolder,
  maestroArgs,
  main,
  parseArgv,
  readDeviceKnobs,
  releasePidLock,
  renderOutput,
  renderSecrets,
  runHousekeeping,
  runStart,
  runStop,
  runSupervise,
  saveLedger,
  takePidLock,
  PGIDS_FILE,
  SIGN_IN_PRELUDE,
  WARMUP_FLOW,
  flowDependsOnEarlier,
  killLingeringGroups,
  isAdbDrop,
  warmUpYaml,
  ensureDeviceWorktrees,
  installEnv,
  killGroup,
  killRecordedGroups,
  readGroups,
  runSelftestBuild,
  checkArtifact,
  guardedRun,
  mutateLedger,
  runSimUdid,
} from "../lib/device-lane.mjs";
import { flowNeedsSignIn } from "../lib/device-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const PASSWORD = "Sup3r-Secret-Pw!42";
const EMAIL = "device-lane@example.com";
const EMU_PID = 5000;
const SUP_PID = 4242;
const TICK_PID = 1111;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const DEV_ENV_TEXT = [
  `EXPO_PUBLIC_SUPABASE_URL=https://${DEV_REF}.supabase.co`,
  "EXPO_PUBLIC_SUPABASE_ANON_KEY=anon-dev-key",
  "EXPO_PUBLIC_API_URL=https://drafto.eu",
  "",
].join("\n");
const GOOD_CONFIG = JSON.stringify({
  name: "Drafto",
  extra: { supabaseUrl: `https://${DEV_REF}.supabase.co`, apiUrl: INVALID_API_URL },
  android: { intentFilters: [{ data: [{ host: "drafto.eu" }] }] },
});
const PASS_XML = `<?xml version='1.0' encoding='UTF-8'?>
<testsuites>
  <testsuite name="Test Suite" device="${EMULATOR_SERIAL}" tests="1" failures="0" time="95">
    <testcase id="android-all" name="android-all" classname="android-all" time="95.2" status="SUCCESS">
      <properties>
        <property name="tag" value="qa-10668"/>
      </properties>
    </testcase>
  </testsuite>
</testsuites>
`;
const FAIL_XML = `<?xml version='1.0' encoding='UTF-8'?>
<testsuites>
  <testsuite name="Test Suite" device="emulator-5580" tests="1" failures="1" time="40">
    <testcase id="ios-all" name="ios-all" classname="ios-all" time="40.4" status="ERROR">
      <failure>Element not found: Text matching regex: Signed in as ${EMAIL} &amp; more
    at maestro.Orchestra.assert(Orchestra.kt:123)</failure>
    </testcase>
  </testsuite>
</testsuites>
`;

let tmp;
let h;

function makeHarness() {
  tmp = mkdtempSync(path.join(tmpdir(), "device-lane-"));
  const volume = path.join(tmp, "vol");
  const repoRoot = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  const sdk = path.join(tmp, "sdk");
  const javaHome = path.join(tmp, "jdk");
  for (const d of [volume, repoRoot, home, sdk, javaHome]) mkdirSync(d, { recursive: true });
  mkdirSync(path.join(repoRoot, "apps", "mobile"), { recursive: true });
  writeFileSync(path.join(repoRoot, "apps", "mobile", ".env"), DEV_ENV_TEXT);
  mkdirSync(path.join(repoRoot, "logs", "factory"), { recursive: true });
  const udid = "11111111-2222-3333-4444-555555555555";
  writeFileSync(
    path.join(repoRoot, "logs", "factory", "device-config.json"),
    JSON.stringify({ iosSimUdid: udid }),
  );
  const account = path.join(home, "device-account.env");
  writeFileSync(account, `E2E_TEST_EMAIL=${EMAIL}\nE2E_TEST_PASSWORD=${PASSWORD}\n`, {
    mode: 0o600,
  });
  chmodSync(account, 0o600);
  const env = {
    HOME: home,
    PATH: "/fakebin",
    FACTORY_DEVICE_VOLUME: volume,
    DRAFTO_BUILDS_VOLUME_DIR: volume,
    FACTORY_DEVICE_ACCOUNT_FILE: account,
    FACTORY_DEVICE_JAVA_HOME: javaHome,
    FACTORY_ANDROID_SDK: sdk,
  };
  const knobs = readDeviceKnobs(env);
  mkdirSync(knobs.dataDir, { recursive: true });
  writeFileSync(knobs.keystore, "keystore");
  mkdirSync(path.join(knobs.avdHome, "drafto-factory.avd"), { recursive: true });
  writeFileSync(path.join(knobs.avdHome, "drafto-factory.ini"), "");
  for (const p of ["android", "ios"]) {
    mkdirSync(path.join(deviceRootFor(knobs, p), "apps", "mobile"), { recursive: true });
    // The flows as the PR head has them (the lane reads them for sign-in needs).
    cpSync(
      path.join(REPO, "apps", "mobile", "e2e"),
      path.join(deviceRootFor(knobs, p), "apps", "mobile", "e2e"),
      {
        recursive: true,
      },
    );
  }
  const state = {
    tmp,
    volume,
    repoRoot,
    home,
    env,
    knobs,
    udid,
    account,
    memory: 1,
    volFree: 400,
    rootFree: 100,
    alive: new Set(),
    aliveGroups: new Set(),
    procs: [],
    calls: [],
    spawns: [],
    kills: [],
    gitCalls: [],
    prView: { state: "OPEN", headRefOid: SHA, files: [{ path: "apps/mobile/e2e/ios-all.yaml" }] },
    column: "Testing",
    apkContents: Buffer.from(`hermes bundle https://${DEV_REF}.supabase.co drafto.eu`),
    appConfig: GOOD_CONFIG,
    junit: PASS_XML,
    expoHash: null,
    onRun: null,
    brokenWorktrees: new Set(),
    repairFixes: false,
    javaHomeFound: null,
    clock: Date.now(),
  };
  const ok = (stdout = "") => ({ code: 0, stdout, timedOut: false });
  const deps = {
    env,
    fs: nodeFs,
    pid: TICK_PID,
    now: () => new Date(state.clock).toISOString(),
    nowMs: () => state.clock,
    sleep: async () => {},
    isExecutable: () => true,
    isPidAlive: (pid) => state.alive.has(pid),
    psCommand: async (pid) =>
      pid === SUP_PID ? `node device-lane.mjs _supervise ${state.runId ?? ""}` : "",
    listProcesses: async () => state.procs,
    groupAlive: (pgid) => state.alive.has(pgid) || state.aliveGroups.has(pgid),
    killGraceMs: 5,
    kill: (pid, signal) => {
      // Signal 0 only asks whether the process (or group) still exists.
      if (signal === 0) {
        const id = Math.abs(pid);
        return state.alive.has(id) || state.aliveGroups.has(id);
      }
      state.kills.push({ pid, signal });
      return true;
    },
    memoryPressure: async () => state.memory,
    freeDiskGb: async (dir) => (dir === volume ? state.volFree : state.rootFree),
    gh: async (args) =>
      args[0] === "pr"
        ? ok(JSON.stringify(state.prView))
        : { code: 1, stdout: "", timedOut: false },
    git: async (args, opts) => {
      state.gitCalls.push({ args, cwd: opts?.cwd });
      if (args[0] === "show") return ok("appId: eu.drafto.mobile\n---\n");
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return state.brokenWorktrees.has(opts?.cwd)
          ? { code: 128, stdout: "", timedOut: false }
          : ok("true\n");
      }
      if (args[0] === "rev-parse") return ok(`${SHA}\n`);
      if (args[0] === "worktree" && args[1] === "repair") {
        if (state.repairFixes) state.brokenWorktrees.delete(args[2]);
        return ok();
      }
      if (args[0] === "worktree" && args[1] === "add") {
        mkdirSync(path.join(args.at(-2), "apps", "mobile"), { recursive: true });
        state.brokenWorktrees.delete(args.at(-2));
        return ok();
      }
      return ok();
    },
    cardColumn: async () => state.column,
    expoFingerprint: async () => state.expoHash,
    exec: async (cmd, args) => {
      state.calls.push({ cmd, args: [...args] });
      if (cmd === "/usr/libexec/java_home") {
        return state.javaHomeFound
          ? { code: 0, stdout: `${state.javaHomeFound}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "Unable to find any JVMs" };
      }
      return { code: 0, stdout: "", stderr: 'openjdk version "21.0.4"' };
    },
    spawnDetached: async (command, args, opts) => {
      state.spawns.push({ command, args: [...args], env: opts.env });
      if (path.basename(command) === "emulator") {
        state.alive.add(EMU_PID);
        return { ok: true, pid: EMU_PID };
      }
      return { ok: true, pid: SUP_PID };
    },
    run: async (cmd, args, opts = {}) => {
      state.calls.push({ cmd, args: [...args], env: opts.env, cwd: opts.cwd });
      if (state.onRun) {
        const r = await state.onRun(cmd, args, opts);
        if (r) return r;
      }
      const base = path.basename(cmd);
      if (base === "git") return args.includes("rev-parse") ? ok(`${SHA}\n`) : ok();
      if (base === "pnpm") {
        if (args[0] === "exec")
          mkdirSync(path.join(opts.cwd, args[args.indexOf("--platform") + 1]), { recursive: true });
        return ok();
      }
      if (base === "pod") {
        mkdirSync(path.join(opts.cwd, "Pods"), { recursive: true });
        return ok();
      }
      if (cmd === "./gradlew") {
        const apk = path.join(opts.cwd, "app/build/outputs/apk/release/app-release.apk");
        mkdirSync(path.dirname(apk), { recursive: true });
        writeFileSync(apk, "apk");
        return ok();
      }
      if (base === "xcodebuild") {
        const app = path.join(
          args[args.indexOf("-derivedDataPath") + 1],
          "Build/Products/Release-iphonesimulator/Drafto.app",
        );
        mkdirSync(path.join(app, "EXConstants.bundle"), { recursive: true });
        writeFileSync(path.join(app, "EXConstants.bundle", "app.config"), state.appConfig);
        writeFileSync(path.join(app, "main.jsbundle"), state.apkContents);
        return ok();
      }
      if (base === "unzip") {
        if (args.length === 2) {
          writeFileSync(opts.stdoutFile, state.apkContents);
          return ok();
        }
        return ok(state.appConfig);
      }
      if (base === "adb") {
        if (args.includes("get-state")) return { code: 1, stdout: "", timedOut: false };
        if (args.includes("getprop")) return ok("1\n");
        if (args.includes("emu")) {
          state.alive.delete(EMU_PID);
          return ok();
        }
        if (args.includes("screencap")) {
          writeFileSync(opts.stdoutFile, PNG);
          return ok();
        }
        return ok();
      }
      if (base === "xcrun") {
        if (args.includes("io")) writeFileSync(args.at(-1), PNG);
        if (args.includes("list")) {
          return ok(
            JSON.stringify({
              devices: {
                ios27: [{ udid: state.udid, state: state.simBooted ? "Booted" : "Shutdown" }],
              },
            }),
          );
        }
        return ok();
      }
      if (base === "maestro") {
        writeFileSync(args[args.indexOf("--output") + 1], state.junit);
        return ok();
      }
      return ok();
    },
  };
  state.deps = deps;
  return state;
}

beforeEach(() => {
  h = makeHarness();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function start(extra = {}) {
  const r = await runStart(
    { issue: "874", pr: "926", sha: SHA, repoRoot: h.repoRoot, ...extra },
    h.deps,
  );
  if (r.started) h.runId = r.runId;
  return r;
}

/** Start, then run the supervisor in-process as the spawned pid would. */
async function startAndSupervise(extra = {}) {
  const r = await start(extra);
  assert.equal(r.started, true, JSON.stringify(r));
  h.deps.pid = SUP_PID;
  h.alive.add(SUP_PID);
  const output = await runSupervise({ runDir: r.runDir }, { deps: h.deps });
  return { r, output, runDir: r.runDir };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function callsOf(base) {
  return h.calls.filter((c) => path.basename(c.cmd) === base);
}

function emuKilled() {
  return callsOf("adb").some((c) => c.args.includes("emu") && c.args.includes("kill"));
}

describe("runStart deferrals and refusals", () => {
  it("defers under memory pressure", async () => {
    h.memory = 2;
    assert.equal((await start()).reason, "deferred:memory");
  });

  it("defers when the volume or the root disk is short", async () => {
    h.volFree = 24;
    assert.equal((await start()).reason, "deferred:disk");
    h.volFree = 400;
    h.rootFree = 7;
    assert.equal((await start()).reason, "deferred:disk");
  });

  it("defers when the volume isn't mounted", async () => {
    rmSync(h.volume, { recursive: true, force: true });
    const r = await start();
    assert.equal(r.reason, "deferred:disk");
    assert.equal(r.volume, "missing");
  });

  it("defers while a beta build lock holds a live pid, not a dead one", async () => {
    const lock = path.join(h.volume, "drafto-beta-mobile.lock");
    writeFileSync(lock, "777\n");
    h.alive.add(777);
    assert.equal((await start()).reason, "deferred:beta-build");
    h.alive.delete(777);
    assert.equal((await start()).started, true);
  });

  it("defers while another run holds the slot or the device lock", async () => {
    const first = await start();
    assert.equal(first.started, true);
    assert.equal((await start()).reason, "deferred:busy");
    // A slot freed by hand, but the device lock still held by a live supervisor.
    const ledger = await loadLedger(ledgerPath(h.repoRoot));
    ledger.inFlight = null;
    await saveLedger(ledger, ledgerPath(h.repoRoot));
    h.alive.add(SUP_PID);
    assert.equal((await start()).reason, "deferred:busy");
  });

  it("enforces the attempt cap unless --force-attempt", async () => {
    const ledger = await loadLedger(ledgerPath(h.repoRoot));
    ledger.attempts["874"] = { [SHA]: 2 };
    await saveLedger(ledger, ledgerPath(h.repoRoot));
    const r = await start();
    assert.equal(r.reason, "attempts");
    const forced = await start({ forceAttempt: true });
    assert.equal(forced.started, true);
    assert.equal(forced.attempt, 3);
  });

  it("refuses when the PR head moved or the PR closed", async () => {
    h.prView = { ...h.prView, headRefOid: OTHER_SHA };
    assert.equal((await start()).reason, "head-moved");
    h.prView = { ...h.prView, headRefOid: SHA, state: "CLOSED" };
    assert.equal((await start()).reason, "head-moved");
  });

  it("refuses a web-only PR unless platforms are named", async () => {
    h.prView.files = [{ path: "apps/web/src/app/page.tsx" }];
    assert.equal((await start()).reason, "not-applicable");
    const r = await start({ platforms: "android" });
    assert.equal(r.started, true);
    assert.deepEqual(r.platforms, { android: { flows: ["apps/mobile/e2e/android-all.yaml"] } });
  });

  it("refuses an account file that isn't mode 600", async () => {
    chmodSync(h.account, 0o644);
    const r = await start();
    assert.equal(r.reason, "account");
    assert.equal(r.problem, "mode");
  });

  it("starts #926 on iOS only and hands the device lock to the supervisor", async () => {
    const r = await start();
    assert.equal(r.started, true);
    assert.deepEqual(r.platforms, { ios: { flows: ["apps/mobile/e2e/ios-all.yaml"] } });
    const spawn = h.spawns[0];
    assert.equal(path.basename(spawn.command), "nice");
    assert.deepEqual(spawn.args.slice(0, 2), ["-n", "10"]);
    assert.ok(spawn.args.includes("_supervise"));
    assert.equal(lockHolder(deviceLockPath(h.knobs), h.deps).pid, SUP_PID);
    const ledger = await loadLedger(ledgerPath(h.repoRoot));
    assert.equal(ledger.inFlight.pid, SUP_PID);
    assert.equal(attemptsFor(ledger, "874", SHA), 1);
    const metaText = readFileSync(path.join(r.runDir, "meta.json"), "utf8");
    assert.ok(!metaText.includes(PASSWORD));
    // The supervisor's environment is the allowlist: no account values.
    assert.ok(!JSON.stringify(spawn.env).includes(PASSWORD));
  });
});

describe("artifact check", () => {
  it("accepts a dev config with the .invalid API URL, even with drafto.eu elsewhere", () => {
    assert.deepEqual(judgeArtifact({ readOk: true, prodFound: false, configText: GOOD_CONFIG }), {
      ok: true,
      problem: null,
    });
  });

  it("refuses the prod ref, a missing dev ref, and any other API URL", () => {
    assert.equal(
      judgeArtifact({ readOk: true, prodFound: true, configText: GOOD_CONFIG }).problem,
      "prod-ref",
    );
    const noDev = GOOD_CONFIG.replaceAll(DEV_REF, "someotherref");
    assert.equal(
      judgeArtifact({ readOk: true, prodFound: false, configText: noDev }).problem,
      "no-dev-ref",
    );
    const devUrl = `https://${DEV_REF}.supabase.co`;
    const prodApi = JSON.stringify({
      extra: { supabaseUrl: devUrl, apiUrl: "https://drafto.eu" },
    });
    assert.equal(
      judgeArtifact({ readOk: true, prodFound: false, configText: prodApi }).problem,
      "api-url",
    );
    const noApi = JSON.stringify({ extra: { supabaseUrl: devUrl } });
    assert.equal(
      judgeArtifact({ readOk: true, prodFound: false, configText: noApi }).problem,
      "api-url",
    );
    // A dev ref somewhere else doesn't make the client's URL a dev one.
    const otherUrl = JSON.stringify({
      extra: {
        supabaseUrl: "https://someotherref.supabase.co",
        apiUrl: INVALID_API_URL,
        note: DEV_REF,
      },
    });
    assert.equal(
      judgeArtifact({ readOk: true, prodFound: false, configText: otherUrl }).problem,
      "supabase-url",
    );
    const noUrl = JSON.stringify({ extra: { apiUrl: INVALID_API_URL, note: DEV_REF } });
    assert.equal(
      judgeArtifact({ readOk: true, prodFound: false, configText: noUrl }).problem,
      "supabase-url",
    );
    assert.equal(
      judgeArtifact({ readOk: true, prodFound: false, configText: null }).problem,
      "no-app-config",
    );
    assert.equal(
      judgeArtifact({ readOk: false, prodFound: false, configText: GOOD_CONFIG }).problem,
      "unreadable",
    );
  });

  it("a prod ref in the APK: unavailable:artifact-not-dev, nothing installs or boots", async () => {
    h.prView.files = [{ path: "apps/mobile/e2e/android-all.yaml" }];
    h.apkContents = Buffer.from(`bundle https://${PROD_REF}.supabase.co`);
    const { output } = await startAndSupervise();
    assert.equal(output.platforms.android.state, "unavailable:artifact-not-dev");
    assert.equal(h.spawns.filter((s) => path.basename(s.command) === "emulator").length, 0);
    assert.ok(!callsOf("adb").some((c) => c.args.includes("install")));
    assert.ok(!callsOf("maestro").length);
  });

  it("an iOS app whose config has the drafto.eu API URL is refused", async () => {
    h.appConfig = JSON.stringify({ extra: { supabaseUrl: DEV_REF, apiUrl: "https://drafto.eu" } });
    const { output } = await startAndSupervise();
    assert.equal(output.platforms.ios.state, "unavailable:artifact-not-dev");
    assert.ok(!callsOf("xcrun").some((c) => c.args.includes("install")));
  });
});

describe("dev env", () => {
  it("devEnvProblem and buildExpoValues fail closed", () => {
    assert.equal(devEnvProblem(DEV_ENV_TEXT), null);
    assert.equal(devEnvProblem(`${DEV_ENV_TEXT}X=${PROD_REF}\n`), "prod-ref");
    assert.equal(devEnvProblem("EXPO_PUBLIC_SUPABASE_URL=https://x.supabase.co\n"), "no-dev-ref");
    assert.equal(devEnvProblem(""), "missing");
    const values = buildExpoValues(DEV_ENV_TEXT);
    assert.equal(values.EXPO_PUBLIC_API_URL, INVALID_API_URL);
    assert.equal(values.EXPO_PUBLIC_E2E_PROBES, "1");
    assert.throws(() => buildExpoValues(`EXPO_PUBLIC_X=${PROD_REF}`));
  });

  it("buildEnv signs with the factory keystore and leaks nothing from the parent env", () => {
    const env = buildEnv(
      { ...h.env, GH_TOKEN: "gh-secret", ANDROID_KEYSTORE_PASSWORD: "release-pw" },
      {
        bins: { node: process.execPath, pnpm: "/fakebin/pnpm" },
        knobs: h.knobs,
        platform: "android",
        expoValues: buildExpoValues(DEV_ENV_TEXT),
      },
    );
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.ANDROID_KEYSTORE_PATH, h.knobs.keystore);
    assert.equal(env.ANDROID_KEYSTORE_PASSWORD, "android");
    assert.equal(env.EXPO_PUBLIC_API_URL, INVALID_API_URL);
    assert.ok(!JSON.stringify(env).includes("drafto-secrets"));
  });

  it("removes .env.production and other env files from the build root", async () => {
    const mobile = path.join(deviceRootFor(h.knobs, "ios"), "apps", "mobile");
    writeFileSync(path.join(mobile, ".env.production"), `X=${PROD_REF}`);
    writeFileSync(path.join(mobile, ".env.local"), "X=1");
    const { output } = await startAndSupervise();
    assert.equal(output.platforms.ios.state, "done");
    assert.ok(!existsSync(path.join(mobile, ".env.production")));
    assert.ok(!existsSync(path.join(mobile, ".env.local")));
    assert.equal(readFileSync(path.join(mobile, ".env"), "utf8"), DEV_ENV_TEXT);
  });

  it("refuses a source .env with the prod ref before installing anything", async () => {
    writeFileSync(
      path.join(h.repoRoot, "apps", "mobile", ".env"),
      `EXPO_PUBLIC_SUPABASE_URL=https://${PROD_REF}.supabase.co\n`,
    );
    const { output } = await startAndSupervise();
    assert.equal(output.platforms.ios.state, "unavailable:env-not-dev");
    assert.equal(callsOf("pnpm").length, 0);
  });
});

describe("native fingerprint", () => {
  function ctxFor(platform) {
    const runDir = path.join(h.tmp, "run");
    mkdirSync(runDir, { recursive: true });
    return {
      deps: h.deps,
      meta: {
        knobs: h.knobs,
        bins: { pnpm: "/fakebin/pnpm", pod: "/fakebin/pod" },
        paths: { betaLocks: [] },
      },
      status: { child: null },
      platDir: runDir,
      checkpoint: async () => {},
      interruptReason: async () => null,
      log: () => {},
      platform,
    };
  }

  it("runs prebuild on a mismatch and skips it when the fingerprint matches", async () => {
    const root = deviceRootFor(h.knobs, "android");
    const ctx = ctxFor("android");
    const values = buildExpoValues(DEV_ENV_TEXT);
    const first = await ensureNative(ctx, root, "android", values, {});
    assert.equal(first.cached, false);
    assert.equal(callsOf("pnpm").filter((c) => c.args.includes("prebuild")).length, 1);
    assert.equal(
      readFileSync(path.join(root, "apps/mobile/android/local.properties"), "utf8"),
      `sdk.dir=${h.knobs.androidSdk}\n`,
    );
    const second = await ensureNative(ctx, root, "android", values, {});
    assert.equal(second.cached, true);
    assert.equal(callsOf("pnpm").filter((c) => c.args.includes("prebuild")).length, 1);
    // A changed native input (here: an env value) prebuilds again.
    await ensureNative(ctx, root, "android", { ...values, EXPO_PUBLIC_X: "1" }, {});
    assert.equal(callsOf("pnpm").filter((c) => c.args.includes("prebuild")).length, 2);
  });

  it("uses @expo/fingerprint's hash when it has one, and pod-installs iOS", async () => {
    const root = deviceRootFor(h.knobs, "ios");
    const ctx = ctxFor("ios");
    h.expoHash = "abc123abc123abc123";
    const values = buildExpoValues(DEV_ENV_TEXT);
    await ensureNative(ctx, root, "ios", values, {});
    assert.equal(callsOf("pod").length, 1);
    assert.equal((await ensureNative(ctx, root, "ios", values, {})).cached, true);
    h.expoHash = "def456def456def456";
    assert.equal((await ensureNative(ctx, root, "ios", values, {})).cached, false);
  });
});

describe("supervisor", () => {
  it("writes device-output.json to the contract and a shots manifest", async () => {
    h.prView.files = [{ path: "packages/shared/src/x.ts" }];
    const { output, runDir } = await startAndSupervise();
    const disk = readJson(path.join(runDir, OUTPUT_FILE));
    assert.deepEqual(disk, output);
    assert.deepEqual(Object.keys(disk).sort(), [
      "finishedAt",
      "issue",
      "mode",
      "platforms",
      "pr",
      "runId",
      "sha",
      "startedAt",
      "trigger",
      "version",
    ]);
    assert.equal(disk.version, 1);
    assert.equal(disk.issue, 874);
    assert.equal(disk.pr, 926);
    assert.equal(disk.sha, SHA);
    assert.equal(disk.mode, "smoke");
    assert.equal(disk.trigger, "testing");
    assert.match(disk.finishedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(Object.keys(disk.platforms), ["android", "ios"]);
    for (const p of ["android", "ios"]) {
      const entry = disk.platforms[p];
      assert.deepEqual(Object.keys(entry).sort(), ["build", "flows", "state", "verdict"]);
      assert.equal(entry.state, "done");
      assert.equal(entry.verdict, "PASS");
      assert.equal(typeof entry.build.cached, "boolean");
      assert.equal(typeof entry.build.durationS, "number");
      assert.equal(entry.flows.length, 1);
      assert.deepEqual(Object.keys(entry.flows[0]).sort(), [
        "durationS",
        "failure",
        "name",
        "status",
      ]);
      assert.equal(entry.flows[0].name, `${p}-all.yaml`);
      assert.equal(entry.flows[0].status, "PASS");
      assert.equal(entry.flows[0].failure, null);
    }
    const shots = readJson(path.join(runDir, "evidence", "shots.json"));
    assert.equal(shots.length, 2);
    assert.deepEqual(shots[0].file, "device-android/01-android-all.png");
    assert.match(shots[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(shots[0].pass, "final");
    assert.equal(shots[1].platform, "ios");
    assert.ok(existsSync(path.join(runDir, "evidence", "device-ios", "01-ios-all.png")));
    // Android ran before iOS, and its emulator was down before the simulator booted.
    const order = h.calls
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) =>
          (path.basename(c.cmd) === "adb" && c.args.includes("emu")) ||
          (path.basename(c.cmd) === "xcrun" && c.args.includes("boot")),
      );
    assert.ok(order.length >= 2);
    assert.ok(order[0].c.args.includes("emu"));
    // The run ended cleanly: exit.json, the lock released, private/ gone.
    const exit = readJson(path.join(runDir, "exit.json"));
    assert.equal(exit.interrupt, null);
    assert.equal(exit.error, null);
    assert.equal(existsSync(deviceLockPath(h.knobs)), false);
    assert.equal(existsSync(path.join(runDir, "private")), false);
  });

  it("never puts the password in argv, a log or the output; Maestro gets it by env", async () => {
    h.prView.files = [{ path: "apps/mobile/src/app.tsx" }];
    const { runDir } = await startAndSupervise();
    const maestro = callsOf("maestro");
    // Per platform: the warm-up, then the smoke flow.
    assert.equal(maestro.length, 4);
    for (const c of maestro) {
      assert.equal(c.env.MAESTRO_E2E_TEST_PASSWORD, PASSWORD);
      assert.ok(c.args.includes(`E2E_TEST_EMAIL=${EMAIL}`));
      assert.ok(c.args.some((a) => /^RUN_ID=\d{10}$/.test(a)));
    }
    for (const c of h.calls) {
      assert.ok(!c.args.some((a) => String(a).includes(PASSWORD)), `${c.cmd} argv`);
      if (path.basename(c.cmd) !== "maestro") {
        assert.ok(!JSON.stringify(c.env ?? {}).includes(PASSWORD), `${c.cmd} env`);
      }
    }
    for (const s of h.spawns) {
      assert.ok(!s.args.some((a) => String(a).includes(PASSWORD)));
      assert.ok(!JSON.stringify(s.env ?? {}).includes(PASSWORD));
    }
    for (const f of ["supervisor.log", OUTPUT_FILE, "meta.json", "exit.json"]) {
      const text = existsSync(path.join(runDir, f))
        ? readFileSync(path.join(runDir, f), "utf8")
        : "";
      assert.ok(!text.includes(PASSWORD), f);
    }
  });

  it("maestroArgs has no password slot at all", () => {
    const args = maestroArgs({
      deviceId: "x",
      flowPath: "f",
      junit: "j",
      rawDir: "/r",
      runEpoch: 1,
      email: EMAIL,
    });
    assert.ok(!args.join(" ").includes("PASSWORD"));
  });

  it("a FAIL flow reports FAIL with a filtered first line", async () => {
    h.junit = FAIL_XML;
    const { output } = await startAndSupervise();
    const ios = output.platforms.ios;
    assert.equal(ios.verdict, "FAIL");
    assert.equal(ios.flows[0].status, "FAIL");
    assert.equal(
      ios.flows[0].failure,
      "Element not found: Text matching regex: Signed in as [email] & more",
    );
  });

  it("a flow that throws: the device is still shut down", async () => {
    h.prView.files = [{ path: "apps/mobile/e2e/android-all.yaml" }];
    h.onRun = (cmd) => {
      if (path.basename(cmd) === "maestro") throw new Error("boom");
      return null;
    };
    const { output, runDir } = await startAndSupervise();
    assert.ok(emuKilled());
    assert.equal(output.platforms.android.state, "failed:error");
    assert.equal(readJson(path.join(runDir, "exit.json")).error, "boom");
    assert.equal(existsSync(deviceLockPath(h.knobs)), false);
  });

  it("a boot that fails stops the emulator and doesn't reach Maestro", async () => {
    h.prView.files = [{ path: "apps/mobile/e2e/android-all.yaml" }];
    h.onRun = (cmd, args) =>
      path.basename(cmd) === "adb" && args.includes("getprop")
        ? { code: 1, stdout: "", timedOut: false }
        : null;
    let t = 0;
    h.deps.nowMs = () => h.clock + (t += 60_000);
    const { output } = await startAndSupervise();
    assert.equal(output.platforms.android.state, "failed:boot-timeout");
    assert.ok(emuKilled());
    assert.equal(callsOf("maestro").length, 0);
  });

  it("critical memory pressure mid-run stops it (retry:memory) and shuts the device down", async () => {
    h.prView.files = [{ path: "apps/mobile/src/app.tsx" }];
    h.onRun = (cmd) => {
      if (path.basename(cmd) === "maestro") h.memory = 4;
      return null;
    };
    const { output, runDir } = await startAndSupervise();
    assert.equal(output.platforms.android.state, "stopped:memory");
    assert.equal(output.platforms.ios.state, "stopped:memory");
    assert.ok(emuKilled());
    assert.ok(!callsOf("xcrun").some((c) => c.args.includes("boot")));
    const exit = readJson(path.join(runDir, "exit.json"));
    assert.deepEqual(classifyDeviceRun({ exit, output }), {
      state: "retry:memory",
      refund: "attempt",
    });
  });

  it("a beta lock appearing mid-build stops the run (retry:beta-build)", async () => {
    h.prView.files = [{ path: "apps/mobile/e2e/ios-all.yaml" }];
    h.onRun = (cmd) => {
      if (path.basename(cmd) === "xcodebuild") {
        writeFileSync(path.join(h.volume, "drafto-beta-mobile.lock"), "888\n");
        h.alive.add(888);
      }
      return null;
    };
    const { output, runDir } = await startAndSupervise();
    assert.equal(output.platforms.ios.state, "stopped:beta-build");
    const exit = readJson(path.join(runDir, "exit.json"));
    // The run yields to the beta and its attempt is given back: it retries later.
    assert.deepEqual(classifyDeviceRun({ exit, output }), {
      state: "retry:beta-build",
      refund: "attempt",
    });
    assert.ok(callsOf("xcrun").some((c) => c.args.includes("shutdown")));
  });

  it("a stop signal mid-flow: the reason from stop-request.json, devices down", async () => {
    h.prView.files = [{ path: "apps/mobile/e2e/android-all.yaml" }];
    let runDir;
    h.onRun = (cmd) => {
      if (path.basename(cmd) === "maestro") {
        writeFileSync(
          path.join(runDir, STOP_REQUEST_FILE),
          JSON.stringify({ reason: "head-moved" }),
        );
        process.emit("SIGTERM");
      }
      return null;
    };
    const r = await start();
    runDir = r.runDir;
    h.deps.pid = SUP_PID;
    const output = await runSupervise({ runDir }, { deps: h.deps });
    assert.equal(output.platforms.android.state, "stopped:head-moved");
    assert.ok(emuKilled());
    const exit = readJson(path.join(runDir, "exit.json"));
    assert.equal(exit.terminated, true);
    assert.deepEqual(classifyDeviceRun({ exit, output }), {
      state: "stopped:head-moved",
      refund: "attempt",
    });
  });

  it("a missing AVD, keystore or simulator is unavailable, not a failure", async () => {
    h.prView.files = [{ path: "apps/mobile/src/app.tsx" }];
    rmSync(h.knobs.keystore);
    writeFileSync(path.join(h.repoRoot, "logs", "factory", "device-config.json"), "{}");
    const { output } = await startAndSupervise();
    assert.equal(output.platforms.android.state, "unavailable:no-keystore");
    assert.equal(output.platforms.ios.state, "unavailable:no-simulator");
    assert.equal(
      classifyDeviceRun({ exit: { interrupt: null, error: null }, output }).state,
      "unavailable",
    );
  });

  it("signs Android with injected signing and the emulator stays on port 5580", async () => {
    h.prView.files = [{ path: "apps/mobile/e2e/android-all.yaml" }];
    await startAndSupervise();
    const gradle = h.calls.find((c) => c.cmd === "./gradlew");
    assert.ok(gradle.args.includes(`-Pandroid.injected.signing.store.file=${h.knobs.keystore}`));
    assert.ok(gradle.args.includes("-PreactNativeArchitectures=arm64-v8a"));
    assert.equal(gradle.env.GRADLE_USER_HOME, h.knobs.gradleHome);
    assert.equal(gradle.env._JAVA_OPTIONS, "--enable-native-access=ALL-UNNAMED");
    assert.equal(gradle.env.EXPO_PUBLIC_API_URL, INVALID_API_URL);
    const emu = h.spawns.find((s) => path.basename(s.command) === "emulator");
    assert.deepEqual(emu.args, emulatorArgs());
    assert.equal(emu.env.ANDROID_AVD_HOME, h.knobs.avdHome);
    for (const c of callsOf("adb")) {
      assert.deepEqual(c.args.slice(0, 2), ["-s", EMULATOR_SERIAL], c.args.join(" "));
    }
    assert.ok(existsSync(androidApkPath(deviceRootFor(h.knobs, "android"))));
    assert.ok(!existsSync(iosAppPath(deviceRootFor(h.knobs, "ios"))));
  });
});

describe("housekeeping and stop", () => {
  it("stops a running run whose PR head moved, refunding the attempt", async () => {
    const r = await start();
    h.alive.add(SUP_PID);
    h.prView = { ...h.prView, headRefOid: OTHER_SHA };
    const out = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.equal(out.state, "terminated");
    assert.equal(out.reason, "head-moved");
    assert.ok(h.kills.some((k) => k.pid === -SUP_PID && k.signal === "SIGTERM"));
    assert.deepEqual(readJson(path.join(r.runDir, STOP_REQUEST_FILE)), { reason: "head-moved" });
    // The slot stays, marked stopping, until the supervisor has gone.
    let ledger = await loadLedger(ledgerPath(h.repoRoot));
    assert.equal(ledger.inFlight.stopping.reason, "head-moved");
    assert.equal(attemptsFor(ledger, "874", SHA), 1);
    assert.equal((await start()).reason, "deferred:busy");
    assert.equal((await runHousekeeping({ repoRoot: h.repoRoot }, h.deps)).state, "stopping");
    // It shut down and wrote exit.json: finalised, refunded once.
    h.alive.delete(SUP_PID);
    writeFileSync(
      path.join(r.runDir, "exit.json"),
      JSON.stringify({ interrupt: "stopped:head-moved" }),
    );
    const done = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.equal(done.state, "stopped");
    assert.equal(done.escalated, false);
    ledger = await loadLedger(ledgerPath(h.repoRoot));
    assert.equal(ledger.inFlight, null);
    assert.equal(attemptsFor(ledger, "874", SHA), 0);
    assert.equal(ledger.last["874"].state, "stopped:head-moved");
  });

  it("a stopped supervisor that doesn't exit is SIGKILLed and cleaned up after", async () => {
    const r = await start();
    h.alive.add(SUP_PID);
    const out = await runStop({ repoRoot: h.repoRoot, issue: "874", reason: "stop" }, h.deps);
    assert.equal(out.state, "stopping");
    // Still wedged five minutes later: SIGKILLed, but it stays alive (stuck
    // in I/O), so the slot stays reserved and nothing is cleaned up or refunded.
    const later = (min) => new Date(h.clock + min * 60_000).toISOString();
    const kill = await runHousekeeping({ repoRoot: h.repoRoot, now: later(6) }, h.deps);
    assert.equal(kill.state, "stopping");
    assert.equal(kill.escalated, true);
    assert.equal(h.kills.filter((k) => k.pid === -SUP_PID && k.signal === "SIGKILL").length, 1);
    assert.ok(!emuKilled());
    let ledger = await loadLedger(ledgerPath(h.repoRoot));
    assert.equal(ledger.inFlight.stopping.killedAt, later(6).replace(/\.\d{3}Z$/, "Z"));
    assert.equal(attemptsFor(ledger, "874", SHA), 1);
    assert.equal(
      (await runHousekeeping({ repoRoot: h.repoRoot, now: later(7) }, h.deps)).state,
      "stopping",
    );
    assert.equal(h.kills.filter((k) => k.pid === -SUP_PID && k.signal === "SIGKILL").length, 1);
    // It has really exited: cleaned up after, finalised, refunded once.
    h.alive.delete(SUP_PID);
    const done = await runHousekeeping({ repoRoot: h.repoRoot, now: later(8) }, h.deps);
    assert.equal(done.state, "stopped");
    assert.equal(done.escalated, true);
    assert.ok(emuKilled());
    ledger = await loadLedger(ledgerPath(h.repoRoot));
    assert.equal(ledger.inFlight, null);
    assert.equal(attemptsFor(ledger, "874", SHA), 0);
  });

  it("stops a run whose card left Testing / In Test, keeping the attempt spent", async () => {
    await start();
    h.alive.add(SUP_PID);
    h.column = "Done";
    const out = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.equal(out.reason, "left-column");
    assert.equal(out.refund, "none");
    assert.equal(attemptsFor(await loadLedger(ledgerPath(h.repoRoot)), "874", SHA), 1);
  });

  it("leaves a healthy run running, also in In Test", async () => {
    await start();
    h.alive.add(SUP_PID);
    h.column = "In Test";
    assert.equal((await runHousekeeping({ repoRoot: h.repoRoot }, h.deps)).state, "running");
  });

  it("collects a finished run", async () => {
    const { runDir } = await startAndSupervise();
    h.alive.delete(SUP_PID);
    h.deps.pid = TICK_PID;
    const out = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.equal(out.state, "done");
    assert.equal(out.outcome, "done:PASS");
    const ledger = await loadLedger(ledgerPath(h.repoRoot));
    assert.equal(ledger.inFlight, null);
    assert.equal(ledger.last["874"].runDir, runDir);
  });

  it("a supervisor that died: devices stopped by port and UDID, retry:lost", async () => {
    await start();
    h.procs = [
      { pid: 9001, command: `qemu-system-aarch64 -avd drafto-factory -port 5580 -no-window` },
      { pid: 9002, command: "qemu-system-aarch64 -port 5554" },
    ];
    h.alive.add(9001);
    const out = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.equal(out.outcome, "retry:lost");
    assert.ok(emuKilled());
    assert.ok(callsOf("xcrun").some((c) => c.args.includes("shutdown") && c.args.includes(h.udid)));
    assert.deepEqual(out.devices.emulator.stopped, [9001]);
    assert.ok(!h.kills.some((k) => Math.abs(k.pid) === 9002));
  });

  it("idle housekeeping reaps a dead device lock and a leftover booted simulator", async () => {
    writeFileSync(deviceLockPath(h.knobs), "31337\n");
    h.simBooted = true;
    const out = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.equal(out.state, "idle");
    assert.equal(out.reaped.lock, true);
    assert.ok(out.reaped.devices);
    assert.ok(callsOf("xcrun").some((c) => c.args.includes("shutdown")));
  });

  it("stop releases the slot with a refund", async () => {
    const r = await start();
    h.alive.add(SUP_PID);
    const out = await runStop({ repoRoot: h.repoRoot, issue: "874", reason: "stop" }, h.deps);
    assert.equal(out.state, "stopping");
    assert.equal(out.refund, "attempt");
    assert.ok(existsSync(path.join(r.runDir, STOP_REQUEST_FILE)));
    assert.ok((await loadLedger(ledgerPath(h.repoRoot))).inFlight.stopping);
    h.alive.delete(SUP_PID);
    const done = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.equal(done.state, "stopped");
    assert.equal((await loadLedger(ledgerPath(h.repoRoot))).inFlight, null);
  });
});

describe("classifyDeviceRun", () => {
  const output = (verdicts) => ({
    platforms: Object.fromEntries(
      verdicts.map(([p, state, verdict]) => [p, { state, verdict, flows: [] }]),
    ),
  });
  it("maps end states", () => {
    assert.deepEqual(classifyDeviceRun({ exit: null, attemptsUsed: 1 }), {
      state: "retry:lost",
      refund: "none",
    });
    assert.deepEqual(classifyDeviceRun({ exit: null, attemptsUsed: 2 }), {
      state: "unavailable:lost",
      refund: "none",
    });
    assert.equal(classifyDeviceRun({ exit: { interrupt: "failed:timeout" } }).state, "timeout");
    assert.deepEqual(classifyDeviceRun({ exit: { interrupt: "stopped:left-column" } }), {
      state: "stopped:left-column",
      refund: "none",
    });
    assert.equal(classifyDeviceRun({ exit: { error: "x" } }).state, "failed:error");
    // The factory's own stops (a hand-back, feedback, verification off) give
    // the attempt back, so a card back in Testing on the same commit runs again.
    for (const why of [
      "ci-red",
      "not-reviewed",
      "threads",
      "feedback",
      "verification-off",
      "conflict",
    ]) {
      assert.deepEqual(classifyDeviceRun({ exit: { interrupt: `stopped:${why}` } }), {
        state: `stopped:${why}`,
        refund: "attempt",
      });
    }
    assert.equal(
      classifyDeviceRun({
        exit: {},
        output: output([
          ["ios", "done", "PASS"],
          ["android", "done", "FAIL"],
        ]),
      }).state,
      "done:FAIL",
    );
    assert.equal(
      classifyDeviceRun({
        exit: {},
        output: output([
          ["ios", "done", "PASS"],
          ["android", "failed:build", null],
        ]),
      }).state,
      "done:ERROR",
    );
    assert.equal(
      classifyDeviceRun({
        exit: {},
        output: output([
          ["ios", "done", "PASS"],
          ["android", "unavailable:no-avd", null],
        ]),
      }).state,
      "done:PASS",
    );
  });
});

describe("filterJunit", () => {
  it("a passing Maestro 2.x report", () => {
    const r = filterJunit(PASS_XML);
    assert.deepEqual(r.cases, [
      { name: "android-all", status: "PASS", durationS: 95, failure: null },
    ]);
    assert.deepEqual(r.lines, ["PASS android-all (95s)"]);
  });

  it("a failure: first line only, entities decoded, emails redacted", () => {
    const r = filterJunit(FAIL_XML);
    assert.equal(r.cases[0].status, "FAIL");
    assert.equal(
      r.cases[0].failure,
      "Element not found: Text matching regex: Signed in as [email] & more",
    );
    assert.ok(!r.lines.join("\n").includes(EMAIL));
  });

  it("withholds a line carrying the password or a secret pattern", () => {
    const xml = `<testsuite><testcase name="x" status="ERROR"><failure><![CDATA[typed ${PASSWORD} into field]]></failure></testcase>
      <testcase name="y" status="ERROR"><failure message="key dk_0123456789abcdef0123 leaked"/></testcase></testsuite>`;
    const r = filterJunit(xml, { secrets: { password: PASSWORD } });
    assert.match(r.cases[0].failure, /^\[withheld: matched .*password/);
    assert.match(r.cases[1].failure, /^\[withheld: matched /);
    assert.ok(!JSON.stringify(r).includes(PASSWORD));
  });

  it("older shapes: no status attribute, an <error> child, a self-closed case", () => {
    const xml = `<testsuite>
      <testcase name="a" time="1.4"/>
      <testcase name="b" time="2"><failure message="Assertion is false"/></testcase>
      <testcase name='c' time='3'><error>Device disconnected</error></testcase>
      <testcase name="d" status="CANCELED"/>
    </testsuite>`;
    const r = filterJunit(xml);
    assert.deepEqual(
      r.cases.map((c) => [c.name, c.status, c.failure]),
      [
        ["a", "PASS", null],
        ["b", "FAIL", "Assertion is false"],
        ["c", "ERROR", "Device disconnected"],
        ["d", "ERROR", null],
      ],
    );
  });

  it("caps the lines", () => {
    const xml = Array.from(
      { length: 250 },
      (_, i) => `<testcase name="t${i}" status="SUCCESS"/>`,
    ).join("");
    const r = filterJunit(xml);
    assert.equal(r.lines.length, 200);
    assert.equal(r.lines.at(-1), "… 51 more");
  });

  it("garbage in, nothing out", () => {
    assert.deepEqual(filterJunit("not xml"), { cases: [], lines: [] });
    assert.deepEqual(filterJunit(""), { cases: [], lines: [] });
  });
});

describe("pid locks", () => {
  it("take, re-enter, refuse a live holder, reap a dead one, release", () => {
    const lock = path.join(h.tmp, "x.lock");
    h.alive.add(1);
    assert.deepEqual(takePidLock(lock, 1, h.deps), { ok: true });
    assert.deepEqual(takePidLock(lock, 1, h.deps), { ok: true });
    h.alive.add(2);
    assert.deepEqual(takePidLock(lock, 2, h.deps), { ok: false, holder: 1 });
    h.alive.delete(1);
    assert.deepEqual(takePidLock(lock, 2, h.deps), { ok: true });
    assert.equal(releasePidLock(lock, 3, h.deps), false);
    assert.equal(existsSync(lock), true);
    assert.equal(releasePidLock(lock, 2, h.deps), true);
    assert.equal(existsSync(lock), false);
  });
});

describe("flows read the password through the env fallback", () => {
  const E2E = path.join(REPO, "apps", "mobile", "e2e");
  const FALLBACK =
    "${typeof E2E_TEST_PASSWORD !== 'undefined' ? E2E_TEST_PASSWORD : MAESTRO_E2E_TEST_PASSWORD}";

  // Every static subflow a flow names: `runFlow: x.yaml` and `file: x.yaml`
  // (under `- runFlow:`), quoted or not, with or without a trailing comment.
  // A `runFlow:` with neither a path nor a nested block is a parse gap.
  function runFlowTargets(file) {
    const lines = readFileSync(file, "utf8").split("\n");
    const targets = [];
    const ref = /^\s*(?:-\s*)?(runFlow|file):\s*(?:(["'])(.*?)\2|([^\s#"']*))\s*(?:#.*)?$/;
    for (const line of lines) {
      if (/^\s*#/.test(line)) continue;
      const m = ref.exec(line);
      if (!m) continue;
      const target = m[3] ?? m[4];
      if (!target) {
        assert.equal(m[1], "runFlow", `${path.relative(REPO, file)}: empty ${m[1]}`);
        continue; // `- runFlow:` with a nested file:/commands: block
      }
      if (target.includes("${")) continue; // dynamic: not a static target
      assert.match(target, /\.ya?ml$/, `${path.relative(REPO, file)}: ${line.trim()}`);
      targets.push(path.resolve(path.dirname(file), target));
    }
    return targets;
  }

  function closure(start) {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const f = queue.shift();
      if (seen.has(f)) continue;
      assert.ok(existsSync(f), `subflow not found: ${path.relative(REPO, f)}`);
      seen.add(f);
      queue.push(...runFlowTargets(f));
    }
    return [...seen];
  }

  it("the traversal reads quoted targets and fails on a missing one", () => {
    const dir = path.join(h.tmp, "flows");
    mkdirSync(path.join(dir, "helpers"), { recursive: true });
    writeFileSync(path.join(dir, "helpers", "a.yaml"), "appId: x\n---\n- launchApp\n");
    writeFileSync(path.join(dir, "helpers", "b.yaml"), "appId: x\n---\n- launchApp\n");
    writeFileSync(
      path.join(dir, "top.yaml"),
      "appId: x\n---\n- runFlow: \"helpers/a.yaml\" # quoted\n- runFlow:\n    file: 'helpers/b.yaml'\n",
    );
    // One target per quoted form: each must be found on its own.
    assert.deepEqual(closure(path.join(dir, "top.yaml")).sort(), [
      path.join(dir, "helpers", "a.yaml"),
      path.join(dir, "helpers", "b.yaml"),
      path.join(dir, "top.yaml"),
    ]);
    writeFileSync(path.join(dir, "bad.yaml"), "appId: x\n---\n- runFlow: helpers/missing.yaml\n");
    assert.throws(() => closure(path.join(dir, "bad.yaml")), /subflow not found/);
  });

  for (const top of ["ios-all.yaml", "android-all.yaml", "09-password-visibility.yaml"]) {
    it(`${top} and every flow it runs`, () => {
      const files = closure(path.join(E2E, top));
      assert.ok(files.length >= 1);
      for (const file of files) {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (/^\s*#/.test(line) || !/\bE2E_TEST_PASSWORD\b/.test(line)) continue;
          if (!/inputText/.test(line)) continue;
          assert.ok(line.includes(FALLBACK), `${path.relative(REPO, file)}: ${line.trim()}`);
        }
        assert.ok(
          !/\$\{E2E_TEST_PASSWORD\}/.test(readFileSync(file, "utf8").replace(/^\s*#.*$/gm, "")),
          file,
        );
      }
    });
  }
});

describe("CLI", () => {
  it("parseArgv takes value-less switches", () => {
    assert.deepEqual(
      parseArgv(["--issue", "1", "--force-attempt", "--platform", "ios", "--build"]),
      {
        issue: "1",
        platform: "ios",
        "force-attempt": true,
        build: true,
      },
    );
  });

  it("render prints the follow-up comment from device-output.json", async () => {
    const { runDir } = await startAndSupervise();
    const out = await main(["render", "--run-dir", runDir], h.deps);
    assert.match(out.text, /^🏭 \*\*Device lane results\*\* for `[0-9a-f]{12}` \(PR #\d+\)/);
    assert.match(out.text, /\| iOS \(simulator\) \| ran \| PASS \| 1\/1 flows passed/);
    assert.match(out.text, /- PASS `ios-all.yaml`/);
    assert.match(
      out.text,
      /<!-- drafto-factory-device-report -->\n<!-- drafto-factory-device-sha:[0-9a-f]{40}:[^ ]+ -->\n$/,
    );
    assert.equal(renderOutput(null), "No device-output.json in this run dir.\n");
  });

  it("render scans for the account password the run used, with no FACTORY_DEVICE_ACCOUNT_FILE set", async () => {
    const { runDir } = await startAndSupervise();
    const outFile = path.join(runDir, "device-output.json");
    const output = readJson(outFile);
    output.platforms.ios.flows[0].failure = `typed ${PASSWORD} into the note`;
    writeFileSync(outFile, JSON.stringify(output));
    const { FACTORY_DEVICE_ACCOUNT_FILE: _unset, ...env } = h.env;
    assert.deepEqual(renderSecrets(env, h.deps.fs, runDir), { devicePassword: PASSWORD });
    const out = await main(["render", "--run-dir", runDir], { ...h.deps, env });
    assert.ok(!out.text.includes(PASSWORD));
    assert.match(out.text, /report withheld/);

    // An account-backed run whose account file is gone can't be checked: null.
    rmSync(h.account);
    assert.deepEqual(renderSecrets(env, h.deps.fs, runDir), { devicePassword: null });
    // A run dir that says nothing about its account, with no file configured: null.
    assert.deepEqual(renderSecrets(env, h.deps.fs, path.join(h.tmp, "nope")), {
      devicePassword: null,
    });
    // Only a run that signed in to no account (a selftest) needs no check.
    const meta = readJson(path.join(runDir, "meta.json"));
    writeFileSync(
      path.join(runDir, "meta.json"),
      JSON.stringify({ ...meta, needsAccount: false, paths: { ...meta.paths, accountFile: null } }),
    );
    assert.deepEqual(renderSecrets(env, h.deps.fs, runDir), { devicePassword: "" });
  });

  it("start validates its argv", async () => {
    await assert.rejects(
      main(["start", "--issue", "1", "--pr", "2", "--sha", "abc"], h.deps),
      /40-hex/,
    );
    await assert.rejects(
      main(["start", "--issue", "1", "--pr", "2", "--sha", SHA, "--platforms", "web"], h.deps),
      /--platforms/,
    );
  });

  it("account problems are reported without values", () => {
    assert.equal(deviceAccountProblem(h.account), null);
    writeFileSync(h.account, "E2E_TEST_EMAIL=a@b.c\n", { mode: 0o600 });
    assert.equal(deviceAccountProblem(h.account), "no-password");
    assert.equal(deviceAccountProblem(path.join(h.tmp, "nope")), "missing");
  });
});

describe("review fixes", () => {
  it("pnpm install runs without NODE_ENV=production; prebuild and the build keep it", async () => {
    h.prView.files = [{ path: "apps/mobile/e2e/android-all.yaml" }];
    await startAndSupervise();
    const installs = callsOf("pnpm").filter((c) => c.args[0] === "install");
    assert.ok(installs.length >= 1);
    for (const c of installs) assert.equal(c.env.NODE_ENV, undefined);
    const prebuild = callsOf("pnpm").find((c) => c.args.includes("prebuild"));
    assert.equal(prebuild.env.NODE_ENV, "production");
    assert.equal(h.calls.find((c) => c.cmd === "./gradlew").env.NODE_ENV, "production");
    assert.equal(installEnv({ NODE_ENV: "production", A: "1" }).NODE_ENV, undefined);
  });

  it("a flow the PR deletes is never run, but still makes the PR applicable", async () => {
    h.prView.files = [
      { path: "apps/mobile/e2e/10-swipe-hint.yaml", changeType: "DELETED" },
      { path: "apps/mobile/e2e/11-sign-out-confirm.yaml", changeType: "MODIFIED" },
    ];
    const r = await start();
    assert.equal(r.started, true);
    assert.deepEqual(r.platforms.ios.flows, [
      "apps/mobile/e2e/ios-all.yaml",
      "apps/mobile/e2e/11-sign-out-confirm.yaml",
    ]);
    assert.ok(r.reasons.some((x) => /10-swipe-hint\.yaml is deleted/.test(x)));
  });

  describe("build worktrees", () => {
    const opts = () => ({ repoRoot: h.repoRoot, sha: SHA, platforms: ["android"], knobs: h.knobs });
    const root = () => deviceRootFor(h.knobs, "android");
    const gitOps = () => h.gitCalls.map((c) => c.args.slice(0, 2).join(" "));

    it("leaves a usable root alone and never prunes", async () => {
      await ensureDeviceWorktrees(opts(), h.deps);
      assert.ok(!gitOps().includes("worktree add"));
      assert.ok(!h.gitCalls.some((c) => c.args.includes("prune")));
    });

    it("repairs a root whose registration was pruned", async () => {
      h.brokenWorktrees.add(root());
      h.repairFixes = true;
      writeFileSync(path.join(root(), "keep.txt"), "x");
      await ensureDeviceWorktrees(opts(), h.deps);
      assert.ok(h.gitCalls.some((c) => c.args.join(" ") === `worktree repair ${root()}`));
      assert.ok(!gitOps().includes("worktree add"));
      assert.ok(existsSync(path.join(root(), "keep.txt")));
    });

    it("starts the root over when repair doesn't help, adding with --force", async () => {
      h.brokenWorktrees.add(root());
      writeFileSync(path.join(root(), "keep.txt"), "x");
      await ensureDeviceWorktrees(opts(), h.deps);
      const add = h.gitCalls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
      assert.deepEqual(add.args, ["worktree", "add", "--force", "--detach", root(), SHA]);
      assert.ok(!existsSync(path.join(root(), "keep.txt")));
      assert.ok(!h.gitCalls.some((c) => c.args.includes("prune")));
    });
  });

  describe("process groups", () => {
    it("records a step's group while it runs and clears it after", async () => {
      h.prView.files = [{ path: "apps/mobile/e2e/android-all.yaml" }];
      let during = null;
      let runDir;
      h.onRun = (cmd, args, opts) => {
        if (cmd === "./gradlew") {
          opts.onChild?.({ pid: 7100 });
          during = readGroups(nodeFs, runDir);
        }
        return null;
      };
      const r = await start();
      runDir = r.runDir;
      h.deps.pid = SUP_PID;
      await runSupervise({ runDir }, { deps: h.deps });
      assert.deepEqual(during["child:7100"], {
        pid: 7100,
        match: "gradlew",
        markers: [h.knobs.volume],
      });
      assert.deepEqual(during.emulator, undefined);
      assert.equal(existsSync(path.join(runDir, PGIDS_FILE)), false);
    });

    it("killRecordedGroups signals only leaders that are still the recorded process", async () => {
      const runDir = path.join(h.tmp, "rd");
      mkdirSync(runDir);
      writeFileSync(
        path.join(runDir, PGIDS_FILE),
        JSON.stringify({
          child: { pid: 7000, match: "gradlew" },
          emulator: { pid: 7001, match: "drafto-factory" },
          other: { pid: 7002, match: "xcodebuild" },
          dead: { pid: 7003, match: "maestro" },
        }),
      );
      for (const pid of [7000, 7001, 7002]) h.alive.add(pid);
      h.deps.psCommand = async (pid) =>
        ({
          7000: "/bin/sh ./gradlew assembleRelease",
          7001: "qemu-system -avd drafto-factory -port 5580",
          7002: "vim",
        })[pid] ?? "";
      const killed = await killRecordedGroups(runDir, "SIGKILL", h.deps);
      assert.deepEqual(killed, [7000, 7001]);
      assert.deepEqual(h.kills, [
        { pid: -7000, signal: "SIGKILL" },
        { pid: -7001, signal: "SIGKILL" },
      ]);
    });

    it("housekeeping kills a dead supervisor's recorded groups", async () => {
      const r = await start();
      writeFileSync(
        path.join(r.runDir, PGIDS_FILE),
        JSON.stringify({ child: { pid: 7200, match: "xcodebuild" } }),
      );
      h.alive.add(7200);
      h.deps.psCommand = async (pid) => (pid === 7200 ? "/usr/bin/xcodebuild -workspace" : "");
      const out = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
      assert.equal(out.outcome, "retry:lost");
      assert.deepEqual(out.groups, [7200]);
      assert.ok(h.kills.some((k) => k.pid === -7200 && k.signal === "SIGKILL"));
    });

    it("housekeeping kills an overdue supervisor's recorded groups too", async () => {
      const r = await start();
      h.alive.add(SUP_PID);
      h.alive.add(7300);
      writeFileSync(
        path.join(r.runDir, PGIDS_FILE),
        JSON.stringify({ emulator: { pid: 7300, match: "drafto-factory" } }),
      );
      const base = h.deps.psCommand;
      h.deps.psCommand = async (pid) => (pid === 7300 ? "emulator -avd drafto-factory" : base(pid));
      const now = new Date(Date.parse(r.deadlineAt) + 25 * 60_000).toISOString();
      const out = await runHousekeeping({ repoRoot: h.repoRoot, now }, h.deps);
      assert.equal(out.state, "overdue");
      assert.equal(out.signal, "SIGKILL");
      assert.ok(h.kills.some((k) => k.pid === -SUP_PID && k.signal === "SIGKILL"));
      assert.ok(h.kills.some((k) => k.pid === -7300 && k.signal === "SIGKILL"));
    });

    it("stop kills the recorded groups when the supervisor is already gone", async () => {
      const r = await start();
      writeFileSync(
        path.join(r.runDir, PGIDS_FILE),
        JSON.stringify({ child: { pid: 7400, match: "maestro" } }),
      );
      h.alive.add(7400);
      h.deps.psCommand = async (pid) => (pid === 7400 ? "java -jar maestro test" : "");
      const out = await runStop({ repoRoot: h.repoRoot, issue: "874" }, h.deps);
      assert.equal(out.signalled, false);
      assert.deepEqual(out.groups, [7400]);
    });

    it("killGroup escalates to SIGKILL after the grace period, only if still alive", async () => {
      h.alive.add(7500);
      killGroup(h.deps, { pid: 7500 }, 5);
      killGroup(h.deps, { pid: 7501 }, 5);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(h.kills, [
        { pid: -7500, signal: "SIGTERM" },
        { pid: -7501, signal: "SIGTERM" },
        { pid: -7500, signal: "SIGKILL" },
      ]);
    });

    it("killGroup SIGKILLs a group whose leader exited but whose members live on", async () => {
      h.aliveGroups.add(7600); // gradle's wrapper gone, its forked daemon still building
      await killGroup(h.deps, { pid: 7600 }, 5);
      assert.deepEqual(h.kills, [
        { pid: -7600, signal: "SIGTERM" },
        { pid: -7600, signal: "SIGKILL" },
      ]);
    });

    it("the supervisor kills a lingering step group before forgetting it, but leaves the emulator", async () => {
      const runDir = path.join(h.repoRoot, "lingering");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        path.join(runDir, PGIDS_FILE),
        JSON.stringify({
          child: { pid: 7700, match: "gradle" },
          emulator: { pid: 7701, match: "qemu" },
        }),
      );
      h.aliveGroups.add(7700);
      h.aliveGroups.add(7701);
      assert.deepEqual(await killLingeringGroups(runDir, h.deps), [7700]);
      assert.deepEqual(h.kills, [{ pid: -7700, signal: "SIGKILL" }]);
    });

    it("selftest --build: Ctrl-C stops the step and still shuts the emulator down", async () => {
      const before = process.listenerCount("SIGINT");
      let signalled = false;
      h.onRun = async (cmd, args, opts) => {
        if (path.basename(cmd) !== "maestro" || signalled) return null;
        signalled = true;
        // A running step: it ends only once the handler has signalled its group.
        opts.onChild?.({ pid: 7650 });
        h.alive.add(7650);
        process.emit("SIGINT");
        const hit = () => h.kills.some((k) => k.pid === -7650 && k.signal === "SIGTERM");
        for (let i = 0; i < 200 && !hit(); i++) await new Promise((res) => setTimeout(res, 5));
        h.alive.delete(7650);
        return { code: 143, stdout: "", timedOut: false };
      };
      const out = await runSelftestBuild({ repoRoot: h.repoRoot, platform: "android" }, h.deps);
      assert.equal(out.ok, false);
      assert.equal(out.platform.state, "stopped:signal");
      assert.ok(h.kills.some((k) => k.pid === -7650 && k.signal === "SIGTERM"));
      assert.ok(emuKilled());
      assert.equal(process.listenerCount("SIGINT"), before);
      assert.equal(existsSync(deviceLockPath(h.knobs)), false);
    });
  });

  describe("java for Maestro", () => {
    it("an iOS-only run needs java too", async () => {
      delete h.env.FACTORY_DEVICE_JAVA_HOME;
      const r = await start();
      assert.equal(r.reason, "java-missing");
    });

    it("falls back to java_home, and Maestro on iOS gets JAVA_HOME", async () => {
      delete h.env.FACTORY_DEVICE_JAVA_HOME;
      h.javaHomeFound = "/Library/Java/JavaVirtualMachines/jdk-21/Contents/Home";
      await startAndSupervise();
      const maestro = callsOf("maestro");
      assert.ok(maestro.length >= 1);
      for (const c of maestro) {
        assert.equal(c.env.JAVA_HOME, h.javaHomeFound);
        assert.ok(c.env.PATH.startsWith(`${h.javaHomeFound}/bin:`));
      }
    });
  });

  describe("sign-in before flows that need it", () => {
    const flowText = (rel) => readFileSync(path.join(REPO, "apps", "mobile", "e2e", rel), "utf8");

    it("knows which repo flows start signed in, signed out, or sign themselves in", () => {
      const needs = [
        "02-create-notebook.yaml",
        "03-create-edit-note.yaml",
        "04-trash-restore.yaml",
        "11-sign-out-confirm.yaml",
        "search.yaml",
        "ios-only/search.yaml",
        "ios-only/07-attach-image.yaml",
      ];
      const not = [
        "01-login.yaml",
        "06-forgot-password.yaml",
        "09-password-visibility.yaml",
        "10-swipe-hint.yaml",
        "12-signup-email.yaml",
        "ios-all.yaml",
        "android-all.yaml",
        "ios-only/08-fab-above-home-indicator.yaml",
        "android-only/07-auth-callback-link.yaml",
        "android-only/11-dark-nav-bar.yaml",
      ];
      for (const f of needs) assert.equal(flowNeedsSignIn(flowText(f)), true, f);
      for (const f of not) assert.equal(flowNeedsSignIn(flowText(f)), false, f);
      assert.equal(
        flowNeedsSignIn("appId: x\n# device-lane: no-sign-in\n---\n- launchApp\n"),
        false,
      );
      assert.equal(
        flowNeedsSignIn("appId: x\n# device-lane: needs-sign-in\n---\n- clearKeychain\n"),
        true,
      );
      assert.equal(flowNeedsSignIn(""), true);
    });

    it("signs in before 02 but not before a signed-out flow, with one RUN_ID for the run", async () => {
      h.prView.files = [
        { path: "apps/mobile/e2e/02-create-notebook.yaml" },
        { path: "apps/mobile/e2e/06-forgot-password.yaml" },
      ];
      const { output } = await startAndSupervise({ platforms: "ios" });
      const flows = callsOf("maestro").map((c) =>
        path.relative(deviceRootFor(h.knobs, "ios"), c.args[3]),
      );
      assert.deepEqual(flows, [
        WARMUP_FLOW,
        "apps/mobile/e2e/ios-all.yaml",
        SIGN_IN_PRELUDE,
        "apps/mobile/e2e/02-create-notebook.yaml",
        "apps/mobile/e2e/06-forgot-password.yaml",
      ]);
      const runIdOf = (flow) =>
        callsOf("maestro")
          .find((c) => c.args[3].endsWith(flow))
          .args.find((a) => a.startsWith("RUN_ID="));
      // The smoke flow keeps the base RUN_ID; 02 and 06 each get a fresh one,
      // so 02's notebook can't collide with the smoke flow's "NB <RUN_ID>".
      const ids = ["ios-all.yaml", "02-create-notebook.yaml", "06-forgot-password.yaml"].map(
        runIdOf,
      );
      assert.equal(new Set(ids).size, 3);
      for (const id of ids) assert.match(id, /^RUN_ID=\d{10}$/);
      const prelude = readFileSync(
        path.join(deviceRootFor(h.knobs, "ios"), SIGN_IN_PRELUDE),
        "utf8",
      );
      assert.ok(prelude.includes("file: helpers/sign-in-clean.yaml"));
      assert.ok(prelude.includes("MAESTRO_E2E_TEST_PASSWORD"));
      assert.ok(!prelude.includes(PASSWORD));
      assert.deepEqual(
        output.platforms.ios.flows.map((f) => f.name),
        ["ios-all.yaml", "02-create-notebook.yaml", "06-forgot-password.yaml"],
      );
    });

    it("a failed sign-in marks the flow ERROR without running it", async () => {
      h.prView.files = [{ path: "apps/mobile/e2e/02-create-notebook.yaml" }];
      h.onRun = (cmd, args) =>
        path.basename(cmd) === "maestro" && args[3].endsWith(SIGN_IN_PRELUDE)
          ? { code: 1, stdout: "", timedOut: false }
          : null;
      const { output } = await startAndSupervise({ platforms: "ios" });
      const row = output.platforms.ios.flows[1];
      assert.equal(row.status, "ERROR");
      assert.match(row.failure, /sign-in before this flow failed/);
      assert.ok(!callsOf("maestro").some((c) => c.args[3].endsWith("02-create-notebook.yaml")));
      assert.equal(output.platforms.ios.verdict, "ERROR");
    });

    it("warms Maestro up before the first flow, and a failed warm-up only logs", async () => {
      h.prView.files = [{ path: "apps/mobile/src/app.tsx" }];
      h.onRun = (cmd, args) =>
        path.basename(cmd) === "maestro" && args[3].endsWith(WARMUP_FLOW)
          ? { code: 1, stdout: "", timedOut: false }
          : null;
      const { output } = await startAndSupervise({ platforms: "ios" });
      const flows = callsOf("maestro").map((c) => path.basename(c.args[3]));
      assert.deepEqual(flows, [
        path.basename(WARMUP_FLOW),
        path.basename(WARMUP_FLOW),
        "ios-all.yaml",
      ]);
      assert.equal(output.platforms.ios.flows[0].name, "ios-all.yaml");
      const yaml = warmUpYaml();
      assert.match(yaml, /^appId: eu\.drafto\.mobile$/m);
      assert.match(yaml, /^- launchApp:$/m);
      assert.match(yaml, /^    clearState: true$/m);
      assert.ok(!/E2E_TEST|runScript|runFlow/.test(yaml));
    });

    it("retries an Android flow once when the device dropped off adb, and says so if it still fails", async () => {
      h.prView.files = [{ path: "apps/mobile/src/app.tsx" }];
      let smokeRuns = 0;
      h.onRun = (cmd, args, opts) => {
        if (path.basename(cmd) !== "maestro" || !args[3].endsWith("android-all.yaml")) return null;
        smokeRuns += 1;
        writeFileSync(opts.stdoutFile, "java.io.IOException: device offline\n");
        return { code: 1, stdout: "", timedOut: false };
      };
      const { output } = await startAndSupervise({ platforms: "android" });
      assert.equal(smokeRuns, 2);
      assert.match(output.platforms.android.flows[0].failure, /after one retry for an adb drop/);
    });

    it("never treats an iOS failure as an adb drop", async () => {
      h.prView.files = [{ path: "apps/mobile/src/app.tsx" }];
      let smokeRuns = 0;
      h.onRun = (cmd, args, opts) => {
        if (path.basename(cmd) !== "maestro" || !args[3].endsWith("ios-all.yaml")) return null;
        smokeRuns += 1;
        writeFileSync(opts.stdoutFile, "device 'ABCD' not found\n");
        return { code: 1, stdout: "", timedOut: false };
      };
      const { output } = await startAndSupervise({ platforms: "ios" });
      assert.equal(smokeRuns, 1);
      assert.doesNotMatch(output.platforms.ios.flows[0].failure ?? "", /adb drop/);
    });

    it("a flow that depends on an earlier one shares the smoke flow's RUN_ID", () => {
      assert.equal(
        flowDependsOnEarlier("appId: x\n# Depends on: 02-create-notebook (NB <RUN_ID> exists)\n"),
        true,
      );
      assert.equal(flowDependsOnEarlier("appId: x\n# Pass -e RUN_ID=<timestamp>\n"), false);
      assert.equal(
        flowDependsOnEarlier("appId: x\n# Depends on: 01-login (user is logged in)\n"),
        false,
      );
      const real = readFileSync(
        path.join(REPO, "apps/mobile/e2e/03-create-edit-note.yaml"),
        "utf8",
      );
      assert.equal(flowDependsOnEarlier(real), true);
    });

    it("recognises Maestro's adb-drop signatures only", () => {
      assert.equal(
        isAdbDrop("Command failed (host:transport:emulator-5580): device offline"),
        true,
      );
      assert.equal(isAdbDrop("adb: device 'emulator-5580' not found"), true);
      assert.equal(isAdbDrop('Assertion is false: "Saved" is visible'), false);
      assert.equal(isAdbDrop(""), false);
    });
  });

  it("housekeeping reaps old selftest run dirs", async () => {
    const runRoot = path.join(h.repoRoot, "logs", "factory", "device", "runs");
    const old = path.join(runRoot, "selftest-android-20260101T000000Z");
    const recent = path.join(runRoot, "selftest-ios-20261120T000000Z");
    mkdirSync(old, { recursive: true });
    mkdirSync(path.join(recent, "private"), { recursive: true });
    const longAgo = new Date(h.clock - 40 * 24 * 60 * 60_000);
    utimesSync(old, longAgo, longAgo);
    const out = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.deepEqual(out.reaped.runDirs, [old]);
    assert.deepEqual(out.reaped.privateDirs, [recent]);
    assert.equal(existsSync(old), false);
  });
});

describe("JDK toolchains for gradle", () => {
  let home;
  beforeEach(() => {
    home = nodeFs.mkdtempSync(path.join(tmpdir(), "device-jdk-"));
  });
  afterEach(() => nodeFs.rmSync(home, { recursive: true, force: true }));

  function makeJdk(dir, version) {
    nodeFs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    nodeFs.writeFileSync(path.join(dir, "bin", "java"), "");
    nodeFs.writeFileSync(path.join(dir, "release"), `JAVA_VERSION="${version}"\n`);
    return dir;
  }

  it("reads the major version from a JDK's release file", () => {
    assert.equal(jdkMajor(nodeFs, makeJdk(path.join(home, "a"), "17.0.17")), 17);
    assert.equal(jdkMajor(nodeFs, makeJdk(path.join(home, "b"), "1.8.0_392")), 8);
    assert.equal(jdkMajor(nodeFs, path.join(home, "missing")), null);
  });

  it("finds gradle-provisioned JDKs, the java home and explicit paths, without duplicates", () => {
    const provisioned = makeJdk(
      path.join(
        home,
        ".gradle",
        "jdks",
        "eclipse_adoptium-17",
        "jdk-17.0.17+10",
        "Contents",
        "Home",
      ),
      "17.0.17",
    );
    const jbr = makeJdk(path.join(home, "jbr"), "21.0.9");
    const extra = makeJdk(path.join(home, "extra"), "24");
    nodeFs.mkdirSync(path.join(home, ".gradle", "jdks", "broken"), { recursive: true });
    const homes = findJdkHomes({ home, javaHome: jbr, jdkPaths: [extra, jbr] }, nodeFs);
    assert.deepEqual(homes.slice(0, 3), [extra, jbr, provisioned]);
    assert.equal(new Set(homes).size, homes.length);
  });

  it("turns toolchain auto-download off and names the installed JDKs", () => {
    const knobs = { keystore: "/k/debug.keystore" };
    const args = androidBuildArgsForJdk(knobs, ["/jdk17", "/jbr 21"]);
    assert.ok(args.includes("-Porg.gradle.java.installations.auto-download=false"));
    assert.ok(args.includes("-Porg.gradle.java.installations.paths=/jdk17,/jbr 21"));
    const none = androidBuildArgsForJdk(knobs, []);
    assert.ok(!none.some((a) => a.startsWith("-Porg.gradle.java.installations.paths=")));
  });
});

describe("review round 3", () => {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  function stepCtx(extra = {}) {
    return {
      deps: h.deps,
      status: { child: null },
      checkpoint: async () => {},
      interruptReason: async () => null,
      pollMs: 5,
      recordGroups: true,
      runDir: h.tmp,
      log: () => {},
      ...extra,
    };
  }
  const step = (pid, ms) => async (cmd, args, opts) => {
    opts.onChild?.({ pid });
    await sleep(ms);
    return { code: 0, stdout: "", timedOut: false };
  };

  describe("guardedRun", () => {
    it("a probe that resolves after its step ended never touches the next step", async () => {
      let calls = 0;
      const ctx = stepCtx({
        interruptReason: async () => {
          if (++calls > 1) return null;
          await sleep(40); // a slow memory probe, started during step A
          return "stopped:memory";
        },
      });
      h.deps.run = step(8001, 15);
      await guardedRun(ctx, "/bin/a", [], {});
      h.deps.run = step(8002, 80);
      const b = await guardedRun(ctx, "/bin/b", [], {});
      assert.equal(b.code, 0);
      assert.ok(!h.kills.some((k) => Math.abs(k.pid) === 8002), JSON.stringify(h.kills));
    });

    it("a probe that resolves while its step runs interrupts that step", async () => {
      let calls = 0;
      const ctx = stepCtx({
        interruptReason: async () => (++calls === 1 ? "stopped:memory" : null),
      });
      h.deps.run = step(8003, 60);
      await assert.rejects(guardedRun(ctx, "/bin/a", [], {}), /stopped:memory/);
      assert.ok(h.kills.some((k) => k.pid === -8003 && k.signal === "SIGTERM"));
    });

    it("keeps a step's group on record until its members are gone", async () => {
      const ctx = stepCtx();
      h.aliveGroups.add(8100); // the leader exits, a forked daemon stays
      h.deps.run = step(8100, 1);
      const kill = h.deps.kill;
      h.deps.kill = () => true; // a member that survives even SIGKILL (for now)
      await guardedRun(ctx, "/bin/gradlew", [], {});
      assert.deepEqual(readGroups(nodeFs, h.tmp)["child:8100"], { pid: 8100, match: "gradlew" });
      // Gone once SIGKILL lands: the record is dropped.
      h.deps.kill = (pid, sig) => {
        if (sig === "SIGKILL") h.aliveGroups.delete(Math.abs(pid));
        return kill(pid, sig);
      };
      h.deps.run = step(8101, 1);
      h.aliveGroups.add(8101);
      await guardedRun(ctx, "/bin/xcodebuild", [], {});
      assert.equal(readGroups(nodeFs, h.tmp)["child:8101"], undefined);
      assert.ok(h.kills.some((k) => k.pid === -8101 && k.signal === "SIGKILL"));
    });
  });

  it("an iOS artifact with an unreadable directory is refused, not half-scanned", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root reads everything");
    const app = path.join(h.tmp, "Drafto.app");
    mkdirSync(path.join(app, "EXConstants.bundle"), { recursive: true });
    writeFileSync(path.join(app, "EXConstants.bundle", "app.config"), GOOD_CONFIG);
    const ctx = { deps: h.deps, meta: { bins: {} }, rawDir: h.tmp, cwd: h.tmp };
    assert.deepEqual(await checkArtifact(ctx, "ios", app), { ok: true, problem: null });
    const hidden = path.join(app, "Frameworks");
    mkdirSync(hidden);
    writeFileSync(path.join(hidden, "x.js"), `https://${PROD_REF}.supabase.co`);
    chmodSync(hidden, 0o000);
    try {
      assert.deepEqual(await checkArtifact(ctx, "ios", app), { ok: false, problem: "unreadable" });
    } finally {
      chmodSync(hidden, 0o700);
    }
  });

  describe("ledger", () => {
    it("mutateLedger waits for another live process's lock, however old it is", async () => {
      const file = ledgerPath(h.repoRoot);
      mkdirSync(path.dirname(file), { recursive: true });
      // A slow live owner (our parent, which is certainly alive) with an old lock.
      writeFileSync(`${file}.pidlock`, `${process.ppid}\n`);
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(`${file}.pidlock`, old, old);
      let done = false;
      const p = mutateLedger(file, (l) => {
        l.last.x = 1;
        done = true;
        return true;
      });
      await sleep(80);
      assert.equal(done, false);
      assert.equal(readFileSync(`${file}.pidlock`, "utf8"), `${process.ppid}\n`);
      rmSync(`${file}.pidlock`);
      await p;
      assert.equal(done, true);
      assert.equal((await loadLedger(file)).last.x, 1);
      assert.equal(existsSync(`${file}.pidlock`), false);
    });

    it("takes over a lock whose owner is dead", async () => {
      const file = ledgerPath(h.repoRoot);
      mkdirSync(path.dirname(file), { recursive: true });
      const dead = spawnSync("/usr/bin/true").pid;
      writeFileSync(`${file}.pidlock`, `${dead}\n`);
      assert.equal(await mutateLedger(file, () => true), true);
      assert.equal(existsSync(`${file}.pidlock`), false);
    });

    it("concurrent mutations in one process never lose an update", async () => {
      const file = ledgerPath(h.repoRoot);
      await Promise.all(
        Array.from({ length: 20 }, () =>
          mutateLedger(file, (l) => {
            l.last.n = (l.last.n ?? 0) + 1;
            return true;
          }),
        ),
      );
      assert.equal((await loadLedger(file)).last.n, 20);
    });

    it("a lock take that throws gives the reservation back", async () => {
      const lock = deviceLockPath(h.knobs);
      const real = h.deps.fs;
      h.deps.fs = new Proxy(real, {
        get(target, key) {
          if (key === "writeFileSync") {
            return (f, ...rest) => {
              if (String(f).startsWith(lock)) throw new Error("EROFS: read-only file system");
              return target.writeFileSync(f, ...rest);
            };
          }
          return target[key];
        },
      });
      const r = await start();
      assert.equal(r.reason, "start-failed");
      const ledger = await loadLedger(ledgerPath(h.repoRoot));
      assert.equal(ledger.inFlight, null);
      assert.equal(attemptsFor(ledger, "874", SHA), 0);
      h.deps.fs = real;
      assert.equal((await start()).started, true);
    });
  });

  it("idle housekeeping holds the device lock from the probe through the stop", async () => {
    h.simBooted = true;
    h.alive.add(9999);
    h.alive.add(TICK_PID); // the housekeeping process itself
    let tookDuringProbe = null;
    h.onRun = (cmd, args) => {
      if (path.basename(cmd) === "xcrun" && args.includes("list")) {
        tookDuringProbe = takePidLock(deviceLockPath(h.knobs), 9999, h.deps).ok;
      }
      return null;
    };
    const out = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.equal(tookDuringProbe, false);
    assert.ok(out.reaped.devices);
    assert.equal(existsSync(deviceLockPath(h.knobs)), false);
  });

  it("housekeeping keeps private/ of a run made with FACTORY_DEVICE_KEEP_RAW=1", async () => {
    const runRoot = path.join(h.repoRoot, "logs", "factory", "device", "runs");
    const keep = path.join(runRoot, "874-aaaaaaaaaaaa-20261120T000000Z");
    const drop = path.join(runRoot, "874-aaaaaaaaaaaa-20261121T000000Z");
    for (const d of [keep, drop]) mkdirSync(path.join(d, "private"), { recursive: true });
    writeFileSync(path.join(keep, "meta.json"), JSON.stringify({ knobs: { keepRaw: true } }));
    writeFileSync(path.join(drop, "meta.json"), JSON.stringify({ knobs: { keepRaw: false } }));
    const out = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.deepEqual(out.reaped.privateDirs, [drop]);
    assert.ok(existsSync(path.join(keep, "private")));
  });

  it("a lost run's simulator comes from its meta.json, not today's config", async () => {
    const r = await start();
    assert.equal(runSimUdid(nodeFs, r.runDir), h.udid);
    const other = "99999999-8888-7777-6666-555555555555";
    writeFileSync(
      path.join(h.repoRoot, "logs", "factory", "device-config.json"),
      JSON.stringify({ iosSimUdid: other }),
    );
    const out = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.equal(out.outcome, "retry:lost");
    const shutdowns = callsOf("xcrun").filter((c) => c.args.includes("shutdown"));
    assert.ok(shutdowns.some((c) => c.args.includes(h.udid)));
    assert.ok(!shutdowns.some((c) => c.args.includes(other)));
  });

  it("a PR that deletes the smoke flow: the platform is unavailable, nothing builds", async () => {
    h.prView.files = [{ path: "apps/mobile/e2e/ios-all.yaml", changeType: "DELETED" }];
    const { r, output } = await startAndSupervise();
    assert.deepEqual(r.platforms, { ios: { flows: [], unavailable: "no-smoke-flow" } });
    assert.equal(output.platforms.ios.state, "unavailable:no-smoke-flow");
    assert.equal(callsOf("xcodebuild").length, 0);
    assert.equal(callsOf("pnpm").length, 0);
  });

  it("a flow whose header can't be read at the head isn't run", async () => {
    h.prView.files = [{ path: "apps/mobile/e2e/10-swipe-hint.yaml" }];
    const git = h.deps.git;
    h.deps.git = async (args, opts) =>
      args[0] === "show" ? { code: 128, stdout: "", timedOut: false } : git(args, opts);
    const r = await start({ platforms: "ios" });
    assert.deepEqual(r.platforms.ios.flows, ["apps/mobile/e2e/ios-all.yaml"]);
    assert.ok(r.reasons.some((x) => /10-swipe-hint\.yaml skipped .*tags couldn't be read/.test(x)));
  });

  it("flowNeedsSignIn ignores a password named only in a trailing comment", () => {
    const flow = 'appId: x\n---\n- launchApp\n- inputText: "search" # E2E_TEST_PASSWORD\n';
    assert.equal(flowNeedsSignIn(flow), true);
    const real =
      "appId: x\n---\n- launchApp\n- inputText: \"${typeof E2E_TEST_PASSWORD !== 'undefined' ? E2E_TEST_PASSWORD : MAESTRO_E2E_TEST_PASSWORD}\" # sign in\n";
    assert.equal(flowNeedsSignIn(real), false);
  });
});

describe("review round 4", () => {
  it("judgeArtifact compares the parsed Supabase origin", () => {
    const cfg = (supabaseUrl) =>
      JSON.stringify({ extra: { supabaseUrl, apiUrl: INVALID_API_URL }, note: DEV_REF });
    const judge = (u) => judgeArtifact({ readOk: true, prodFound: false, configText: cfg(u) });
    assert.equal(judge(`https://${DEV_REF}.supabase.co`).ok, true);
    assert.equal(judge(`https://${DEV_REF}.supabase.co/`).ok, true);
    assert.equal(judge(`https://${DEV_REF}.evil.example`).problem, "supabase-url");
    assert.equal(judge(`https://${DEV_REF}.supabase.co.evil.example`).problem, "supabase-url");
    assert.equal(judge(`http://${DEV_REF}.supabase.co`).problem, "supabase-url");
    assert.equal(judge("not a url").problem, "supabase-url");
  });

  it("an unavailable platform needs neither its tools nor a build root", async () => {
    h.prView.files = [
      { path: "apps/mobile/e2e/ios-all.yaml", changeType: "DELETED" },
      { path: "packages/shared/src/x.ts" },
    ];
    const iosRoot = deviceRootFor(h.knobs, "ios");
    rmSync(iosRoot, { recursive: true, force: true });
    h.deps.isExecutable = (p) => !p.endsWith("/pod"); // no CocoaPods on this host
    const r = await start();
    assert.equal(r.started, true, JSON.stringify(r));
    assert.deepEqual(r.platforms.ios, { flows: [], unavailable: "no-smoke-flow" });
    assert.ok(!h.gitCalls.some((c) => c.args.includes(iosRoot)), "no iOS worktree");
    assert.equal(existsSync(iosRoot), false);
  });

  it("the reservation re-checks the attempt budget under the ledger lock", async () => {
    // Another start for this head spends the last attempt while this one
    // reads the PR.
    const gh = h.deps.gh;
    h.deps.gh = async (args) => {
      const ledger = await loadLedger(ledgerPath(h.repoRoot));
      ledger.attempts["874"] = { [SHA]: 2 };
      await saveLedger(ledger, ledgerPath(h.repoRoot));
      return gh(args);
    };
    const r = await start();
    assert.equal(r.reason, "attempts");
    assert.equal(r.attempts, 2);
    const ledger = await loadLedger(ledgerPath(h.repoRoot));
    assert.equal(ledger.inFlight, null);
    assert.equal(attemptsFor(ledger, "874", SHA), 2);
    assert.equal((await start({ forceAttempt: true })).started, true);
  });

  describe("retained groups whose leader exited", () => {
    function record(runDir, groups) {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(path.join(runDir, PGIDS_FILE), JSON.stringify(groups));
    }

    it("killRecordedGroups recognises a leaderless group by its members", async () => {
      const runDir = path.join(h.tmp, "rd2");
      record(runDir, {
        "child:7800": { pid: 7800, match: "gradlew", markers: [h.volume] },
        "child:7900": { pid: 7900, match: "xcodebuild", markers: [h.volume] },
      });
      // 7800: the wrapper is gone, its daemon (under the volume) still runs.
      // 7900: a group with members that are not ours (unverified): left alone.
      h.aliveGroups.add(7800);
      h.aliveGroups.add(7900);
      h.procs = [
        {
          pid: 7801,
          pgid: 7800,
          command: `java -cp ${h.volume}/drafto-device/gradle/x GradleDaemon`,
        },
        { pid: 7901, pgid: 7900, command: "/usr/bin/vim notes.txt" },
      ];
      assert.deepEqual(await killRecordedGroups(runDir, "SIGKILL", h.deps), [7800]);
      assert.deepEqual(h.kills, [{ pid: -7800, signal: "SIGKILL" }]);
    });

    it("a lost run's leftover group is retried by later housekeeping and forgotten once gone", async () => {
      const r = await start();
      record(r.runDir, { "child:7800": { pid: 7800, match: "gradlew", markers: [h.volume] } });
      h.aliveGroups.add(7800);
      // Its member survives this pass (stuck), so the record stays.
      h.procs = [{ pid: 7801, pgid: 7800, command: `java ${h.volume}/x GradleDaemon` }];
      const first = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
      assert.equal(first.outcome, "retry:lost");
      assert.ok(h.kills.some((k) => k.pid === -7800 && k.signal === "SIGKILL"));
      assert.ok(readGroups(nodeFs, r.runDir)["child:7800"]);
      // Next pass: killed again, still there; then gone: the record goes too.
      h.kills.length = 0;
      const second = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
      assert.deepEqual(second.reaped.groups, [7800]);
      assert.ok(existsSync(path.join(r.runDir, PGIDS_FILE)));
      h.aliveGroups.delete(7800);
      h.procs = [];
      await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
      assert.equal(existsSync(path.join(r.runDir, PGIDS_FILE)), false);
    });
  });

  it("a stop that lands while start is attaching keeps the slot and stops the supervisor", async () => {
    const spawn = h.deps.spawnDetached;
    let stopOut = null;
    h.deps.spawnDetached = async (command, args, opts) => {
      const r = await spawn(command, args, opts);
      if (args.includes("_supervise")) {
        // The supervisor exists but isn't attached yet (pid null in the ledger).
        stopOut = await runStop({ repoRoot: h.repoRoot, issue: "874", reason: "stop" }, h.deps);
      }
      return r;
    };
    const r = await start();
    assert.equal(stopOut.state, "stopping");
    assert.equal(r.started, false);
    assert.equal(r.reason, "stopped");
    assert.ok(h.kills.some((k) => k.pid === -SUP_PID && k.signal === "SIGTERM"));
    const ledger = await loadLedger(ledgerPath(h.repoRoot));
    assert.equal(ledger.inFlight.pid, SUP_PID);
    assert.equal(ledger.inFlight.stopping.reason, "stop");
    // Finalised once the supervisor is seen gone.
    h.runId = r.runId;
    h.alive.add(SUP_PID);
    assert.equal((await runHousekeeping({ repoRoot: h.repoRoot }, h.deps)).state, "stopping");
    h.alive.delete(SUP_PID);
    const done = await runHousekeeping({ repoRoot: h.repoRoot }, h.deps);
    assert.equal(done.state, "stopped");
    assert.equal((await loadLedger(ledgerPath(h.repoRoot))).inFlight, null);
  });

  it("a smoke flow tagged for the host, or unreadable, makes its platform unavailable", async () => {
    h.prView.files = [{ path: "apps/mobile/e2e/ios-all.yaml" }];
    const git = h.deps.git;
    h.deps.git = async (args, opts) =>
      args[0] === "show"
        ? { code: 0, stdout: "appId: x\ntags: [requires-host-offline]\n---\n", timedOut: false }
        : git(args, opts);
    const { r, output } = await startAndSupervise();
    assert.deepEqual(r.platforms.ios, { flows: [], unavailable: "smoke-flow-needs-host" });
    assert.equal(output.platforms.ios.state, "unavailable:smoke-flow-needs-host");
    assert.equal(callsOf("xcodebuild").length, 0);
    assert.equal(callsOf("maestro").length, 0);
  });
});

// ── phase (b): the scenario's mobile steps (device-scenario.mjs) ────────────

describe("scenario sessions", () => {
  const SESSION_PID = 7777;
  const UUID = "12345678-1234-4123-8123-123456789abc";
  const SECTIONS = [
    { heading: "iOS", text: "1. Create a notebook named NB. Expect it in the list." },
    { heading: "Web", text: "1. Open the preview." },
  ];
  const GOOD_FLOW = [
    "appId: eu.drafto.mobile",
    "---",
    '- tapOn: "Notebooks"',
    '- inputText: "NB ${RUN_ID}"',
    '- assertVisible: "NB ${RUN_ID}"',
    "",
  ].join("\n");
  const BAD_FLOW = [
    "appId: eu.drafto.mobile",
    "---",
    "- inputText: ${MAESTRO_E2E_TEST_PASSWORD}",
    "- runScript: steal.js",
    "",
  ].join("\n");
  const macrotask = () => new Promise((r) => setImmediate(r));

  let dr;
  beforeEach(async () => {
    dr = await import("../lib/device-scenario.mjs");
    h.env.FACTORY_DEVICE_SCENARIO = "1";
    h.env.GH_TOKEN = "ghp_should_never_reach_the_session";
    h.prView.files = [{ path: "apps/mobile/e2e/ios-all.yaml" }];
    h.deps.sleep = macrotask;
    h.deps.randomUUID = () => UUID;
    h.deps.checkGuard = async () => ({ ok: true });
    h.results = [];
    h.sessionEnded = false;
    h.events = [];
  });

  function isSession(args) {
    return String(args[0] ?? "").endsWith("run-claude.mjs");
  }

  /** A fake claude session: writes flows, calls the real device-run wrapper code. */
  function fakeSession({ flows = {}, requests = [], exit = 0, hang = false, summary } = {}) {
    h.onRun = async (cmd, args, opts) => {
      if (path.basename(cmd) === "maestro") {
        h.events.push({ kind: "maestro", flow: args[3], sessionEnded: h.sessionEnded });
        return null;
      }
      if (!isSession(args)) return null;
      h.session = { args: [...args], env: opts.env, cwd: opts.cwd, input: opts.input, opts };
      // The guard's files live in private/, which the run removes at its end.
      const settingsPath = args[args.indexOf("--settings") + 1];
      h.settings = readJson(settingsPath);
      h.guardCfg = readJson(path.join(path.dirname(settingsPath), "guard-config.json"));
      opts.onChild?.({ pid: SESSION_PID });
      for (const [name, text] of Object.entries(flows)) {
        writeFileSync(path.join(opts.cwd, "flows", name), text);
      }
      for (const flow of requests) {
        const r = await dr.deviceRunMain(["--dir", opts.cwd, "--timeout-sec", "60", "--", flow], {
          fs: nodeFs,
          sleep: macrotask,
          nowMs: () => Date.now(),
          pollMs: 0,
        });
        h.results.push(r);
      }
      if (hang) await new Promise((res) => (h.release = res));
      writeFileSync(
        opts.stdoutFile,
        summary ?? "## Scenario steps (ios)\n\n- PASS — create a notebook (`flows/01-nb.yaml`)\n",
      );
      h.sessionEnded = true;
      return { code: exit, timedOut: false, stdout: "" };
    };
  }

  function sessionCalls() {
    return h.calls.filter((c) => isSession(c.args));
  }

  it("starts no session without the knob, or without a section for the platform", async () => {
    fakeSession();
    h.env.FACTORY_DEVICE_SCENARIO = "0";
    let run = await startAndSupervise({ scenarioSections: SECTIONS });
    assert.equal(sessionCalls().length, 0);
    assert.equal(Object.hasOwn(run.output.platforms.ios, "scenarioState"), false);
    rmSync(tmp, { recursive: true, force: true });
    h = makeHarness();
    h.env.FACTORY_DEVICE_SCENARIO = "1";
    h.prView.files = [{ path: "apps/mobile/e2e/ios-all.yaml" }];
    fakeSession();
    run = await startAndSupervise({ scenarioSections: [{ heading: "Web", text: "x" }] });
    assert.equal(sessionCalls().length, 0);
    assert.deepEqual(Object.keys(run.output.platforms.ios).sort(), [
      "build",
      "flows",
      "state",
      "verdict",
    ]);
  });

  it("starts the session locked down: the argv shape, a scrubbed env, no password", async () => {
    fakeSession({ flows: { "01-nb.yaml": GOOD_FLOW }, requests: ["flows/01-nb.yaml"] });
    const { runDir, output } = await startAndSupervise({ scenarioSections: SECTIONS });
    assert.equal(sessionCalls().length, 1);
    const { args, env, cwd, input } = h.session;
    assert.equal(cwd, path.join(runDir, "scenario-ios"));
    const claudeArgs = args.slice(1);
    assert.deepEqual(claudeArgs.slice(0, 6), [
      "-p",
      "--no-chrome",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--settings",
    ]);
    const at = (flag) => claudeArgs[claudeArgs.indexOf(flag) + 1];
    assert.ok(path.isAbsolute(at("--settings")));
    assert.ok(!at("--settings").startsWith(cwd), "the guard's files are outside the session's dir");
    assert.equal(at("--permission-mode"), "dontAsk");
    assert.equal(at("--tools"), "Bash,Read,Grep,Glob,Write");
    assert.equal(at("--allowedTools"), "Bash,Read,Grep,Glob,Write");
    assert.equal(at("--session-id"), UUID);
    for (const f of ["--dangerously-skip-permissions", "--chrome", "--mcp-config", "--add-dir"]) {
      assert.ok(!claudeArgs.includes(f), f);
    }
    assert.equal(h.settings.permissions.deny.includes("Write"), false);
    assert.ok(h.settings.permissions.deny.includes("Edit"));
    assert.equal(h.guardCfg.mode, "device-scenario");
    assert.equal(h.guardCfg.worktree, cwd);
    // Gone with private/ once the run ends.
    assert.equal(existsSync(at("--settings")), false);
    // The environment: the lane's allowlist, the wrapper's bin dir first on PATH.
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.FACTORY_DEVICE_ACCOUNT_FILE, undefined);
    assert.equal(env.MAESTRO_E2E_TEST_PASSWORD, undefined);
    assert.equal(env.DRAFTO_UNATTENDED, "1");
    assert.ok(env.PATH.startsWith(path.join(cwd, "bin")));
    for (const text of [JSON.stringify(env), input, args.join(" ")]) {
      assert.ok(!text.includes(PASSWORD));
      assert.ok(!text.includes(EMAIL));
    }
    // The prompt carries only this platform's sections, enveloped as data.
    assert.match(input, /<scenario-section>### iOS\n\n1\. Create a notebook/);
    assert.doesNotMatch(input, /Open the preview/);
    // The directory: examples and helpers copied, the wrapper written.
    assert.ok(existsSync(path.join(cwd, "examples", "02-create-notebook.yaml")));
    assert.ok(existsSync(path.join(cwd, "helpers", "sign-in-clean.yaml")));
    assert.match(
      readFileSync(path.join(cwd, "helpers", "sign-in.yaml"), "utf8"),
      /sign-in-clean\.yaml/,
    );
    assert.match(
      readFileSync(path.join(cwd, "bin", "device-run"), "utf8"),
      /device-lane\.mjs' device-run --dir '/,
    );
    assert.equal(output.platforms.ios.scenarioState, "done");
  });

  it("an invalid flow gets the validator's errors and Maestro never sees it", async () => {
    fakeSession({ flows: { "01-bad.yaml": BAD_FLOW }, requests: ["flows/01-bad.yaml"] });
    const { output } = await startAndSupervise({ scenarioSections: SECTIONS });
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].exitCode, 1);
    assert.match(h.results[0].text, /REJECTED/);
    assert.match(h.results[0].text, /only \$\{RUN_ID\}/);
    assert.match(h.results[0].text, /runScript: isn't allowed/);
    assert.ok(!callsOf("maestro").some((c) => c.args.some((a) => String(a).includes("01-bad"))));
    // The final pass reports it, without running it.
    const row = output.platforms.ios.flows.find((f) => f.name === "scenario: 01-bad.yaml");
    assert.equal(row.status, "ERROR");
    assert.match(row.failure, /rejected by the validator/);
  });

  it("a valid flow runs, signed in, with the password only in Maestro's environment", async () => {
    fakeSession({ flows: { "01-nb.yaml": GOOD_FLOW }, requests: ["flows/01-nb.yaml"] });
    const { runDir } = await startAndSupervise({ scenarioSections: SECTIONS });
    assert.match(h.results[0].text, /request 1 \(flows\/01-nb\.yaml\): PASS/);
    assert.match(h.results[0].text, /iter-shots\/1-01-nb\.png/);
    assert.equal(h.results[0].exitCode, 0);
    const scenario = callsOf("maestro").filter((c) =>
      c.cwd?.includes(`${path.sep}snapshots${path.sep}`),
    );
    // Per run (the try and the final pass): a reset, the sign-in, the flow.
    assert.equal(scenario.length, 6);
    for (const c of scenario) {
      assert.equal(c.env.MAESTRO_E2E_TEST_PASSWORD, PASSWORD);
      assert.ok(!c.args.some((a) => String(a).includes(PASSWORD)));
    }
    const flowRuns = scenario.filter((c) =>
      c.args[3].endsWith(`${path.sep}flows${path.sep}01-nb.yaml`),
    );
    assert.equal(flowRuns.length, 2);
    // It ran the snapshot, never the session's own file.
    for (const c of flowRuns) assert.ok(!c.args[3].startsWith(path.join(runDir, "scenario-ios")));
    // Fresh RUN_IDs: the try and the final pass don't share one.
    const ids = flowRuns.map((c) => c.args.find((a) => String(a).startsWith("RUN_ID=")));
    assert.notEqual(ids[0], ids[1]);
    assert.ok(
      scenario.some((c) => c.args[3].endsWith(`${path.sep}helpers${path.sep}sign-in.yaml`)),
    );
  });

  it("the final pass runs only after the session's group is gone, and publishes only its shots", async () => {
    fakeSession({ flows: { "01-nb.yaml": GOOD_FLOW }, requests: ["flows/01-nb.yaml"] });
    // The group outlives the session's leader until the supervisor kills it.
    h.aliveGroups.add(SESSION_PID);
    const kill = h.deps.kill;
    h.deps.kill = (pid, signal) => {
      if (pid === -SESSION_PID && signal !== 0) {
        h.events.push({ kind: "kill", signal });
        h.aliveGroups.delete(SESSION_PID);
      }
      return kill(pid, signal);
    };
    const { runDir, output } = await startAndSupervise({ scenarioSections: SECTIONS });
    const killedAt = h.events.findIndex((e) => e.kind === "kill");
    assert.ok(killedAt >= 0, "the lingering group was killed");
    const finalRuns = h.events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.kind === "maestro" && e.sessionEnded);
    assert.ok(finalRuns.length > 0);
    for (const { i } of finalRuns) assert.ok(i > killedAt, "no final-pass run before the kill");
    // shots.json: phase (a)'s and the final pass's, nothing from iter-shots.
    const shots = readJson(path.join(runDir, "evidence", "shots.json"));
    assert.deepEqual(
      shots.map((s) => s.file),
      ["device-ios/01-ios-all.png", "device-ios/02-scenario-01-nb.png"],
    );
    assert.ok(shots.every((s) => s.pass === "final"));
    assert.ok(!JSON.stringify(shots).includes("iter-shots"));
    assert.ok(existsSync(path.join(runDir, "scenario-ios", "iter-shots", "1-01-nb.png")));
    const ios = output.platforms.ios;
    assert.deepEqual(
      ios.flows.map((f) => f.name),
      ["ios-all.yaml", "scenario: 01-nb.yaml"],
    );
    assert.equal(ios.verdict, "PASS");
    assert.match(ios.scenarioSummary, /PASS — create a notebook/);
  });

  it("a group that won't die gets no final pass", async () => {
    fakeSession({ flows: { "01-nb.yaml": GOOD_FLOW } });
    h.aliveGroups.add(SESSION_PID);
    const { output, runDir } = await startAndSupervise({ scenarioSections: SECTIONS });
    assert.equal(output.platforms.ios.scenarioState, "error");
    assert.deepEqual(
      output.platforms.ios.flows.map((f) => f.name),
      ["ios-all.yaml"],
    );
    assert.equal(readJson(path.join(runDir, "evidence", "shots.json")).length, 1);
  });

  it("the run cap refuses the next run, then kills the session's group", async () => {
    h.env.FACTORY_DEVICE_SCENARIO_RUNS = "1";
    fakeSession({
      flows: { "01-nb.yaml": GOOD_FLOW, "02-nb.yaml": GOOD_FLOW },
      requests: ["flows/01-nb.yaml", "flows/02-nb.yaml"],
      hang: true,
    });
    h.deps.sleep = async () => {
      h.clock += 30_000;
      await macrotask();
    };
    const kill = h.deps.kill;
    h.deps.kill = (pid, signal) => {
      if (pid === -SESSION_PID && signal === "SIGTERM") h.release?.();
      return kill(pid, signal);
    };
    const { output } = await startAndSupervise({ scenarioSections: SECTIONS });
    assert.match(h.results[0].text, /PASS/);
    assert.match(h.results[1].text, /REFUSED/);
    assert.match(h.results[1].text, /runs are used up/);
    assert.ok(h.kills.some((k) => k.pid === -SESSION_PID && k.signal === "SIGTERM"));
    assert.equal(output.platforms.ios.scenarioState, "timeout");
    // The final pass still runs both flows.
    assert.equal(output.platforms.ios.flows.length, 3);
  });

  it("the session cap kills the session's group", async () => {
    h.env.FACTORY_DEVICE_SCENARIO_MIN = "10";
    fakeSession({ hang: true });
    h.deps.sleep = async () => {
      h.clock += 60_000;
      await macrotask();
    };
    const kill = h.deps.kill;
    h.deps.kill = (pid, signal) => {
      if (pid === -SESSION_PID && signal === "SIGTERM") h.release?.();
      return kill(pid, signal);
    };
    const { output, runDir } = await startAndSupervise({ scenarioSections: SECTIONS });
    assert.ok(h.kills.some((k) => k.pid === -SESSION_PID && k.signal === "SIGTERM"));
    assert.equal(output.platforms.ios.scenarioState, "timeout");
    assert.match(
      readFileSync(path.join(runDir, "supervisor.log"), "utf8"),
      /stopping the session \(time cap\)/,
    );
  });

  it("a failed session keeps phase (a)'s results", async () => {
    fakeSession({ exit: 1 });
    let { output } = await startAndSupervise({ scenarioSections: SECTIONS });
    let ios = output.platforms.ios;
    assert.equal(ios.state, "done");
    assert.equal(ios.verdict, "PASS");
    assert.deepEqual(
      ios.flows.map((f) => f.name),
      ["ios-all.yaml"],
    );
    assert.equal(ios.scenarioState, "error");

    h = makeHarness();
    h.env.FACTORY_DEVICE_SCENARIO = "1";
    h.prView.files = [{ path: "apps/mobile/e2e/ios-all.yaml" }];
    h.deps.sleep = macrotask;
    h.deps.checkGuard = async () => ({ ok: true });
    h.onRun = async (cmd, args) => {
      if (isSession(args)) throw new Error("spawn failed");
      return null;
    };
    ({ output } = await startAndSupervise({ scenarioSections: SECTIONS }));
    ios = output.platforms.ios;
    assert.equal(ios.state, "done");
    assert.equal(ios.verdict, "PASS");
    assert.equal(ios.scenarioState, "error");
  });

  it("a session the guard didn't cover: its flows aren't run", async () => {
    fakeSession({ flows: { "01-nb.yaml": GOOD_FLOW } });
    h.deps.checkGuard = async () => ({ ok: false, sessionStart: false });
    const { output } = await startAndSupervise({ scenarioSections: SECTIONS });
    assert.equal(output.platforms.ios.scenarioState, "error");
    assert.equal(output.platforms.ios.flows.length, 1);
  });

  it("a summary with the password or a secret is withheld", () => {
    assert.match(dr.sanitizeSummary(`typed ${PASSWORD}`, { password: PASSWORD }), /withheld/);
    assert.match(dr.sanitizeSummary(`key dk_${"a".repeat(40)}`), /withheld/);
    assert.equal(dr.sanitizeSummary(`mail ${EMAIL}`), "mail [email]");
    assert.equal(dr.sanitizeSummary("x".repeat(9000)).length, dr.SUMMARY_MAX);
  });

  it("start reads --scenario-file into meta.json; scenario-file writes only mobile sections", async () => {
    const comments = [
      {
        id: 1,
        authorAssociation: "OWNER",
        createdAt: "t",
        body: [
          "## Test scenario",
          "### Web",
          "1. web step",
          "### iOS",
          "1. ios step",
          "### Android",
          "1. android step",
          `<!-- drafto-factory-scenario-sha:${SHA} -->`,
        ].join("\n"),
      },
    ];
    const file = path.join(tmp, "scen.json");
    const out = await main(["scenario-file", "--sha", SHA, "--out", file], {
      ...h.deps,
      readStdin: async () => JSON.stringify(comments),
    });
    assert.deepEqual(out, { written: true, sections: 2 });
    assert.equal(nodeFs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(
      readJson(file).map((s) => s.heading),
      ["iOS", "Android"],
    );
    const none = await main(["scenario-file", "--sha", OTHER_SHA, "--out", file], {
      ...h.deps,
      readStdin: async () => JSON.stringify(comments),
    });
    assert.deepEqual(none, { written: false, sections: 0 });
    assert.equal(existsSync(file), false);

    writeFileSync(file, JSON.stringify([{ heading: "iOS", text: "1. ios step" }, { nope: 1 }]));
    h.env.FACTORY_DEVICE_SCENARIO = "0";
    const r = await start({ scenarioFile: file });
    assert.equal(r.started, true);
    assert.equal(r.scenarioSections, 1);
    const meta = readJson(path.join(r.runDir, "meta.json"));
    assert.deepEqual(meta.scenario, { sections: [{ heading: "iOS", text: "1. ios step" }] });
    assert.equal(meta.knobs.scenario, false);
    assert.ok(!JSON.stringify(meta).includes(PASSWORD));
  });

  it("device-run refuses a path outside flows/ and waits on --wait", async () => {
    const dir = path.join(tmp, "sd");
    mkdirSync(path.join(dir, "requests"), { recursive: true });
    mkdirSync(path.join(dir, "flows"), { recursive: true });
    const opts = { fs: nodeFs, sleep: macrotask, nowMs: () => Date.now(), pollMs: 0 };
    for (const arg of ["../meta.json", "flows/x.yaml", "examples/02-create-notebook.yaml"]) {
      const r = await dr.deviceRunMain(["--dir", dir, "--timeout-sec", "5", "--", arg], opts);
      assert.equal(r.exitCode, 2, arg);
    }
    const missing = await dr.deviceRunMain(
      ["--dir", dir, "--timeout-sec", "5", "--", "flows/01-a.yaml"],
      opts,
    );
    assert.match(missing.text, /doesn't exist/);
    writeFileSync(path.join(dir, "requests", "4.json"), '{"flow":"flows/01-a.yaml"}');
    writeFileSync(
      path.join(dir, "requests", "4.result.json"),
      JSON.stringify({ flow: "flows/01-a.yaml", status: "FAIL", failure: "x", runsLeft: 2 }),
    );
    const waited = await dr.deviceRunMain(
      ["--dir", dir, "--timeout-sec", "5", "--", "--wait", "4"],
      opts,
    );
    assert.equal(waited.exitCode, 1);
    assert.match(waited.text, /request 4 \(flows\/01-a\.yaml\): FAIL\nfailure: x\nruns left: 2/);
  });
});
