// Unit tests for scripts/lib/device-lane.mjs — the factory's device lane
// (ADR-0099). Every exec (git, pnpm, gradle, xcodebuild, emulator, adb,
// simctl, maestro, gh) goes through injected fakes, so nothing here touches a
// device or builds anything. The ledger, run dirs, locks and build roots are
// real files in a temp dir.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
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
  runHousekeeping,
  runStart,
  runStop,
  runSupervise,
  saveLedger,
  takePidLock,
} from "../lib/device-lane.mjs";

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
    kill: (pid, signal) => {
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
      return ok();
    },
    cardColumn: async () => state.column,
    expoFingerprint: async () => state.expoHash,
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
    const prodApi = JSON.stringify({
      extra: { supabaseUrl: DEV_REF, apiUrl: "https://drafto.eu" },
    });
    assert.equal(
      judgeArtifact({ readOk: true, prodFound: false, configText: prodApi }).problem,
      "api-url",
    );
    const noApi = JSON.stringify({ extra: { supabaseUrl: DEV_REF } });
    assert.equal(
      judgeArtifact({ readOk: true, prodFound: false, configText: noApi }).problem,
      "api-url",
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
    assert.equal(maestro.length, 2);
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
    assert.equal(classifyDeviceRun({ exit, output }).state, "retry:beta-build");
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
    const ledger = await loadLedger(ledgerPath(h.repoRoot));
    assert.equal(ledger.inFlight, null);
    assert.equal(attemptsFor(ledger, "874", SHA), 0);
    assert.equal(ledger.last["874"].state, "stopped:head-moved");
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
    assert.equal(out.state, "stopped");
    assert.equal(out.refund, "attempt");
    assert.ok(existsSync(path.join(r.runDir, STOP_REQUEST_FILE)));
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

  function runFlowTargets(file) {
    const text = readFileSync(file, "utf8");
    const targets = [];
    for (const m of text.matchAll(/^\s*-?\s*runFlow:\s*([^\s#]+\.ya?ml)\s*$/gm)) targets.push(m[1]);
    for (const m of text.matchAll(/^\s*file:\s*([^\s#]+\.ya?ml)\s*$/gm)) targets.push(m[1]);
    return targets.map((t) => path.resolve(path.dirname(file), t));
  }

  function closure(start) {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const f = queue.shift();
      if (seen.has(f) || !existsSync(f)) continue;
      seen.add(f);
      queue.push(...runFlowTargets(f));
    }
    return [...seen];
  }

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

  it("render prints a table from device-output.json", async () => {
    const { runDir } = await startAndSupervise();
    const out = await main(["render", "--run-dir", runDir], h.deps);
    assert.match(out.text, /\| ios \| done \| PASS \|/);
    assert.match(out.text, /PASS `ios-all.yaml`/);
    assert.equal(renderOutput(null), "No device-output.json in this run dir.\n");
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
