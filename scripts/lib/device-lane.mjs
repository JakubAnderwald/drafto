#!/usr/bin/env node
// The factory's device lane — the runtime (ADR-0099). No factory wiring yet.
//
// A node supervisor builds a DEV-backed mobile app from a PR head, boots a
// headless Android emulator or an iOS simulator, runs the repo's Maestro flows
// on it, captures a screenshot after each flow and writes the results to
// <runDir>/device-output.json. No claude session ever touches a device.
//
//   - Dev only. The build root gets apps/mobile/.env (checked for the dev
//     Supabase ref, refused with the prod one) and nothing else: every other
//     apps/mobile/.env* is deleted. The build exports EXPO_PUBLIC_API_URL=
//     https://device-lane.invalid, because the app falls back to drafto.eu
//     when it is unset. Before anything installs, the artifact is checked: the
//     dev ref is in the built app config, the prod ref is nowhere in the
//     artifact, and the built config's apiUrl is the .invalid one. A build
//     that fails that is never installed (`unavailable:artifact-not-dev`).
//   - Android is signed with a factory debug keystore on the build volume, both
//     through AGP's injected signing properties and through the signing
//     plugin's own ANDROID_KEYSTORE_* variables. Nothing reads ~/drafto-secrets.
//   - Its own persistent build roots (<volume>/drafto-device-{android,ios}),
//     its own pid lock (<volume>/drafto-device.lock), and one run at a time
//     (a ledger with a single in-flight slot). It defers while a beta build
//     holds its lock, under memory pressure, and when the disk is short. A beta
//     lock or critical memory pressure appearing mid-run stops it, and the
//     attempt is refunded.
//   - Devices: emulator `drafto-factory` on port 5580 (never the operator's
//     emulator-5554) and the simulator whose UDID is in
//     logs/factory/device-config.json, driven by simctl alone. Platforms run
//     one after the other, never both at once, and every exit path shuts the
//     device down. Housekeeping reaps a dead supervisor's devices by the fixed
//     port and UDID.
//   - The dev E2E account's password reaches Maestro only through the
//     MAESTRO_E2E_TEST_PASSWORD environment variable: never argv, never a log.
//
// Like verify-lane.mjs, `start` (in a tick) reserves the slot, prepares the
// build worktrees and spawns `_supervise` detached under `nice -n 10`;
// `housekeeping` collects the run on a later tick. The supervisor writes only
// its run dir; the ledger is written in-tick.
//
// Subcommands (each prints one JSON line, except `render` and `selftest`,
// which print text):
//   start --issue N --pr P --sha S [--platforms ios,android] [--mode smoke]
//         [--trigger testing|on-demand] [--force-attempt] [--repo-root R]
//         [--run-root D] [--dry-run 1] [--now ISO]
//       → {started: true, runId, runDir, platforms, attempt, deadlineAt} or
//         {started: false, reason}: deferred:busy, deferred:beta-build,
//         deferred:memory, deferred:disk, attempts, head-moved, pr-unreadable,
//         not-applicable, account, <bin>-missing, dry-run, start-failed.
//   status                    → the ledger and the in-flight run's progress.
//   stop --issue N [--reason R]
//   housekeeping              → collects a finished run, stops one whose PR
//                               moved or closed or whose card left Testing /
//                               In Test, reaps dead runs' devices and old dirs.
//   selftest [--platform android|ios] [--build]
//   render --run-dir D        → device-output.json as Markdown.
//   _supervise --run-dir D    (internal)

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ghTimeoutMs } from "./gh-timeout.mjs";
import { freeDiskGb, memoryPressure } from "./host-resources.mjs";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";
import {
  deriveDevicePlan,
  E2E_DIR,
  flowName,
  flowNeedsSignIn,
  parseFlowTags,
  PLATFORMS,
  smokeFlow,
} from "./device-plan.mjs";
import { scanLaneText } from "./verify-report.mjs";
import {
  REPO,
  addMinutes,
  appendLog,
  expandTilde,
  findBin,
  isoSeconds,
  laneEnv,
  makeRunId,
  mutateState,
  nonNegativeInt,
  parseEnvFile,
  parseJson,
  pollRun,
  positiveInt,
  readText,
  realIsExecutable,
  realIsPidAlive,
  realSpawnDetached,
  resolveBins,
  rmQuiet,
  runCommand,
  runStep,
  supervisedEnv,
  supervisorPids,
  writeJsonAtomic,
} from "./verify-lane.mjs";

export const DEV_REF = "huhzactreblzcogqkbsd";
export const PROD_REF = "tbmjbxxseonkciqovnpl";
export const INVALID_API_URL = "https://device-lane.invalid";
export const APP_ID = "eu.drafto.mobile";
export const AVD_NAME = "drafto-factory";
export const EMULATOR_PORT = 5580;
export const EMULATOR_SERIAL = `emulator-${EMULATOR_PORT}`;
export const OUTPUT_FILE = "device-output.json";
export const SHOTS_FILE = "shots.json";
export const STOP_REQUEST_FILE = "stop-request.json";
export const PGIDS_FILE = "pgids.json";
export const SELFTEST_FLOW = `${E2E_DIR}/09-password-visibility.yaml`;
// The factory debug keystore's fixed, well-known values (Android's own debug
// keystore defaults). Not secrets: the APK only ever goes to the lane's emulator.
export const DEBUG_KEYSTORE = Object.freeze({
  storePassword: "android",
  keyAlias: "androiddebugkey",
  keyPassword: "android",
});
export const MODES = Object.freeze(["smoke"]);
export const TRIGGERS = Object.freeze(["testing", "on-demand"]);
export const MAX_JUNIT_LINES = 200;

const THIS_FILE = fileURLToPath(import.meta.url);
const SHA40 = /^[0-9a-f]{40}$/;
// A run dir: <issue>-<sha12>-<stamp>, or selftest-<platform>-<stamp>.
const RUN_ID_RE = /^(?:\d+-[0-9a-f]{12}|selftest-(?:android|ios))-\d{8}T\d{6}Z$/;
const MINUTE_MS = 60_000;
const RUN_DIR_RETENTION_MS = 30 * 24 * 60 * MINUTE_MS;
const POLL_MS = 30_000;
const KILL_GRACE_MS = 10_000;
const QUICK_MS = 30_000;
const GIT_MS = 5 * MINUTE_MS;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const FAILURE_MAX = 300;
// A run stopped for one of these wasn't the card's doing: the attempt is given back.
const REFUNDED_STOPS = new Set(["head-moved", "pr-closed", "stop", "beta-build", "memory"]);
const RETRY_STOPS = new Set(["beta-build", "memory"]);
const BOOLEAN_FLAGS = new Set(["force-attempt", "build", "json"]);

// ── knobs and paths ─────────────────────────────────────────────────────────

/** Read once per command; a garbage value falls back to the default. */
export function readDeviceKnobs(env = process.env) {
  const home = env.HOME || os.homedir();
  const volume =
    env.FACTORY_DEVICE_VOLUME || env.DRAFTO_BUILDS_VOLUME_DIR || "/Volumes/DraftoFactory";
  const dataDir = path.join(volume, "drafto-device");
  return {
    volume,
    dataDir,
    buildTimeoutMin: positiveInt(env.FACTORY_DEVICE_BUILD_TIMEOUT_MIN, 45),
    flowTimeoutMin: positiveInt(env.FACTORY_DEVICE_FLOW_TIMEOUT_MIN, 20),
    runMaxMin: positiveInt(env.FACTORY_DEVICE_RUN_MAX_MIN, 150),
    bootTimeoutMin: positiveInt(env.FACTORY_DEVICE_BOOT_TIMEOUT_MIN, 10),
    maxAttempts: positiveInt(env.FACTORY_DEVICE_MAX_ATTEMPTS, 2),
    minFreeGb: nonNegativeInt(env.FACTORY_DEVICE_MIN_FREE_GB, 25),
    rootMinFreeGb: nonNegativeInt(env.FACTORY_MIN_FREE_DISK_GB, 3) + 5,
    installTimeoutSec: positiveInt(env.FACTORY_INSTALL_TIMEOUT_SEC, 600),
    javaHome: env.FACTORY_DEVICE_JAVA_HOME ? expandTilde(env.FACTORY_DEVICE_JAVA_HOME, home) : null,
    androidSdk: expandTilde(
      env.FACTORY_ANDROID_SDK || path.join(home, "Library", "Android", "sdk"),
      home,
    ),
    avdHome: expandTilde(env.ANDROID_AVD_HOME || path.join(dataDir, "avd"), home),
    keystore: expandTilde(
      env.FACTORY_DEVICE_KEYSTORE || path.join(dataDir, "debug.keystore"),
      home,
    ),
    gradleHome: path.join(dataDir, "gradle"),
    accountFile: env.FACTORY_DEVICE_ACCOUNT_FILE
      ? expandTilde(env.FACTORY_DEVICE_ACCOUNT_FILE, home)
      : null,
    keepRaw: env.FACTORY_DEVICE_KEEP_RAW === "1",
  };
}

export function deviceRootFor(knobs, platform) {
  return path.join(knobs.volume, `drafto-device-${platform}`);
}

export function deviceLockPath(knobs) {
  return path.join(knobs.volume, "drafto-device.lock");
}

export function ledgerPath(repoRoot) {
  return path.join(repoRoot, "logs", "factory", "device", "ledger.json");
}

export function defaultRunRoot(repoRoot) {
  return path.join(repoRoot, "logs", "factory", "device", "runs");
}

export function deviceConfigPath(repoRoot) {
  return path.join(repoRoot, "logs", "factory", "device-config.json");
}

/**
 * Every place a beta build-root lock can be (beta-build-root.sh): the knobs'
 * roots, and the default roots both on the build volume and beside the
 * checkouts in ~/code, where they fall back when the volume isn't mounted.
 */
export function betaLockPaths(env = process.env) {
  const home = env.HOME || os.homedir();
  const volume = env.DRAFTO_BUILDS_VOLUME_DIR || "/Volumes/DraftoFactory";
  const roots = [
    env.DRAFTO_BETA_MOBILE_ROOT,
    env.DRAFTO_DESKTOP_BUILD_ROOT,
    ...[volume, path.join(home, "code")].flatMap((parent) => [
      path.join(parent, "drafto-beta-mobile"),
      path.join(parent, "drafto-beta-desktop"),
    ]),
  ].filter(Boolean);
  return [...new Set(roots.map((r) => `${r}.lock`))];
}

function volumeMounted(fs, volume) {
  try {
    if (!fs.statSync(volume).isDirectory()) return false;
    fs.accessSync(volume, nodeFs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ── pid locks (beta-build-root.sh's _beta_root_lock, in node) ──────────────

export function readLockPid(fs, lock) {
  const text = readText(fs, lock).replace(/[^0-9]/g, "");
  const pid = Number(text);
  return text && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** {pid, alive}: who holds <lock>, if anyone. */
export function lockHolder(lock, deps) {
  const pid = readLockPid(deps.fs, lock);
  return { pid, alive: pid !== null && deps.isPidAlive(pid) };
}

// Delete <lock> only while it still holds <seen>, serialised by a mkdir guard
// so two reapers of one dead pid can't delete a lock taken in between.
function reapLock(fs, lock, seen) {
  const guard = `${lock}.reap`;
  try {
    if (Date.now() - fs.statSync(guard).mtimeMs > MINUTE_MS) fs.rmdirSync(guard);
  } catch {
    /* no stale guard */
  }
  try {
    fs.mkdirSync(guard);
  } catch {
    return false;
  }
  try {
    if (readLockPid(fs, lock) === seen) fs.rmSync(lock, { force: true });
    return true;
  } finally {
    try {
      fs.rmdirSync(guard);
    } catch {
      /* gone */
    }
  }
}

/**
 * Take <lock> for <pid>: atomic (the pid is written to a temp file, then
 * hard-linked into place). Re-entrant for the same pid; a live foreign holder
 * refuses; a dead one is reaped and the take retried.
 */
export function takePidLock(lock, pid, deps) {
  const fs = deps.fs;
  const tmp = `${lock}.${pid}.tmp`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(tmp, `${pid}\n`, { mode: 0o600 });
  try {
    for (let i = 0; i < 3; i++) {
      try {
        fs.linkSync(tmp, lock);
        return { ok: true };
      } catch {
        /* exists */
      }
      const holder = lockHolder(lock, deps);
      if (holder.pid === pid) return { ok: true };
      if (holder.alive) return { ok: false, holder: holder.pid };
      reapLock(fs, lock, holder.pid);
    }
    return { ok: false, holder: readLockPid(fs, lock) };
  } finally {
    rmQuiet(fs, tmp);
  }
}

/** Hand <lock> from <fromPid> to <toPid> (claim_beta_build_root). */
export function handOverPidLock(lock, fromPid, toPid, deps) {
  if (readLockPid(deps.fs, lock) !== fromPid) return false;
  writeTextAtomic(deps.fs, lock, `${toPid}\n`);
  return true;
}

/** Drop <lock> when it holds <pid>, or a pid that is gone. Never a live foreign one. */
export function releasePidLock(lock, pid, deps) {
  const holder = lockHolder(lock, deps);
  if (holder.pid === null && !deps.fs.existsSync(lock)) return false;
  if (holder.pid === pid || !holder.alive) return reapLock(deps.fs, lock, holder.pid);
  return false;
}

function writeTextAtomic(fs, file, text) {
  const tmp = `${file}.${process.pid}.w.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The first beta build lock a live process holds, or null. */
export function betaBuildBusy(lockPaths, deps) {
  for (const lock of lockPaths) {
    const holder = lockHolder(lock, deps);
    if (holder.alive) return { lock, pid: holder.pid };
  }
  return null;
}

// ── ledger ──────────────────────────────────────────────────────────────────

export function emptyLedger() {
  return { version: 1, inFlight: null, attempts: {}, last: {} };
}

export async function loadLedger(file) {
  const parsed = parseJson(readText(nodeFs, file), null);
  if (!parsed || typeof parsed !== "object") return emptyLedger();
  return { ...emptyLedger(), ...parsed };
}

export async function saveLedger(ledger, file) {
  nodeFs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(nodeFs, file, ledger);
}

// mutateState (verify-lane.mjs) over the ledger: reload → mutate → save.
const LEDGER_STORE = Object.freeze({ loadFactoryState: loadLedger, saveFactoryState: saveLedger });

export function attemptsFor(ledger, issue, sha) {
  const n = ledger.attempts?.[String(issue)]?.[sha];
  return Number.isInteger(n) ? n : 0;
}

function bumpAttempts(ledger, issue, sha, delta) {
  const key = String(issue);
  ledger.attempts[key] ??= {};
  const next = Math.max(0, attemptsFor(ledger, issue, sha) + delta);
  ledger.attempts[key][sha] = next;
  return next;
}

async function finishLedgerRun(file, runId, { refund, last }) {
  const out = await mutateState(LEDGER_STORE, file, (l) => {
    const f = l.inFlight;
    if (!f || f.runId !== runId) return false;
    if (refund === "attempt") bumpAttempts(l, f.issue, f.sha, -1);
    if (last) l.last[String(f.issue)] = last;
    l.inFlight = null;
    return true;
  });
  return out === true;
}

// ── account and env checks ──────────────────────────────────────────────────

/** Why the device account file can't be used, or null. Never returns a value. */
export function deviceAccountProblem(file, fs = nodeFs) {
  if (!file) return "missing";
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return "missing";
  }
  if (!st.isFile()) return "not-a-file";
  if ((st.mode & 0o077) !== 0) return "mode";
  const values = parseEnvFile(readText(fs, file));
  if (!values.E2E_TEST_EMAIL) return "no-email";
  if (!values.E2E_TEST_PASSWORD) return "no-password";
  return null;
}

export function readDeviceAccount(file, fs = nodeFs) {
  if (deviceAccountProblem(file, fs)) return null;
  const values = parseEnvFile(readText(fs, file));
  return { email: values.E2E_TEST_EMAIL, password: values.E2E_TEST_PASSWORD };
}

/** Why <text> (apps/mobile/.env) is not a dev-only env file, or null. */
export function devEnvProblem(text) {
  const s = String(text ?? "");
  if (!s.trim()) return "missing";
  if (s.includes(PROD_REF)) return "prod-ref";
  if (!s.includes(DEV_REF)) return "no-dev-ref";
  if (!String(parseEnvFile(s).EXPO_PUBLIC_SUPABASE_URL ?? "").includes(DEV_REF)) {
    return "supabase-url-not-dev";
  }
  return null;
}

/**
 * The EXPO_PUBLIC_* values a build gets: the dev .env's, with the API URL
 * pinned to a host that can't resolve and the E2E probes on. Throws when any
 * value names the prod project.
 */
export function buildExpoValues(dotenvText) {
  const values = {};
  for (const [k, v] of Object.entries(parseEnvFile(dotenvText))) {
    if (k.startsWith("EXPO_PUBLIC_")) values[k] = v;
  }
  values.EXPO_PUBLIC_API_URL = INVALID_API_URL;
  values.EXPO_PUBLIC_E2E_PROBES = "1";
  for (const v of Object.values(values)) {
    if (String(v).includes(PROD_REF)) throw new Error("build env names the prod project");
  }
  return values;
}

// ── binaries ────────────────────────────────────────────────────────────────

export function resolveDeviceBins({ env = process.env, isExecutable, knobs }) {
  const home = env.HOME || os.homedir();
  const base = resolveBins({ env, isExecutable });
  const exact = (p) => (p && isExecutable(p) ? p : null);
  return {
    node: base.node,
    pnpm: base.pnpm,
    nice: base.nice,
    git: findBin("git", { env, isExecutable, extra: ["/usr/bin/git"] }),
    maestro: findBin("maestro", {
      env,
      isExecutable,
      extra: [path.join(home, ".maestro", "bin", "maestro")],
      override: env.FACTORY_MAESTRO_BIN || null,
    }),
    adb:
      exact(path.join(knobs.androidSdk, "platform-tools", "adb")) ??
      findBin("adb", { env, isExecutable }),
    // Never on PATH on the Mac mini: the SDK's own copy.
    emulator: exact(path.join(knobs.androidSdk, "emulator", "emulator")),
    java: knobs.javaHome ? exact(path.join(knobs.javaHome, "bin", "java")) : null,
    xcrun: exact("/usr/bin/xcrun"),
    unzip: exact("/usr/bin/unzip") ?? findBin("unzip", { env, isExecutable }),
    pod: findBin("pod", {
      env,
      isExecutable,
      extra: [
        path.join(home, ".rbenv", "shims", "pod"),
        "/opt/homebrew/bin/pod",
        "/usr/local/bin/pod",
      ],
    }),
  };
}

// Maestro runs on a JVM, so java is needed on iOS too (and gradle on Android).
/**
 * <knobs> with javaHome filled in: FACTORY_DEVICE_JAVA_HOME when set, else
 * what macOS's /usr/libexec/java_home finds for 17 or newer. Unchanged
 * (javaHome null) when neither gives one; the java bin check then refuses.
 */
export async function withJavaHome(knobs, deps) {
  if (knobs.javaHome || !deps.exec) return knobs;
  const r = await deps.exec("/usr/libexec/java_home", ["-v", "17+"], { timeoutMs: QUICK_MS });
  const home = r.code === 0 ? String(r.stdout ?? "").trim() : "";
  return path.isAbsolute(home) ? { ...knobs, javaHome: home } : knobs;
}

export const COMMON_BINS = Object.freeze(["node", "pnpm", "nice", "git", "maestro", "java"]);
export const PLATFORM_BINS = Object.freeze({
  android: Object.freeze(["adb", "emulator", "unzip"]),
  ios: Object.freeze(["xcrun", "pod"]),
});

export function missingBins(bins, platforms) {
  const need = [...COMMON_BINS, ...platforms.flatMap((p) => PLATFORM_BINS[p] ?? [])];
  return need.filter((name) => !bins[name]);
}

// ── environments ────────────────────────────────────────────────────────────

function dirOf(p) {
  return p ? path.dirname(p) : null;
}

/** adb, the emulator, simctl and Maestro. */
export function deviceEnv(env, { bins, knobs }) {
  const extra = {
    ANDROID_HOME: knobs.androidSdk,
    ANDROID_SDK_ROOT: knobs.androidSdk,
    ANDROID_AVD_HOME: knobs.avdHome,
    MAESTRO_CLI_NO_ANALYTICS: "1",
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
  };
  if (knobs.javaHome) extra.JAVA_HOME = knobs.javaHome;
  return laneEnv(env, {
    binDirs: [
      knobs.javaHome ? path.join(knobs.javaHome, "bin") : null,
      dirOf(bins.adb),
      dirOf(bins.maestro),
      dirOf(bins.node),
    ],
    extra,
  });
}

/** buildEnv without NODE_ENV, for `pnpm install`. */
export function installEnv(env) {
  const out = { ...env };
  delete out.NODE_ENV;
  return out;
}

/** expo prebuild, gradle / pod / xcodebuild (and, without NODE_ENV, pnpm install). */
export function buildEnv(env, { bins, knobs, platform, expoValues }) {
  const extra = {
    ...expoValues,
    CI: "1",
    NODE_ENV: "production",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  };
  if (platform === "android") {
    Object.assign(extra, {
      ANDROID_HOME: knobs.androidSdk,
      ANDROID_SDK_ROOT: knobs.androidSdk,
      GRADLE_USER_HOME: knobs.gradleHome,
      _JAVA_OPTIONS: "--enable-native-access=ALL-UNNAMED",
      // with-android-signing.js reads these; set, its release config points at
      // the factory keystore, never the ~/drafto-secrets default.
      ANDROID_KEYSTORE_PATH: knobs.keystore,
      ANDROID_KEYSTORE_PASSWORD: DEBUG_KEYSTORE.storePassword,
      ANDROID_KEY_ALIAS: DEBUG_KEYSTORE.keyAlias,
      ANDROID_KEY_PASSWORD: DEBUG_KEYSTORE.keyPassword,
    });
    if (knobs.javaHome) extra.JAVA_HOME = knobs.javaHome;
  }
  return laneEnv(env, {
    binDirs: [
      platform === "android" && knobs.javaHome ? path.join(knobs.javaHome, "bin") : null,
      dirOf(bins.node),
      dirOf(bins.pnpm),
      platform === "ios" ? dirOf(bins.pod) : null,
    ],
    extra,
  });
}

// ── run context ─────────────────────────────────────────────────────────────

class Interrupt extends Error {
  constructor(state) {
    super(`interrupted: ${state}`);
    this.state = state;
  }
}

class PlatformError extends Error {
  constructor(state, detail = "") {
    super(detail ? `${state}: ${detail}` : state);
    this.state = state;
  }
}

/** A short command whose stdout is wanted; stderr goes to the log. Never throws. */
async function quick(ctx, cmd, args, { timeoutMs = QUICK_MS, env, cwd } = {}) {
  return ctx.deps.run(cmd, args, {
    cwd: cwd ?? ctx.cwd,
    env: env ?? ctx.devEnv,
    timeoutMs,
    capture: true,
    stderrFile: ctx.stepLog ?? null,
  });
}

/**
 * SIGTERM <child>'s process group, then SIGKILL it once <graceMs> has gone by
 * if the leader is still alive (a gradle or xcodebuild that ignores SIGTERM).
 */
export function killGroup(deps, child, graceMs = KILL_GRACE_MS) {
  if (!child?.pid) return;
  const pid = child.pid;
  if (!deps.kill(-pid, "SIGTERM")) deps.kill(pid, "SIGTERM");
  const timer = setTimeout(() => {
    if (deps.isPidAlive(pid) && !deps.kill(-pid, "SIGKILL")) deps.kill(pid, "SIGKILL");
  }, graceMs);
  timer.unref?.();
}

// ── process groups on record ────────────────────────────────────────────────
// The long steps and the emulator lead process groups of their own, so a
// signal to the supervisor's group doesn't reach them. Their pgids are kept in
// <runDir>/pgids.json, so housekeeping and stop can still kill them when the
// supervisor is gone or wedged. <match> must appear in the leader's command
// line before it is signalled (pid reuse).

export function readGroups(fs, runDir) {
  const parsed = runDir ? parseJson(readText(fs, path.join(runDir, PGIDS_FILE)), null) : null;
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function recordGroup(ctx, kind, pid, match) {
  if (!ctx.recordGroups) return;
  try {
    const groups = readGroups(ctx.deps.fs, ctx.runDir);
    if (Number.isInteger(pid) && pid > 1) groups[kind] = { pid, match };
    else delete groups[kind];
    writeJsonAtomic(ctx.deps.fs, path.join(ctx.runDir, PGIDS_FILE), groups);
  } catch {
    /* best effort: housekeeping also stops devices by port and UDID */
  }
}

/** Signal every recorded group whose leader is still the process recorded. */
export async function killRecordedGroups(runDir, signal, deps) {
  const killed = [];
  for (const entry of Object.values(readGroups(deps.fs, runDir))) {
    const pid = entry?.pid;
    if (!Number.isInteger(pid) || pid <= 1 || !deps.isPidAlive(pid)) continue;
    const command = await deps.psCommand(pid);
    if (!entry.match || !command.includes(entry.match)) continue;
    if (!deps.kill(-pid, signal)) deps.kill(pid, signal);
    killed.push(pid);
  }
  return killed;
}

/**
 * A long step (install, prebuild, build, a flow): the interrupt checks run
 * before it, every POLL_MS during it (stopping its process group) and after
 * it. Throws Interrupt; otherwise returns runStep's result.
 */
export async function guardedRun(ctx, cmd, args, opts) {
  await ctx.checkpoint();
  let hit = null;
  const timer = setInterval(async () => {
    if (hit) return;
    const why = await ctx.interruptReason();
    if (why) {
      hit = why;
      killGroup(ctx.deps, ctx.status.child);
    }
  }, ctx.pollMs ?? POLL_MS);
  timer.unref?.();
  let r;
  try {
    r = await ctx.deps.run(cmd, args, {
      group: true,
      ...opts,
      onChild: (c) => {
        ctx.status.child = c;
        recordGroup(ctx, "child", c?.pid, path.basename(cmd));
      },
    });
  } finally {
    clearInterval(timer);
    if (ctx.status.child) recordGroup(ctx, "child", null);
    ctx.status.child = null;
  }
  if (hit) throw new Interrupt(hit);
  await ctx.checkpoint();
  return r;
}

function makeChecks(ctx) {
  ctx.interruptReason = async () => {
    if (ctx.status.timedOut) return "failed:timeout";
    if (ctx.status.terminated) return `stopped:${ctx.status.stopReason ?? "signal"}`;
    if (betaBuildBusy(ctx.meta.paths.betaLocks ?? [], ctx.deps)) return "stopped:beta-build";
    if ((await ctx.deps.memoryPressure()) === 4) return "stopped:memory";
    return null;
  };
  ctx.checkpoint = async () => {
    const why = await ctx.interruptReason();
    if (why) throw new Interrupt(why);
  };
  return ctx;
}

// ── build root ──────────────────────────────────────────────────────────────

/**
 * In-tick (start, selftest), after the commit was fetched into the factory
 * checkout: create each platform's persistent detached worktree if it is missing. Kept
 * out of the supervisor so it never writes the factory checkout's git dir
 * while a tick does.
 */
export async function ensureDeviceWorktrees({ repoRoot, sha, platforms, knobs }, deps) {
  const usable = async (root) => {
    const r = await deps.git(["rev-parse", "--is-inside-work-tree"], { cwd: root });
    return r.code === 0 && r.stdout.trim() === "true";
  };
  for (const p of platforms) {
    const root = deviceRootFor(knobs, p);
    if (deps.fs.existsSync(root)) {
      if (await usable(root)) continue;
      // Its registration is gone or broken (a prune while the volume was
      // away): repair it, and failing that start the root over.
      await deps.git(["worktree", "repair", root], { cwd: repoRoot });
      if (await usable(root)) continue;
      rmQuiet(deps.fs, root);
    }
    // Never `git worktree prune` here: it would also drop the registrations
    // of worktrees on a build volume that isn't mounted right now
    // (nightly-support.sh). --force adds over a missing-but-registered path.
    const r = await deps.git(["worktree", "add", "--force", "--detach", root, sha], {
      cwd: repoRoot,
    });
    if (r.code !== 0) throw new Error(`worktree add ${root} failed`);
  }
}

const ENV_FILE_RE = /^\.env(\..*)?$/;

/**
 * The supervisor's half: check the root out at <sha>, clean it (keeping the
 * native projects, node_modules, the derived data and the fingerprints),
 * install, and give it the dev .env and no other env file.
 * Returns {root, expoValues}. Throws PlatformError.
 */
export async function prepareDeviceRoot(ctx, platform, sha) {
  const { deps, meta } = ctx;
  const fs = deps.fs;
  const root = deviceRootFor(meta.knobs, platform);
  if (!fs.existsSync(root)) throw new PlatformError("failed:prepare", "no build root");
  const git = (args) =>
    quick(ctx, meta.bins.git, ["-C", root, ...args], { timeoutMs: GIT_MS, env: ctx.devEnv });
  if ((await git(["checkout", "--detach", "--force", sha])).code !== 0) {
    throw new PlatformError("failed:prepare", "checkout");
  }
  const head = await git(["rev-parse", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== sha) {
    throw new PlatformError("failed:prepare", "HEAD is not the commit");
  }
  const clean = await git([
    "clean",
    "-ffdx",
    "-e",
    "apps/mobile/android",
    "-e",
    "apps/mobile/ios",
    "-e",
    "node_modules",
    "-e",
    ".derived",
    "-e",
    ".device-native-*",
  ]);
  if (clean.code !== 0) throw new PlatformError("failed:prepare", "clean");

  // The dev .env first: a refusal costs no install.
  const source = meta.paths.envSource;
  const dotenv = readText(fs, source);
  const problem = devEnvProblem(dotenv);
  if (problem) throw new PlatformError("unavailable:env-not-dev", problem);
  const mobile = path.join(root, "apps", "mobile");
  for (const name of fs.readdirSync(mobile)) {
    if (ENV_FILE_RE.test(name) && name !== ".env") rmQuiet(fs, path.join(mobile, name));
  }
  fs.writeFileSync(path.join(mobile, ".env"), dotenv, { mode: 0o600 });
  const left = fs.readdirSync(mobile).filter((n) => ENV_FILE_RE.test(n) && n !== ".env");
  if (left.length) throw new PlatformError("unavailable:env-not-dev", "other env files remain");
  let expoValues;
  try {
    expoValues = buildExpoValues(dotenv);
  } catch (err) {
    throw new PlatformError("unavailable:env-not-dev", err.message);
  }

  // No NODE_ENV=production for the install: pnpm would skip devDependencies
  // the bundle step needs (babel plugins). Prebuild and the build keep it.
  const env = installEnv(
    buildEnv(deps.env, { bins: meta.bins, knobs: meta.knobs, platform, expoValues }),
  );
  const log = path.join(ctx.platDir, "install.log");
  const timeoutMs = meta.knobs.installTimeoutSec * 1000;
  let ok = false;
  for (const args of [
    [
      "install",
      "--frozen-lockfile",
      "--offline",
      "--prefer-offline",
      "--config.confirm-modules-purge=false",
    ],
    ["install", "--frozen-lockfile", "--config.confirm-modules-purge=false"],
  ]) {
    const r = await guardedRun(ctx, meta.bins.pnpm, args, {
      cwd: root,
      env,
      timeoutMs,
      stdoutFile: log,
      stderrFile: log,
    });
    if (r.code === 0) {
      ok = true;
      break;
    }
  }
  if (!ok) throw new PlatformError("failed:install-deps");
  return { root, expoValues };
}

// ── native projects ─────────────────────────────────────────────────────────

const FINGERPRINT_FILES = [
  "apps/mobile/app.config.ts",
  "apps/mobile/package.json",
  "pnpm-lock.yaml",
];
const FINGERPRINT_DIRS = ["apps/mobile/plugins", "patches"];

function listFiles(fs, dir) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...listFiles(fs, full));
    else if (d.isFile()) out.push(full);
  }
  return out;
}

/** sha256 over the files that shape the native projects. */
export function fileFingerprint(root, fs = nodeFs) {
  const h = createHash("sha256");
  const files = [
    ...FINGERPRINT_FILES.map((f) => path.join(root, f)),
    ...FINGERPRINT_DIRS.flatMap((d) => listFiles(fs, path.join(root, d))),
  ];
  for (const file of [...new Set(files)].sort()) {
    h.update(`${path.relative(root, file)}\0`);
    try {
      h.update(fs.readFileSync(file));
    } catch {
      h.update("<missing>");
    }
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * The native-input fingerprint of <root> for <platform>: @expo/fingerprint's
 * hash when it can be computed (deps.expoFingerprint), else fileFingerprint,
 * with the platform and the EXPO_PUBLIC_* values folded in (prebuild bakes
 * some of them into the native projects).
 */
export async function nativeFingerprint(ctx, root, platform, expoValues, env) {
  let source = "files";
  let base = null;
  try {
    base = ctx.deps.expoFingerprint ? await ctx.deps.expoFingerprint(root, platform, env) : null;
    if (base) source = "expo";
  } catch {
    base = null;
  }
  base ??= fileFingerprint(root, ctx.deps.fs);
  const envLines = Object.keys(expoValues)
    .sort()
    .map((k) => `${k}=${expoValues[k]}`);
  return createHash("sha256")
    .update(["device-native-v1", platform, source, base, ...envLines].join("\n"))
    .digest("hex");
}

/** Prebuild only when the fingerprint changed (or the native project is missing). */
export async function ensureNative(ctx, root, platform, expoValues, env) {
  const { deps, meta } = ctx;
  const fs = deps.fs;
  const mobile = path.join(root, "apps", "mobile");
  const nativeDir = path.join(mobile, platform);
  const fpFile = path.join(root, `.device-native-${platform}`);
  const fp = await nativeFingerprint(ctx, root, platform, expoValues, env);
  const fresh =
    fs.existsSync(nativeDir) &&
    readText(fs, fpFile).trim() === fp &&
    (platform !== "ios" || fs.existsSync(path.join(nativeDir, "Pods")));
  const timeoutMs = meta.knobs.buildTimeoutMin * MINUTE_MS;
  if (!fresh) {
    rmQuiet(fs, fpFile);
    const log = path.join(ctx.platDir, "prebuild.log");
    const r = await guardedRun(
      ctx,
      meta.bins.pnpm,
      ["exec", "expo", "prebuild", "--platform", platform, "--clean", "--no-install"],
      { cwd: mobile, env, timeoutMs, stdoutFile: log, stderrFile: log },
    );
    if (r.code !== 0)
      throw new PlatformError(r.timedOut ? "failed:prebuild-timeout" : "failed:prebuild");
    if (platform === "ios") {
      const pods = await guardedRun(ctx, meta.bins.pod, ["install"], {
        cwd: nativeDir,
        env,
        timeoutMs,
        stdoutFile: log,
        stderrFile: log,
      });
      if (pods.code !== 0) throw new PlatformError("failed:pods");
    }
  }
  if (platform === "android") {
    fs.writeFileSync(
      path.join(nativeDir, "local.properties"),
      `sdk.dir=${meta.knobs.androidSdk}\n`,
    );
  }
  if (!fresh) fs.writeFileSync(fpFile, `${fp}\n`);
  return { cached: fresh, fingerprint: fp };
}

// ── builds ──────────────────────────────────────────────────────────────────

export function androidApkPath(root) {
  return path.join(root, "apps/mobile/android/app/build/outputs/apk/release/app-release.apk");
}

export function iosAppPath(root) {
  return path.join(root, ".derived/Build/Products/Release-iphonesimulator/Drafto.app");
}

export function androidBuildArgs(knobs) {
  return [
    "assembleRelease",
    "-PreactNativeArchitectures=arm64-v8a",
    "--no-daemon",
    "-Pkotlin.compiler.execution.strategy=in-process",
    // AGP's injected signing wins over the build type's signingConfig.
    `-Pandroid.injected.signing.store.file=${knobs.keystore}`,
    `-Pandroid.injected.signing.store.password=${DEBUG_KEYSTORE.storePassword}`,
    `-Pandroid.injected.signing.key.alias=${DEBUG_KEYSTORE.keyAlias}`,
    `-Pandroid.injected.signing.key.password=${DEBUG_KEYSTORE.keyPassword}`,
  ];
}

export async function buildAndroid(ctx, root, env) {
  const { deps, meta } = ctx;
  const apk = androidApkPath(root);
  rmQuiet(deps.fs, apk);
  const log = path.join(ctx.platDir, "build.log");
  const r = await guardedRun(ctx, "./gradlew", androidBuildArgs(meta.knobs), {
    cwd: path.join(root, "apps", "mobile", "android"),
    env,
    timeoutMs: meta.knobs.buildTimeoutMin * MINUTE_MS,
    stdoutFile: log,
    stderrFile: log,
  });
  if (r.code !== 0) throw new PlatformError(r.timedOut ? "failed:build-timeout" : "failed:build");
  if (!deps.fs.existsSync(apk)) throw new PlatformError("failed:build", "no APK");
  return apk;
}

export function iosBuildArgs(root) {
  // generate-ios.sh's line: Release, simulator SDK, "Sign to Run Locally" (an
  // unsigned build has no keychain access, so SecureStore and auth fail).
  return [
    "-workspace",
    "ios/Drafto.xcworkspace",
    "-scheme",
    "Drafto",
    "-configuration",
    "Release",
    "-sdk",
    "iphonesimulator",
    "-destination",
    "generic/platform=iOS Simulator",
    "-derivedDataPath",
    path.join(root, ".derived"),
    "build",
    "-quiet",
    "CODE_SIGN_IDENTITY=-",
    "CODE_SIGN_STYLE=Manual",
    "DEVELOPMENT_TEAM=",
    "PROVISIONING_PROFILE_SPECIFIER=",
  ];
}

export async function buildIos(ctx, root, env) {
  const { deps, meta } = ctx;
  const app = iosAppPath(root);
  rmQuiet(deps.fs, app);
  const log = path.join(ctx.platDir, "build.log");
  const r = await guardedRun(ctx, "/usr/bin/xcodebuild", iosBuildArgs(root), {
    cwd: path.join(root, "apps", "mobile"),
    env,
    timeoutMs: meta.knobs.buildTimeoutMin * MINUTE_MS,
    stdoutFile: log,
    stderrFile: log,
  });
  if (r.code !== 0) throw new PlatformError(r.timedOut ? "failed:build-timeout" : "failed:build");
  if (!deps.fs.existsSync(app)) throw new PlatformError("failed:build", "no .app");
  return app;
}

// ── artifact check ──────────────────────────────────────────────────────────

/**
 * Pure: whether a built artifact is dev-only. <configText> is its expo-constants
 * app.config (null when absent), <prodFound> whether the prod ref appears
 * anywhere in the artifact, <readOk> whether all of it could be read.
 */
export function judgeArtifact({ readOk, prodFound, configText }) {
  if (!readOk) return { ok: false, problem: "unreadable" };
  if (prodFound) return { ok: false, problem: "prod-ref" };
  if (typeof configText !== "string" || configText === "")
    return { ok: false, problem: "no-app-config" };
  if (!configText.includes(DEV_REF)) return { ok: false, problem: "no-dev-ref" };
  const config = parseJson(configText, null);
  if (!config) return { ok: false, problem: "app-config-unparsable" };
  if (config?.extra?.apiUrl !== INVALID_API_URL) return { ok: false, problem: "api-url" };
  return { ok: true, problem: null };
}

function bufferHas(buf, text) {
  return buf.indexOf(Buffer.from(text, "utf8")) !== -1;
}

export async function checkArtifact(ctx, platform, artifact) {
  const { deps, meta } = ctx;
  const fs = deps.fs;
  if (platform === "android") {
    const tmp = path.join(ctx.rawDir, "apk-contents.bin");
    rmQuiet(fs, tmp);
    // To a file first: Info-ZIP exits 1 after skipping an entry, which the
    // prod scan would then never see, so only exit 0 is a complete read.
    const all = await deps.run(meta.bins.unzip, ["-p", artifact], {
      cwd: ctx.cwd,
      env: ctx.devEnv,
      timeoutMs: 5 * MINUTE_MS,
      stdoutFile: tmp,
      stderrFile: ctx.stepLog,
    });
    let prodFound = false;
    let readOk = all.code === 0;
    try {
      prodFound = bufferHas(fs.readFileSync(tmp), PROD_REF);
    } catch {
      readOk = false;
    }
    rmQuiet(fs, tmp);
    const cfg = await deps.run(meta.bins.unzip, ["-p", artifact, "assets/app.config"], {
      cwd: ctx.cwd,
      env: ctx.devEnv,
      timeoutMs: QUICK_MS,
      capture: true,
      stderrFile: ctx.stepLog,
    });
    return judgeArtifact({
      readOk,
      prodFound,
      configText: cfg.code === 0 ? cfg.stdout : null,
    });
  }
  let readOk = true;
  let prodFound = false;
  let configText = null;
  const files = listFiles(fs, artifact);
  if (files.length === 0) readOk = false;
  for (const file of files) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      readOk = false;
      continue;
    }
    if (bufferHas(buf, PROD_REF)) prodFound = true;
    if (file.endsWith(`${path.sep}EXConstants.bundle${path.sep}app.config`)) {
      configText = buf.toString("utf8");
    }
  }
  return judgeArtifact({ readOk, prodFound, configText });
}

// ── devices ─────────────────────────────────────────────────────────────────

export function emulatorArgs() {
  return [
    "-avd",
    AVD_NAME,
    "-port",
    String(EMULATOR_PORT),
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-gpu",
    "swiftshader_indirect",
    "-no-snapshot-save",
    "-snapshot",
    "clean",
    "-memory",
    "2048",
  ];
}

export function avdExists(knobs, fs = nodeFs) {
  return (
    fs.existsSync(path.join(knobs.avdHome, `${AVD_NAME}.avd`)) &&
    fs.existsSync(path.join(knobs.avdHome, `${AVD_NAME}.ini`))
  );
}

async function emulatorRunning(ctx) {
  const r = await quick(ctx, ctx.bins.adb, ["-s", EMULATOR_SERIAL, "get-state"], {
    timeoutMs: 10_000,
  });
  return r.code === 0 && r.stdout.trim() === "device";
}

/**
 * Boot the lane's AVD on port 5580 in a process group of its own and wait for
 * sys.boot_completed. Returns the emulator's pid. Throws PlatformError /
 * Interrupt (a stop while it boots).
 */
export async function bootEmulator(ctx) {
  const { deps, bins, knobs } = ctx;
  if (await emulatorRunning(ctx)) await stopEmulator(ctx, null);
  const spawned = await deps.spawnDetached(bins.emulator, emulatorArgs(), {
    cwd: ctx.cwd,
    logPath: path.join(ctx.platDir ?? ctx.cwd, "emulator.log"),
    env: ctx.devEnv,
  });
  if (!spawned.ok) throw new PlatformError("failed:boot", spawned.reason);
  ctx.devices.emulatorPid = spawned.pid;
  recordGroup(ctx, "emulator", spawned.pid, AVD_NAME);
  const deadline = deps.nowMs() + knobs.bootTimeoutMin * MINUTE_MS;
  for (;;) {
    await ctx.checkpoint();
    if (!deps.isPidAlive(spawned.pid)) throw new PlatformError("failed:boot", "emulator exited");
    const r = await quick(
      ctx,
      bins.adb,
      ["-s", EMULATOR_SERIAL, "shell", "getprop", "sys.boot_completed"],
      {
        timeoutMs: 15_000,
      },
    );
    if (r.code === 0 && r.stdout.trim() === "1") break;
    if (deps.nowMs() > deadline) throw new PlatformError("failed:boot-timeout");
    await deps.sleep(5_000);
  }
  for (const key of [
    "window_animation_scale",
    "transition_animation_scale",
    "animator_duration_scale",
  ]) {
    await quick(ctx, bins.adb, [
      "-s",
      EMULATOR_SERIAL,
      "shell",
      "settings",
      "put",
      "global",
      key,
      "0",
    ]);
  }
  return spawned.pid;
}

/**
 * Stop the lane's emulator: `adb emu kill`, then its process group. With no
 * pid (housekeeping after a dead supervisor) the emulator processes are found
 * by their `-port 5580`. Never touches another emulator. Never throws.
 */
export async function stopEmulator(ctx, pid) {
  const { deps, bins } = ctx;
  try {
    if (bins.adb)
      await quick(ctx, bins.adb, ["-s", EMULATOR_SERIAL, "emu", "kill"], { timeoutMs: 20_000 });
    let pids = Number.isInteger(pid) ? [pid] : [];
    if (pids.length === 0) {
      const procs = (await deps.listProcesses()) ?? [];
      pids = procs
        .filter(
          (p) =>
            /emulator|qemu-system/.test(p.command) &&
            new RegExp(`-port\\s+${EMULATOR_PORT}(\\s|$)`).test(p.command),
        )
        .map((p) => p.pid);
    }
    for (const p of pids) {
      for (let i = 0; i < 15 && deps.isPidAlive(p); i++) await deps.sleep(1_000);
      if (deps.isPidAlive(p)) {
        if (!deps.kill(-p, "SIGTERM")) deps.kill(p, "SIGTERM");
        await deps.sleep(5_000);
        if (deps.isPidAlive(p) && !deps.kill(-p, "SIGKILL")) deps.kill(p, "SIGKILL");
      }
    }
    recordGroup(ctx, "emulator", null);
    return { stopped: pids };
  } catch (err) {
    return { stopped: [], error: err.message };
  }
}

export async function simState(ctx, udid) {
  const r = await quick(ctx, ctx.bins.xcrun, ["simctl", "list", "devices", "-j"]);
  if (r.code !== 0) return null;
  const parsed = parseJson(r.stdout, null);
  for (const list of Object.values(parsed?.devices ?? {})) {
    for (const d of Array.isArray(list) ? list : []) {
      if (d?.udid === udid) return { exists: true, state: d.state ?? "unknown" };
    }
  }
  return { exists: false, state: null };
}

/** shutdown (errors ignored) → erase → boot → bootstatus -b. simctl only. */
export async function bootSim(ctx, udid) {
  const { bins, knobs } = ctx;
  await quick(ctx, bins.xcrun, ["simctl", "shutdown", udid]);
  ctx.devices.simUdid = udid;
  if (
    (await quick(ctx, bins.xcrun, ["simctl", "erase", udid], { timeoutMs: 2 * MINUTE_MS })).code !==
    0
  ) {
    throw new PlatformError("failed:boot", "erase");
  }
  await ctx.checkpoint();
  if (
    (await quick(ctx, bins.xcrun, ["simctl", "boot", udid], { timeoutMs: 2 * MINUTE_MS })).code !==
    0
  ) {
    throw new PlatformError("failed:boot", "boot");
  }
  const ready = await guardedRun(ctx, bins.xcrun, ["simctl", "bootstatus", udid, "-b"], {
    cwd: ctx.cwd,
    env: ctx.devEnv,
    timeoutMs: knobs.bootTimeoutMin * MINUTE_MS,
    stdoutFile: ctx.stepLog,
    stderrFile: ctx.stepLog,
    group: false,
  });
  if (ready.code !== 0)
    throw new PlatformError(ready.timedOut ? "failed:boot-timeout" : "failed:boot");
}

/** Never throws. */
export async function stopSim(ctx, udid) {
  try {
    if (!udid || !ctx.bins.xcrun) return { stopped: false };
    const r = await quick(ctx, ctx.bins.xcrun, ["simctl", "shutdown", udid], {
      timeoutMs: 2 * MINUTE_MS,
    });
    return { stopped: r.code === 0 };
  } catch (err) {
    return { stopped: false, error: err.message };
  }
}

async function installApp(ctx, platform, artifact) {
  const { bins } = ctx;
  if (platform === "android") {
    await quick(ctx, bins.adb, ["-s", EMULATOR_SERIAL, "uninstall", APP_ID], {
      timeoutMs: 2 * MINUTE_MS,
    });
    const r = await quick(ctx, bins.adb, ["-s", EMULATOR_SERIAL, "install", "-r", artifact], {
      timeoutMs: 5 * MINUTE_MS,
    });
    if (r.code !== 0) throw new PlatformError("failed:install");
    return;
  }
  const udid = ctx.devices.simUdid;
  const r = await quick(ctx, bins.xcrun, ["simctl", "install", udid, artifact], {
    timeoutMs: 5 * MINUTE_MS,
  });
  if (r.code !== 0) throw new PlatformError("failed:install");
  // ios-only/07 needs photo access; the prompt isn't always visible to Maestro.
  await quick(ctx, bins.xcrun, ["simctl", "privacy", udid, "grant", "photos", APP_ID]);
  await quick(ctx, bins.xcrun, ["simctl", "ui", udid, "appearance", "light"]);
}

// ── Maestro ─────────────────────────────────────────────────────────────────

function decodeXml(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseAttrs(text) {
  const out = {};
  for (const m of String(text ?? "").matchAll(
    /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    out[m[1]] = decodeXml(m[2] ?? m[3]);
  }
  return out;
}

const PASS_STATUSES = new Set(["SUCCESS", "PASSED", "PASS", "WARNING", "OK"]);
const FAIL_STATUSES = new Set(["ERROR", "FAILURE", "FAILED", "FAIL"]);

function caseStatus(statusAttr, childTag) {
  if (childTag === "failure") return "FAIL";
  if (childTag === "error") return "ERROR";
  const s = String(statusAttr ?? "").toUpperCase();
  if (!s || PASS_STATUSES.has(s)) return "PASS";
  if (FAIL_STATUSES.has(s)) return "FAIL";
  return "ERROR"; // CANCELED, STOPPED, SKIPPED, …: the flow didn't finish
}

/** Emails out, then the lane's secret scan: a hit withholds the whole text. */
export function sanitizeLine(text, secrets = {}) {
  let t = String(text ?? "").replace(EMAIL_RE, "[email]");
  const pw = secrets.password;
  const hits = scanLaneText(t, secrets);
  if (typeof pw === "string" && pw.length >= 4 && t.includes(pw)) hits.push("password");
  if (hits.length) return `[withheld: matched ${[...new Set(hits)].join(", ")}]`;
  t = t.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return t.length > FAILURE_MAX ? `${t.slice(0, FAILURE_MAX - 1)}…` : t;
}

/**
 * Maestro's JUnit report, reduced to what a report may show: per testcase its
 * name, PASS / FAIL / ERROR, its duration and the first line of a failure.
 * Emails redacted, secrets withheld, at most MAX_JUNIT_LINES lines.
 */
export function filterJunit(xml, { secrets = {} } = {}) {
  const cases = [];
  for (const m of String(xml ?? "").matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    const attrs = parseAttrs(m[1]);
    const body = m[2] ?? "";
    const f = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const status = caseStatus(attrs.status, f?.[1]);
    let message = "";
    if (f) {
      message = decodeXml(
        String(f[3] ?? "")
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
          .replace(/<[^>]*>/g, " "),
      );
      if (!message.trim()) message = parseAttrs(f[2]).message ?? "";
    }
    const firstLine =
      message
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean) ?? "";
    const time = Number(attrs.time);
    cases.push({
      name: sanitizeLine(attrs.name || attrs.id || "flow", secrets) || "flow",
      status,
      durationS: Number.isFinite(time) ? Math.round(time) : null,
      failure: status === "PASS" ? null : sanitizeLine(firstLine, secrets) || null,
    });
  }
  let lines = cases.map(
    (c) =>
      `${c.status} ${c.name}${c.durationS != null ? ` (${c.durationS}s)` : ""}${c.failure ? ` — ${c.failure}` : ""}`,
  );
  if (lines.length > MAX_JUNIT_LINES) {
    lines = [
      ...lines.slice(0, MAX_JUNIT_LINES - 1),
      `… ${lines.length - MAX_JUNIT_LINES + 1} more`,
    ];
  }
  return { cases, lines };
}

export function flowSlug(flow) {
  return flowName(flow)
    .replace(/\.ya?ml$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-");
}

function worstStatus(statuses) {
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("ERROR")) return "ERROR";
  return statuses.length ? "PASS" : "ERROR";
}

/**
 * The Maestro argument list for one flow. The password is never in it: it
 * travels in MAESTRO_E2E_TEST_PASSWORD (maestroFlowEnv).
 */
export function maestroArgs({ deviceId, flowPath, junit, rawDir, runEpoch, email }) {
  const args = [
    "--device",
    deviceId,
    "test",
    flowPath,
    "--format",
    "junit",
    "--output",
    junit,
    "--test-output-dir",
    path.join(rawDir, "maestro"),
    "--debug-output",
    path.join(rawDir, "debug"),
    "-e",
    `RUN_ID=${runEpoch}`,
  ];
  if (email) args.push("-e", `E2E_TEST_EMAIL=${email}`);
  return args;
}

async function sha256File(fs, file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Append one entry to <runDir>/evidence/shots.json (the provenance manifest). */
export function appendShot(fs, runDir, entry) {
  const file = path.join(runDir, "evidence", SHOTS_FILE);
  const list = parseJson(readText(fs, file), []);
  const next = Array.isArray(list) ? list : [];
  next.push(entry);
  writeJsonAtomic(fs, file, next);
}

/** The supervisor's own final-state screenshot after a flow. Never throws. */
export async function captureShot(ctx, { platform, deviceId, index, flow }) {
  const { deps, bins, runDir } = ctx;
  const fs = deps.fs;
  try {
    const dir = path.join(runDir, "evidence", `device-${platform}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${String(index).padStart(2, "0")}-${flowSlug(flow)}.png`;
    const file = path.join(dir, name);
    rmQuiet(fs, file);
    const r =
      platform === "android"
        ? await deps.run(bins.adb, ["-s", deviceId, "exec-out", "screencap", "-p"], {
            cwd: ctx.cwd,
            env: ctx.devEnv,
            timeoutMs: QUICK_MS,
            stdoutFile: file,
            stderrFile: ctx.stepLog,
          })
        : await deps.run(bins.xcrun, ["simctl", "io", deviceId, "screenshot", file], {
            cwd: ctx.cwd,
            env: ctx.devEnv,
            timeoutMs: QUICK_MS,
            stdoutFile: ctx.stepLog,
            stderrFile: ctx.stepLog,
          });
    if (r.code !== 0 || !fs.existsSync(file) || fs.statSync(file).size === 0) {
      rmQuiet(fs, file);
      return null;
    }
    const entry = {
      file: `device-${platform}/${name}`,
      sha256: await sha256File(fs, file),
      platform,
      flow: flowName(flow),
      capturedAt: isoSeconds(deps.now()),
      pass: "final",
    };
    appendShot(fs, runDir, entry);
    return entry;
  } catch (err) {
    ctx.log(`screenshot after ${flowName(flow)} failed: ${err.message}`);
    return null;
  }
}

/**
 * Run each flow on <deviceId>, then capture the screen. Returns
 * device-output.json's flow rows. Throws Interrupt.
 */
export async function runMaestro(ctx, { platform, deviceId, flows, account, root }) {
  const { deps, meta } = ctx;
  const results = [];
  const env = maestroFlowEnv(ctx.devEnv, account);
  const secrets = account ? { password: account.password } : {};
  // One RUN_ID for the platform's whole run, as the README's sequential runs
  // use: a changed 03 or 04 finds the notebook the flows before it created.
  const runEpoch = Math.floor(deps.nowMs() / 1000);
  const maestro = (flowPath, junit, log) =>
    guardedRun(
      ctx,
      meta.bins.maestro,
      maestroArgs({
        deviceId,
        flowPath,
        junit,
        rawDir: ctx.rawDir,
        runEpoch,
        email: account?.email ?? null,
      }),
      {
        cwd: root,
        env,
        timeoutMs: meta.knobs.flowTimeoutMin * MINUTE_MS,
        stdoutFile: log,
        stderrFile: log,
      },
    );
  for (const [i, flow] of flows.entries()) {
    const index = i + 1;
    const nn = String(index).padStart(2, "0");
    const slug = flowSlug(flow);
    const junit = path.join(ctx.rawDir, `${nn}-${slug}.junit.xml`);
    rmQuiet(deps.fs, junit);
    const log = path.join(ctx.rawDir, `${nn}-${slug}.log`);
    const started = deps.nowMs();
    const signIn = await signInBefore(ctx, { flow, root, account, nn, maestro, platform });
    if (signIn) {
      results.push({
        name: flowName(flow),
        status: "ERROR",
        durationS: Math.round((deps.nowMs() - started) / 1000),
        failure: signIn,
      });
      await captureShot(ctx, { platform, deviceId, index, flow });
      ctx.onFlow?.(results);
      continue;
    }
    ctx.log(`maestro: ${platform} ${flowName(flow)} starting`);
    const r = await maestro(path.join(root, flow), junit, log);
    const durationS = Math.round((deps.nowMs() - started) / 1000);
    const parsed = filterJunit(readText(deps.fs, junit), { secrets });
    let status;
    let failure = null;
    if (r.timedOut) {
      status = "ERROR";
      failure = `timed out after ${meta.knobs.flowTimeoutMin} min`;
    } else if (parsed.cases.length) {
      status = worstStatus(parsed.cases.map((c) => c.status));
      failure = parsed.cases.find((c) => c.failure)?.failure ?? null;
      if (status === "PASS" && r.code !== 0) {
        status = "ERROR";
        failure = `maestro exited ${r.code}`;
      }
    } else {
      status = r.code === 0 ? "PASS" : "ERROR";
      if (status === "ERROR") failure = `maestro exited ${r.code} with no JUnit report`;
    }
    for (const line of parsed.lines) ctx.log(`maestro: ${platform} ${line}`);
    results.push({ name: flowName(flow), status, durationS, failure });
    await captureShot(ctx, { platform, deviceId, index, flow });
    ctx.onFlow?.(results);
  }
  return results;
}

export const SIGN_IN_PRELUDE = `${E2E_DIR}/.device-lane-sign-in.yaml`;

/**
 * The lane's sign-in before a flow that assumes a signed-in app: the repo's
 * vetted helpers/sign-in-clean.yaml (a clean start, then the account's
 * sign-in), with the password read from MAESTRO_E2E_TEST_PASSWORD.
 */
export function signInPreludeYaml() {
  return [
    "appId: eu.drafto.mobile",
    "---",
    "# Written by the factory's device lane (device-lane.mjs) into its build root:",
    "# a clean start, signed in as the lane's account, before a flow that assumes",
    "# a signed-in app.",
    "- runFlow:",
    "    file: helpers/sign-in-clean.yaml",
    "    env:",
    "      SIGN_IN_EMAIL: ${E2E_TEST_EMAIL}",
    "      SIGN_IN_PASSWORD: \"${typeof E2E_TEST_PASSWORD !== 'undefined' ? E2E_TEST_PASSWORD : MAESTRO_E2E_TEST_PASSWORD}\"",
    "",
  ].join("\n");
}

/**
 * Sign in before <flow> when it needs it (flowNeedsSignIn). Returns null when
 * the flow may run, or why it can't (the row's failure).
 */
async function signInBefore(ctx, { flow, root, account, nn, maestro, platform }) {
  const fs = ctx.deps.fs;
  if (!flowNeedsSignIn(readText(fs, path.join(root, flow)))) return null;
  if (!account) return "needs a signed-in app, and the run has no account";
  const prelude = path.join(root, SIGN_IN_PRELUDE);
  fs.writeFileSync(prelude, signInPreludeYaml());
  ctx.log(`maestro: ${platform} signing in before ${flowName(flow)}`);
  const r = await maestro(
    prelude,
    path.join(ctx.rawDir, `${nn}-sign-in.junit.xml`),
    path.join(ctx.rawDir, `${nn}-sign-in.log`),
  );
  return r.code === 0 && !r.timedOut ? null : "the lane's sign-in before this flow failed";
}

/** Maestro's environment: the device env plus, with an account, the password. */
export function maestroFlowEnv(devEnv, account) {
  const env = { ...devEnv };
  if (account?.password) env.MAESTRO_E2E_TEST_PASSWORD = account.password;
  return env;
}

// ── one platform ────────────────────────────────────────────────────────────

export function platformVerdict(flows) {
  return worstStatus(flows.map((f) => f.status));
}

/**
 * Build, check, boot, install, run, shut down — for one platform. Returns its
 * device-output.json entry. A PlatformError becomes the entry's state; an
 * Interrupt (or anything unexpected) propagates after the device is stopped.
 */
export async function runPlatform(ctx, platform, { flows, account, needsAccount }) {
  const { deps, meta } = ctx;
  const fs = deps.fs;
  const res = { state: "running", verdict: null, build: null, flows: [] };
  ctx.output.platforms[platform] = res;
  ctx.save();
  ctx.platDir = path.join(ctx.runDir, `device-${platform}`);
  ctx.rawDir = path.join(ctx.runDir, "private", `device-${platform}`);
  fs.mkdirSync(ctx.platDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(ctx.rawDir, { recursive: true, mode: 0o700 });
  ctx.stepLog = path.join(ctx.platDir, "steps.log");
  let deviceUp = false;
  try {
    if (needsAccount && !account) throw new PlatformError("unavailable:no-account");
    if (platform === "ios") {
      if (!meta.iosSimUdid) throw new PlatformError("unavailable:no-simulator");
    } else {
      if (!fs.existsSync(meta.knobs.keystore)) throw new PlatformError("unavailable:no-keystore");
      if (!avdExists(meta.knobs, fs)) throw new PlatformError("unavailable:no-avd");
    }
    ctx.stage = `${platform}:prepare`;
    const { root, expoValues } = await prepareDeviceRoot(ctx, platform, meta.sha);
    const env = buildEnv(deps.env, { bins: meta.bins, knobs: meta.knobs, platform, expoValues });
    const t0 = deps.nowMs();
    ctx.stage = `${platform}:native`;
    const native = await ensureNative(ctx, root, platform, expoValues, env);
    ctx.stage = `${platform}:build`;
    const artifact =
      platform === "android" ? await buildAndroid(ctx, root, env) : await buildIos(ctx, root, env);
    res.build = { cached: native.cached, durationS: Math.round((deps.nowMs() - t0) / 1000) };
    ctx.save();
    ctx.stage = `${platform}:artifact`;
    const check = await checkArtifact(ctx, platform, artifact);
    if (!check.ok) {
      ctx.log(`${platform}: artifact refused (${check.problem}); nothing installs`);
      throw new PlatformError("unavailable:artifact-not-dev", check.problem);
    }
    await ctx.checkpoint();
    ctx.stage = `${platform}:boot`;
    deviceUp = true;
    let deviceId;
    if (platform === "android") {
      await bootEmulator(ctx);
      deviceId = EMULATOR_SERIAL;
    } else {
      await bootSim(ctx, meta.iosSimUdid);
      deviceId = meta.iosSimUdid;
    }
    ctx.stage = `${platform}:install`;
    await installApp(ctx, platform, artifact);
    ctx.stage = `${platform}:flows`;
    ctx.onFlow = (rows) => {
      res.flows = [...rows];
      ctx.save();
    };
    res.flows = await runMaestro(ctx, { platform, deviceId, flows, account, root });
    res.verdict = platformVerdict(res.flows);
    res.state = "done";
  } catch (err) {
    if (!(err instanceof PlatformError)) throw err;
    res.state = err.state;
    ctx.log(`${platform}: ${err.message}`);
  } finally {
    ctx.onFlow = null;
    if (deviceUp) await stopDevice(ctx, platform);
    ctx.save();
  }
  return res;
}

async function stopDevice(ctx, platform) {
  if (platform === "android") {
    await stopEmulator(ctx, ctx.devices.emulatorPid ?? null);
    ctx.devices.emulatorPid = null;
  } else {
    await stopSim(ctx, ctx.devices.simUdid ?? ctx.meta.iosSimUdid);
    ctx.devices.simUdid = null;
  }
}

/** Both devices, by the fixed port and the configured UDID. Never throws. */
export async function stopAllDevices(ctx, udid) {
  const out = { emulator: null, simulator: null };
  if (ctx.bins.adb) out.emulator = await stopEmulator(ctx, ctx.devices?.emulatorPid ?? null);
  if (udid && ctx.bins.xcrun) out.simulator = await stopSim(ctx, udid);
  return out;
}

// ── output ──────────────────────────────────────────────────────────────────

export function initialOutput(meta) {
  const platforms = {};
  for (const p of meta.order)
    platforms[p] = { state: "running", verdict: null, build: null, flows: [] };
  return {
    version: 1,
    runId: meta.runId,
    issue: meta.issue == null ? null : Number(meta.issue),
    pr: meta.pr == null ? null : Number(meta.pr),
    sha: meta.sha,
    mode: meta.mode,
    trigger: meta.trigger,
    startedAt: meta.startedAt,
    finishedAt: null,
    platforms,
  };
}

/** The run's overall verdict from device-output.json, or null when nothing ran. */
export function runVerdict(output) {
  const ps = Object.values(output?.platforms ?? {});
  if (ps.some((p) => p.verdict === "FAIL")) return "FAIL";
  if (ps.some((p) => p.verdict === "ERROR" || String(p.state).startsWith("failed:")))
    return "ERROR";
  if (ps.some((p) => p.verdict === "PASS")) return "PASS";
  return null;
}

// ── supervisor ──────────────────────────────────────────────────────────────

function makeCtx({ deps, meta, runDir, status, output, save, account, log }) {
  return makeChecks({
    deps,
    meta,
    runDir,
    status,
    output,
    save,
    account,
    log,
    bins: meta.bins,
    knobs: meta.knobs,
    cwd: runDir,
    devEnv: deviceEnv(deps.env, { bins: meta.bins, knobs: meta.knobs }),
    devices: { emulatorPid: null, simUdid: null },
    stage: "start",
    pollMs: POLL_MS,
    platDir: runDir,
    rawDir: path.join(runDir, "private"),
    stepLog: null,
    recordGroups: true,
  });
}

/**
 * The detached supervisor: platforms one after another, devices down on every
 * exit path, device-output.json and exit.json written, the device lock released.
 */
export async function runSupervise({ runDir }, { deps = createDeviceDeps() } = {}) {
  const fs = deps.fs;
  const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf8"));
  const logFile = path.join(runDir, "supervisor.log");
  const log = (line) => appendLog(logFile, line);
  const outFile = path.join(runDir, OUTPUT_FILE);
  const output = initialOutput(meta);
  const save = () => writeJsonAtomic(fs, outFile, output);
  const status = { terminated: false, timedOut: false, child: null, stopReason: null };
  fs.mkdirSync(path.join(runDir, "private"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(runDir, "evidence"), { recursive: true, mode: 0o700 });
  save();
  const account =
    meta.needsAccount && meta.paths.accountFile
      ? readDeviceAccount(meta.paths.accountFile, fs)
      : null;
  const ctx = makeCtx({ deps, meta, runDir, status, output, save, account, log });

  const onSignal = () => {
    if (!status.timedOut) status.terminated = true;
    const req = parseJson(readText(fs, path.join(runDir, STOP_REQUEST_FILE)), null);
    if (typeof req?.reason === "string" && /^[a-z-]{1,40}$/.test(req.reason))
      status.stopReason = req.reason;
    log(`stop signal received (${status.stopReason ?? "signal"})`);
    killGroup(deps, status.child);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  const deadlineMs = Math.max(0, Date.parse(meta.deadlineAt) - deps.nowMs());
  const deadline = setTimeout(() => {
    status.timedOut = true;
    log("run cap reached; stopping the run");
    killGroup(deps, status.child);
  }, deadlineMs);
  deadline.unref?.();

  let interrupt = null;
  let error = null;
  try {
    for (const platform of meta.order) {
      const plan = meta.platforms[platform];
      await runPlatform(ctx, platform, {
        flows: plan.flows,
        account,
        needsAccount: meta.needsAccount,
      });
    }
  } catch (err) {
    if (err instanceof Interrupt) interrupt = err.state;
    else error = err.message;
    for (const p of meta.order) {
      const entry = output.platforms[p];
      if (entry.state === "running") entry.state = interrupt ?? "failed:error";
    }
    log(`run ended early: ${interrupt ?? error}`);
  } finally {
    clearTimeout(deadline);
    await stopAllDevices(ctx, meta.iosSimUdid);
    rmQuiet(fs, path.join(runDir, PGIDS_FILE));
    if (!meta.knobs.keepRaw) rmQuiet(fs, path.join(runDir, "private"));
    output.finishedAt = isoSeconds(deps.now());
    save();
    writeJsonAtomic(fs, path.join(runDir, "exit.json"), {
      interrupt,
      error,
      timedOut: status.timedOut,
      terminated: status.terminated,
      stage: ctx.stage,
      endedAt: output.finishedAt,
    });
    releasePidLock(meta.paths.deviceLock, deps.pid ?? process.pid, deps);
    log(
      `run ended (stage=${ctx.stage}, interrupt=${interrupt ?? "none"}, error=${error ?? "none"})`,
    );
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
  }
  return output;
}

// ── real dependencies ───────────────────────────────────────────────────────

/**
 * @expo/fingerprint's hash for <platform>, through expo's own copy (pnpm
 * keeps it out of apps/mobile's direct deps). The native dirs are ignored:
 * they are prebuild's output, not its input. null on any failure.
 */
async function realExpoFingerprint(root, platform, env) {
  const script = [
    "const { createRequire } = require('module');",
    "const r = createRequire(process.cwd() + '/package.json');",
    "const fp = createRequire(r.resolve('expo/package.json'))('@expo/fingerprint');",
    "fp.createFingerprintAsync('.', { platforms: [process.argv[1]], ignorePaths: ['android/**/*', 'ios/**/*'] })",
    "  .then((f) => process.stdout.write(f.hash))",
    "  .catch(() => process.exit(1));",
  ].join("\n");
  const r = await runCommand(process.execPath, ["-e", script, platform], {
    cwd: path.join(root, "apps", "mobile"),
    env,
    timeoutMs: 5 * MINUTE_MS,
  });
  const hash = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{16,}$/i.test(hash) ? hash : null;
}

async function realCardColumn(issue) {
  const r = await runCommand(
    "gh",
    ["issue", "view", String(issue), "--repo", REPO, "--json", "state,labels"],
    { timeoutMs: ghTimeoutMs() },
  );
  const view = r.code === 0 ? parseJson(r.stdout, null) : null;
  if (!view || !Array.isArray(view.labels)) return null;
  if (view.state === "CLOSED") return "closed";
  const labels = view.labels.map((l) => l?.name);
  if (labels.includes("status:testing")) return "Testing";
  if (labels.includes("status:in-test")) return "In Test";
  return "other";
}

export function createDeviceDeps() {
  return {
    env: process.env,
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
    fs: nodeFs,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    gh: (args) => runCommand("gh", args, { timeoutMs: ghTimeoutMs() }),
    git: (args, { cwd } = {}) => runCommand("git", args, { cwd }),
    run: runStep,
    exec: runCommand,
    spawnDetached: realSpawnDetached,
    isPidAlive: realIsPidAlive,
    isExecutable: realIsExecutable,
    psCommand: async (pid) => {
      const r = await runCommand("ps", ["-o", "command=", "-p", String(pid)]);
      return r.code === 0 ? r.stdout.trim() : "";
    },
    listProcesses: async () => {
      const r = await runCommand("ps", ["-axww", "-o", "pid=,command="]);
      if (r.code !== 0) return null;
      return r.stdout
        .split("\n")
        .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
        .filter(Boolean)
        .map((m) => ({ pid: Number(m[1]), command: m[2] }));
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    },
    memoryPressure: () => memoryPressure(),
    freeDiskGb: (dir) => freeDiskGb(dir),
    expoFingerprint: realExpoFingerprint,
    cardColumn: realCardColumn,
    pid: process.pid,
  };
}

// ── start ───────────────────────────────────────────────────────────────────

function parsePlatforms(raw) {
  if (raw == null || raw === "") return null;
  const list = String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0 || list.some((p) => !PLATFORMS.includes(p))) {
    throw new Error(`--platforms must be a comma list of ${PLATFORMS.join(", ")}`);
  }
  return [...new Set(list)];
}

async function readPr(pr, deps) {
  const r = await deps.gh([
    "pr",
    "view",
    String(pr),
    "--repo",
    REPO,
    "--json",
    "state,headRefOid,files",
  ]);
  const view = r.code === 0 ? parseJson(r.stdout, null) : null;
  if (!view || typeof view.state !== "string" || typeof view.headRefOid !== "string") return null;
  return view;
}

/** Why the lane can't start right now (deferred:*), or null. */
export async function deferReason({ knobs, lockPaths }, deps) {
  const lock = lockHolder(deviceLockPath(knobs), deps);
  if (lock.alive && lock.pid !== deps.pid) return { reason: "deferred:busy", holder: lock.pid };
  const beta = betaBuildBusy(lockPaths, deps);
  if (beta) return { reason: "deferred:beta-build", lock: beta.lock };
  const pressure = await deps.memoryPressure();
  if (Number.isInteger(pressure) && pressure >= 2) return { reason: "deferred:memory", pressure };
  if (!volumeMounted(deps.fs, knobs.volume)) return { reason: "deferred:disk", volume: "missing" };
  const volumeFree = await deps.freeDiskGb(knobs.volume);
  if (Number.isInteger(volumeFree) && volumeFree < knobs.minFreeGb) {
    return { reason: "deferred:disk", freeGb: volumeFree };
  }
  const home = deps.env?.HOME || os.homedir();
  const rootFree = await deps.freeDiskGb(home);
  if (Number.isInteger(rootFree) && rootFree < knobs.rootMinFreeGb) {
    return { reason: "deferred:disk", rootFreeGb: rootFree };
  }
  return null;
}

async function readFlowTags(files, sha, repoRoot, deps) {
  const tags = {};
  for (const file of files.filter((f) => f.startsWith(`${E2E_DIR}/`) && /\.ya?ml$/.test(f))) {
    const r = await deps.git(["show", `${sha}:${file}`], { cwd: repoRoot });
    if (r.code === 0) tags[file] = parseFlowTags(r.stdout);
  }
  return tags;
}

function readIosSimUdid(repoRoot, fs) {
  const cfg = parseJson(readText(fs, deviceConfigPath(repoRoot)), null);
  const udid = cfg?.iosSimUdid;
  return typeof udid === "string" && /^[0-9A-Fa-f-]{36}$/.test(udid) ? udid : null;
}

export async function runStart(opts, deps) {
  const { issue, pr, sha, repoRoot } = opts;
  const runRoot = opts.runRoot ?? defaultRunRoot(repoRoot);
  const now = opts.now ?? deps.now();
  const knobs = await withJavaHome(readDeviceKnobs(deps.env), deps);
  const mode = opts.mode ?? "smoke";
  const trigger = opts.trigger ?? "testing";
  const ledgerFile = ledgerPath(repoRoot);
  const refuse = (reason, extra = {}) => ({ started: false, reason, ...extra });
  if (!MODES.includes(mode)) return refuse("bad-mode");
  if (!TRIGGERS.includes(trigger)) return refuse("bad-trigger");

  const snapshot = await loadLedger(ledgerFile);
  if (snapshot.inFlight) {
    return refuse("deferred:busy", {
      runId: snapshot.inFlight.runId,
      busyIssue: snapshot.inFlight.issue,
    });
  }
  const lockPaths = betaLockPaths(deps.env);
  const deferred = await deferReason({ knobs, lockPaths }, deps);
  if (deferred) return refuse(deferred.reason, deferred);
  const used = attemptsFor(snapshot, issue, sha);
  if (used >= knobs.maxAttempts && !opts.forceAttempt)
    return refuse("attempts", { attempts: used });

  const view = await readPr(pr, deps);
  if (!view) return refuse("pr-unreadable");
  if (view.state !== "OPEN" || view.headRefOid !== sha) {
    return refuse("head-moved", { headSha: view.headRefOid, prState: view.state });
  }
  const fileRows = (Array.isArray(view.files) ? view.files : []).filter((f) => f?.path);
  const files = fileRows.map((f) => f.path);
  // gh lists deleted files too: they still change the app, but never run.
  const deletedFiles = fileRows.filter((f) => f.changeType === "DELETED").map((f) => f.path);
  const requested = parsePlatforms(opts.platforms);
  // The flows' tags come from the PR head, which needs the commit locally.
  const fetched = await deps.git(["fetch", "--quiet", "origin", `pull/${pr}/head`], {
    cwd: repoRoot,
  });
  if (fetched.code !== 0) return refuse("fetch-failed");
  const flowTags = await readFlowTags(files, sha, repoRoot, deps);
  const plan = deriveDevicePlan({
    diffFiles: files,
    scenarioSections: opts.scenarioSections ?? [],
    flowTags,
    deletedFiles,
  });
  if (!requested && !plan.applicable) return refuse("not-applicable", { reasons: plan.reasons });
  const order = PLATFORMS.filter((p) =>
    requested ? requested.includes(p) : Boolean(plan.platforms[p]),
  );
  const platforms = {};
  for (const p of order) platforms[p] = { flows: plan.platforms[p]?.flows ?? [smokeFlow(p)] };

  const accountProblem = deviceAccountProblem(knobs.accountFile, deps.fs);
  if (accountProblem) return refuse("account", { problem: accountProblem });
  const bins = resolveDeviceBins({ env: deps.env, isExecutable: deps.isExecutable, knobs });
  const missing = missingBins(bins, order);
  if (missing.length) return refuse(`${missing[0]}-missing`, { missing });
  if (opts.dryRun) return refuse("dry-run", { platforms, reasons: plan.reasons });

  const runId = makeRunId(issue, sha, now);
  const deadlineAt = addMinutes(now, knobs.runMaxMin);
  const runDir = path.join(runRoot, runId);
  let reserved = null;
  await mutateState(LEDGER_STORE, ledgerFile, (l) => {
    if (l.inFlight) return false;
    const attempt = bumpAttempts(l, issue, sha, 1);
    l.inFlight = {
      runId,
      issue: String(issue),
      pr: String(pr),
      sha,
      pid: null,
      runDir,
      startedAt: isoSeconds(now),
      deadlineAt,
      trigger,
      platforms: order,
    };
    reserved = { attempt };
    return true;
  });
  if (!reserved) return refuse("deferred:busy");

  const lockFile = deviceLockPath(knobs);
  const giveBack = async () => {
    await finishLedgerRun(ledgerFile, runId, { refund: "attempt", last: null });
    releasePidLock(lockFile, deps.pid, deps);
  };
  const took = takePidLock(lockFile, deps.pid, deps);
  if (!took.ok) {
    await giveBack();
    return refuse("deferred:busy", { holder: took.holder });
  }
  let spawned = null;
  try {
    await ensureDeviceWorktrees({ repoRoot, sha, platforms: order, knobs }, deps);
    deps.fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    deps.fs.chmodSync(runDir, 0o700);
    const meta = {
      runId,
      issue: String(issue),
      pr: String(pr),
      sha,
      mode,
      trigger,
      startedAt: isoSeconds(now),
      deadlineAt,
      repoRoot,
      runDir,
      order,
      platforms,
      planReasons: plan.reasons,
      needsAccount: true,
      iosSimUdid: readIosSimUdid(repoRoot, deps.fs),
      bins,
      knobs,
      // Paths only, never a secret's value.
      paths: {
        accountFile: knobs.accountFile,
        envSource: path.join(repoRoot, "apps", "mobile", ".env"),
        deviceLock: lockFile,
        betaLocks: lockPaths,
        module: THIS_FILE,
      },
    };
    writeJsonAtomic(deps.fs, path.join(runDir, "meta.json"), meta);
    spawned = await deps.spawnDetached(
      bins.nice,
      ["-n", "10", bins.node, THIS_FILE, "_supervise", "--run-dir", runDir],
      { cwd: runDir, logPath: path.join(runDir, "supervisor.log"), env: supervisedEnv(deps.env) },
    );
    if (!spawned.ok) throw new Error(`supervisor failed to start: ${spawned.reason}`);
    handOverPidLock(lockFile, deps.pid, spawned.pid, deps);
    const attached = await mutateState(LEDGER_STORE, ledgerFile, (l) => {
      if (l.inFlight?.runId !== runId) return false;
      l.inFlight.pid = spawned.pid;
      return true;
    });
    if (!attached) {
      deps.kill(-spawned.pid, "SIGTERM");
      return refuse("abandoned", { runId });
    }
    return {
      started: true,
      runId,
      runDir,
      platforms,
      attempt: reserved.attempt,
      deadlineAt,
      reasons: plan.reasons,
    };
  } catch (err) {
    if (spawned?.ok) deps.kill(-spawned.pid, "SIGTERM");
    await giveBack();
    return refuse("start-failed", { error: err.message });
  }
}

// ── housekeeping, stop, status ──────────────────────────────────────────────

/**
 * What a finished (or dead) run means. Pure.
 *   state:  what the ledger records for the card's head
 *   refund: "attempt" when the run's end wasn't the card's doing
 */
export function classifyDeviceRun({ exit, output, attemptsUsed = 1, maxAttempts = 2 }) {
  if (!exit) {
    return {
      state: attemptsUsed < maxAttempts ? "retry:lost" : "unavailable:lost",
      refund: "none",
    };
  }
  if (exit.interrupt === "failed:timeout" || (exit.timedOut && !exit.interrupt)) {
    return { state: "timeout", refund: "none" };
  }
  if (typeof exit.interrupt === "string" && exit.interrupt.startsWith("stopped:")) {
    const reason = exit.interrupt.slice("stopped:".length);
    if (RETRY_STOPS.has(reason)) return { state: `retry:${reason}`, refund: "attempt" };
    return { state: `stopped:${reason}`, refund: REFUNDED_STOPS.has(reason) ? "attempt" : "none" };
  }
  if (exit.error) return { state: "failed:error", refund: "none" };
  const verdict = runVerdict(output);
  if (!verdict) return { state: "unavailable", refund: "none" };
  return { state: `done:${verdict}`, refund: "none" };
}

/** Why a running run should stop now (in-tick, gh), or null. */
async function stopReasonFor(inFlight, deps) {
  if (inFlight.pr) {
    const view = await readPr(inFlight.pr, deps);
    if (view && view.state !== "OPEN") return "pr-closed";
    if (view && view.headRefOid !== inFlight.sha) return "head-moved";
  }
  const column = deps.cardColumn ? await deps.cardColumn(inFlight.issue) : null;
  if (column && column !== "Testing" && column !== "In Test") return "left-column";
  return null;
}

function hkCtx(deps, knobs, repoRoot) {
  const bins = resolveDeviceBins({ env: deps.env, isExecutable: deps.isExecutable, knobs });
  return {
    deps,
    bins,
    knobs,
    cwd: repoRoot,
    devEnv: deviceEnv(deps.env, { bins, knobs }),
    devices: { emulatorPid: null, simUdid: null },
    stepLog: null,
    log: () => {},
  };
}

function lastFor(inFlight, state, now) {
  return {
    sha: inFlight.sha,
    runId: inFlight.runId,
    runDir: inFlight.runDir,
    state,
    finishedAt: isoSeconds(now),
  };
}

function signalRun(inFlight, reason, deps) {
  if (inFlight.runDir) {
    try {
      writeJsonAtomic(deps.fs, path.join(inFlight.runDir, STOP_REQUEST_FILE), { reason });
    } catch {
      /* the run dir is gone: the signal alone still stops it */
    }
  }
}

export async function runStop(opts, deps) {
  const { issue, repoRoot } = opts;
  const reason = opts.reason ?? "stop";
  const ledgerFile = ledgerPath(repoRoot);
  const snapshot = await loadLedger(ledgerFile);
  const inFlight = snapshot.inFlight;
  if (!inFlight || inFlight.issue !== String(issue)) return { state: "idle" };
  if (opts.dryRun) return { state: "would-stop", runId: inFlight.runId, dryRun: true };
  signalRun(inFlight, reason, deps);
  let signalled = false;
  if (Number.isInteger(inFlight.pid) && deps.isPidAlive(inFlight.pid)) {
    if ((await deps.psCommand(inFlight.pid)).includes(inFlight.runId)) {
      signalled = deps.kill(-inFlight.pid, "SIGTERM");
    }
  } else if (inFlight.pid == null) {
    const procs = await deps.listProcesses();
    if (!Array.isArray(procs)) return { state: "error", error: "ps-failed" };
    for (const pid of supervisorPids(procs, inFlight.runId)) {
      signalled = deps.kill(-pid, "SIGTERM") || signalled;
    }
  }
  // No live supervisor to wind its children down: their groups directly.
  const groups = signalled ? [] : await killRecordedGroups(inFlight.runDir, "SIGTERM", deps);
  const refund = REFUNDED_STOPS.has(reason) ? "attempt" : "none";
  const now = opts.now ?? deps.now();
  const finished = await finishLedgerRun(ledgerFile, inFlight.runId, {
    refund,
    last: lastFor(inFlight, `stopped:${reason}`, now),
  });
  return {
    state: "stopped",
    runId: inFlight.runId,
    reason,
    signalled,
    groups,
    refund,
    ...(finished ? {} : { finishedElsewhere: true }),
  };
}

async function reapIdle({ repoRoot, runRoot, knobs, now, liveRunId = null }, deps) {
  const reaped = { lock: false, devices: null, runDirs: [], privateDirs: [] };
  const lockFile = deviceLockPath(knobs);
  const holder = lockHolder(lockFile, deps);
  if (!holder.alive) {
    if (deps.fs.existsSync(lockFile)) reaped.lock = releasePidLock(lockFile, deps.pid, deps);
    // Nothing holds the devices: anything still up on the lane's port or UDID
    // was left by a supervisor that died.
    if (!liveRunId) {
      const ctx = hkCtx(deps, knobs, repoRoot);
      const udid = readIosSimUdid(repoRoot, deps.fs);
      const emu = ctx.bins.adb ? await emulatorRunning(ctx) : false;
      const sim = udid && ctx.bins.xcrun ? await simState(ctx, udid) : null;
      if (emu || sim?.state === "Booted") {
        reaped.devices = await stopAllDevices(ctx, sim?.state === "Booted" ? udid : null);
      }
    }
  }
  let names = [];
  try {
    names = deps.fs.readdirSync(runRoot).filter((n) => RUN_ID_RE.test(n));
  } catch {
    names = [];
  }
  const procs = names.length ? await deps.listProcesses() : [];
  const commands = Array.isArray(procs) ? procs.map((p) => p.command) : null;
  const isLive = (id) => id === liveRunId || !commands || commands.some((c) => c.includes(id));
  for (const name of names) {
    const full = path.join(runRoot, name);
    if (isLive(name)) continue;
    try {
      if (Date.parse(now) - deps.fs.statSync(full).mtimeMs > RUN_DIR_RETENTION_MS) {
        rmQuiet(deps.fs, full);
        reaped.runDirs.push(full);
        continue;
      }
    } catch {
      continue;
    }
    if (deps.fs.existsSync(path.join(full, "private"))) {
      rmQuiet(deps.fs, path.join(full, "private"));
      reaped.privateDirs.push(full);
    }
  }
  return reaped;
}

export async function runHousekeeping(opts, deps) {
  const { repoRoot } = opts;
  const runRoot = opts.runRoot ?? defaultRunRoot(repoRoot);
  const now = opts.now ?? deps.now();
  const knobs = readDeviceKnobs(deps.env);
  const ledgerFile = ledgerPath(repoRoot);
  const snapshot = await loadLedger(ledgerFile);
  const inFlight = snapshot.inFlight;
  if (!inFlight) {
    const reaped = opts.dryRun ? null : await reapIdle({ repoRoot, runRoot, knobs, now }, deps);
    return { state: "idle", reaped };
  }
  const base = { runId: inFlight.runId, issue: inFlight.issue, sha: inFlight.sha };
  const poll = await pollRun(inFlight, { now }, deps);
  const live = poll.state === "running" || poll.state === "overdue";
  if (live && !opts.dryRun) {
    const why = await stopReasonFor(inFlight, deps);
    if (why) {
      signalRun(inFlight, why, deps);
      deps.kill(-inFlight.pid, poll.signal ?? "SIGTERM");
      // Overdue: the supervisor is wedged and may never stop its children.
      if (poll.state === "overdue") await killRecordedGroups(inFlight.runDir, poll.signal, deps);
      const refund = REFUNDED_STOPS.has(why) ? "attempt" : "none";
      // The supervisor shuts its device down and drops the device lock itself;
      // until it has, the lock keeps the next run from starting.
      const finished = await finishLedgerRun(ledgerFile, inFlight.runId, {
        refund,
        last: lastFor(inFlight, `stopped:${why}`, now),
      });
      return {
        ...base,
        state: "terminated",
        reason: why,
        refund,
        ...(finished ? {} : { finishedElsewhere: true }),
      };
    }
  }
  if (poll.state === "starting" || poll.state === "running") return { ...base, state: poll.state };
  if (poll.state === "overdue") {
    let groups = [];
    if (!opts.dryRun) {
      deps.kill(-inFlight.pid, poll.signal);
      groups = await killRecordedGroups(inFlight.runDir, poll.signal, deps);
    }
    return { ...base, state: "overdue", signal: poll.signal, groups };
  }
  if (opts.dryRun) return { ...base, state: poll.state, dryRun: true };
  if (poll.unattached) {
    const procs = await deps.listProcesses();
    if (!Array.isArray(procs)) return { ...base, state: "lost", deferred: "ps-failed" };
    const orphans = supervisorPids(procs, inFlight.runId);
    for (const pid of orphans) deps.kill(-pid, "SIGTERM");
    if (orphans.length === 0) await killRecordedGroups(inFlight.runDir, "SIGTERM", deps);
    await finishLedgerRun(ledgerFile, inFlight.runId, {
      refund: "attempt",
      last: lastFor(inFlight, "retry:lost", now),
    });
    return { ...base, state: "lost", outcome: "unattached", refund: "attempt", killed: orphans };
  }
  // done, or lost (the supervisor died without exit.json).
  const exit = poll.exit ?? null;
  const output = inFlight.runDir
    ? parseJson(readText(deps.fs, path.join(inFlight.runDir, OUTPUT_FILE)), null)
    : null;
  const c = classifyDeviceRun({
    exit,
    output,
    attemptsUsed: attemptsFor(snapshot, inFlight.issue, inFlight.sha),
    maxAttempts: knobs.maxAttempts,
  });
  let devices = null;
  let groups = [];
  if (!exit) {
    // A supervisor that died never stopped its children or its device.
    groups = await killRecordedGroups(inFlight.runDir, "SIGKILL", deps);
    const ctx = hkCtx(deps, knobs, repoRoot);
    devices = await stopAllDevices(ctx, readIosSimUdid(repoRoot, deps.fs));
  }
  const finished = await finishLedgerRun(ledgerFile, inFlight.runId, {
    refund: c.refund,
    last: lastFor(inFlight, c.state, now),
  });
  const reaped = await reapIdle({ repoRoot, runRoot, knobs, now }, deps);
  return {
    ...base,
    state: poll.state,
    outcome: c.state,
    refund: c.refund,
    runDir: inFlight.runDir,
    ...(devices ? { devices, groups } : {}),
    ...(finished ? {} : { finishedElsewhere: true }),
    reaped,
  };
}

export async function runStatus({ repoRoot, now }, deps) {
  const ledger = await loadLedger(ledgerPath(repoRoot));
  const inFlight = ledger.inFlight;
  if (!inFlight) return { state: "idle", last: ledger.last };
  const poll = await pollRun(inFlight, { now: now ?? deps.now() }, deps);
  const output = inFlight.runDir
    ? parseJson(readText(deps.fs, path.join(inFlight.runDir, OUTPUT_FILE)), null)
    : null;
  const platforms = {};
  for (const [p, v] of Object.entries(output?.platforms ?? {})) {
    platforms[p] = { state: v.state, verdict: v.verdict, flows: v.flows?.length ?? 0 };
  }
  return { state: poll.state, inFlight, platforms, last: ledger.last };
}

// ── render ──────────────────────────────────────────────────────────────────

function mdCell(s) {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

/** device-output.json as Markdown (a stand-in until PR 3's report renderer). */
export function renderOutput(output) {
  if (!output) return "No device-output.json in this run dir.\n";
  const lines = [
    `### Device lane: run \`${mdCell(output.runId)}\``,
    "",
    `Commit \`${String(output.sha ?? "").slice(0, 12)}\` · mode ${mdCell(output.mode)} · trigger ${mdCell(output.trigger)} · started ${mdCell(output.startedAt)} · finished ${mdCell(output.finishedAt ?? "not yet")}`,
    "",
    "| Platform | State | Verdict | Build | Flows |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const [p, v] of Object.entries(output.platforms ?? {})) {
    const build = v.build
      ? `${v.build.cached ? "cached" : "prebuilt"}, ${v.build.durationS}s`
      : "-";
    lines.push(
      `| ${mdCell(p)} | ${mdCell(v.state)} | ${mdCell(v.verdict ?? "-")} | ${mdCell(build)} | ${(v.flows ?? []).length} |`,
    );
  }
  for (const [p, v] of Object.entries(output.platforms ?? {})) {
    if (!v.flows?.length) continue;
    lines.push("", `**${mdCell(p)}**`, "");
    for (const f of v.flows) {
      lines.push(
        `- ${mdCell(f.status)} \`${mdCell(f.name)}\`${f.durationS != null ? ` (${f.durationS}s)` : ""}${f.failure ? `: ${mdCell(f.failure)}` : ""}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

// ── selftest ────────────────────────────────────────────────────────────────

function javaMajor(text) {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(String(text ?? ""));
  if (!m) return null;
  const major = Number(m[1]);
  return major === 1 && m[2] ? Number(m[2]) : major;
}

/** Read-only checks of the lane's setup. {ok, checks: [{name, ok, detail}]} */
export async function runSelftestChecks({ repoRoot, platforms }, deps) {
  const knobs = await withJavaHome(readDeviceKnobs(deps.env), deps);
  const bins = resolveDeviceBins({ env: deps.env, isExecutable: deps.isExecutable, knobs });
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
  add("build volume", volumeMounted(deps.fs, knobs.volume), knobs.volume);
  for (const name of [...COMMON_BINS, ...platforms.flatMap((p) => PLATFORM_BINS[p])]) {
    add(`bin ${name}`, bins[name], bins[name] ?? "not found");
  }
  // Maestro's JVM on both platforms (17+); gradle's on Android (17–24).
  const gradle = platforms.includes("android");
  const javaName = gradle ? "java 17–24" : "java 17+";
  if (bins.java) {
    const r = await deps.exec(bins.java, ["-version"], { timeoutMs: QUICK_MS });
    const major = javaMajor(`${r.stdout}\n${r.stderr}`);
    add(
      javaName,
      major !== null && major >= 17 && (!gradle || major <= 24),
      major ? `java ${major} (${knobs.javaHome})` : "unknown version",
    );
  } else {
    add(javaName, false, "no FACTORY_DEVICE_JAVA_HOME and java_home found none");
  }
  if (platforms.includes("android")) {
    add(`AVD ${AVD_NAME}`, avdExists(knobs, deps.fs), knobs.avdHome);
    add("debug keystore", deps.fs.existsSync(knobs.keystore), knobs.keystore);
  }
  if (platforms.includes("ios")) {
    const udid = readIosSimUdid(repoRoot, deps.fs);
    if (!udid) add("simulator UDID", false, `no iosSimUdid in ${deviceConfigPath(repoRoot)}`);
    else if (!bins.xcrun) add("simulator UDID", false, "no xcrun");
    else {
      const ctx = hkCtx(deps, knobs, repoRoot);
      const st = await simState(ctx, udid);
      add("simulator UDID", st?.exists, st?.exists ? `${udid} (${st.state})` : `${udid} not found`);
    }
  }
  const volFree = volumeMounted(deps.fs, knobs.volume) ? await deps.freeDiskGb(knobs.volume) : null;
  add(
    "volume free",
    volFree !== null && volFree >= knobs.minFreeGb,
    `${volFree ?? "?"} GB (need ${knobs.minFreeGb})`,
  );
  const home = deps.env?.HOME || os.homedir();
  const rootFree = await deps.freeDiskGb(home);
  add(
    "root disk free",
    rootFree !== null && rootFree >= knobs.rootMinFreeGb,
    `${rootFree ?? "?"} GB (need ${knobs.rootMinFreeGb})`,
  );
  const pressure = await deps.memoryPressure();
  add("memory pressure", pressure === null || pressure < 2, `level ${pressure ?? "?"}`);
  const envProblem = devEnvProblem(
    readText(deps.fs, path.join(repoRoot, "apps", "mobile", ".env")),
  );
  add("apps/mobile/.env is dev", !envProblem, envProblem ?? DEV_REF);
  const acct = deviceAccountProblem(knobs.accountFile, deps.fs);
  add("device account file", !acct, acct ?? "mode 600, email and password set");
  const beta = betaBuildBusy(betaLockPaths(deps.env), deps);
  add("no beta build running", !beta, beta ? `${beta.lock} (pid ${beta.pid})` : "");
  const lock = lockHolder(deviceLockPath(knobs), deps);
  add("device lock free", !lock.alive, lock.alive ? `pid ${lock.pid}` : "");
  return { ok: checks.every((c) => c.ok), checks, knobs, bins };
}

export function selftestTable(checks) {
  const width = Math.max(...checks.map((c) => c.name.length));
  return `${checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}`).join("\n")}\n`;
}

/**
 * selftest --build: origin/main, built, checked, booted, installed, one flow
 * that needs no sign-in, shut down. In the foreground, holding the device lock.
 */
export async function runSelftestBuild({ repoRoot, platform, runRoot }, deps) {
  const knobs = await withJavaHome(readDeviceKnobs(deps.env), deps);
  const deferred = await deferReason({ knobs, lockPaths: betaLockPaths(deps.env) }, deps);
  if (deferred) return { ok: false, reason: deferred.reason };
  const bins = resolveDeviceBins({ env: deps.env, isExecutable: deps.isExecutable, knobs });
  const missing = missingBins(bins, [platform]);
  if (missing.length) return { ok: false, reason: `${missing[0]}-missing` };
  const lockFile = deviceLockPath(knobs);
  if (!takePidLock(lockFile, deps.pid, deps).ok) return { ok: false, reason: "deferred:busy" };
  try {
    const fetched = await deps.git(["fetch", "--quiet", "origin", "main"], { cwd: repoRoot });
    if (fetched.code !== 0) return { ok: false, reason: "fetch-failed" };
    const sha = (await deps.git(["rev-parse", "origin/main"], { cwd: repoRoot })).stdout.trim();
    if (!SHA40.test(sha)) return { ok: false, reason: "no-origin-main" };
    await ensureDeviceWorktrees({ repoRoot, sha, platforms: [platform], knobs }, deps);
    const now = deps.now();
    const runId = `selftest-${platform}-${isoSeconds(now).replace(/[-:]/g, "")}`;
    const runDir = path.join(runRoot ?? defaultRunRoot(repoRoot), runId);
    deps.fs.mkdirSync(path.join(runDir, "private"), { recursive: true, mode: 0o700 });
    deps.fs.mkdirSync(path.join(runDir, "evidence"), { recursive: true, mode: 0o700 });
    const meta = {
      runId,
      issue: null,
      pr: null,
      sha,
      mode: "smoke",
      trigger: "on-demand",
      startedAt: isoSeconds(now),
      deadlineAt: addMinutes(now, knobs.runMaxMin),
      repoRoot,
      runDir,
      order: [platform],
      platforms: { [platform]: { flows: [SELFTEST_FLOW] } },
      needsAccount: false,
      iosSimUdid: readIosSimUdid(repoRoot, deps.fs),
      bins,
      knobs,
      paths: {
        accountFile: null,
        envSource: path.join(repoRoot, "apps", "mobile", ".env"),
        deviceLock: lockFile,
        betaLocks: betaLockPaths(deps.env),
        module: THIS_FILE,
      },
    };
    const output = initialOutput(meta);
    const outFile = path.join(runDir, OUTPUT_FILE);
    const save = () => writeJsonAtomic(deps.fs, outFile, output);
    const status = { terminated: false, timedOut: false, child: null, stopReason: null };
    const log = (line) => appendLog(path.join(runDir, "supervisor.log"), line);
    const ctx = makeCtx({ deps, meta, runDir, status, output, save, account: null, log });
    // In the foreground: Ctrl-C (or a SIGTERM) stops the step's process group
    // and unwinds through the checkpoints, so the device still goes down.
    const onSignal = () => {
      status.terminated = true;
      log("stop signal received");
      killGroup(deps, status.child);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      await runPlatform(ctx, platform, {
        flows: [SELFTEST_FLOW],
        account: null,
        needsAccount: false,
      });
    } catch (err) {
      output.platforms[platform].state = err instanceof Interrupt ? err.state : `failed:error`;
      log(`selftest ended early: ${err.message}`);
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      await stopAllDevices(ctx, meta.iosSimUdid);
      rmQuiet(deps.fs, path.join(runDir, PGIDS_FILE));
      if (!knobs.keepRaw) rmQuiet(deps.fs, path.join(runDir, "private"));
      output.finishedAt = isoSeconds(deps.now());
      save();
    }
    const entry = output.platforms[platform];
    return { ok: entry.state === "done" && entry.verdict === "PASS", runDir, platform: entry };
  } finally {
    releasePidLock(lockFile, deps.pid, deps);
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE =
  "usage: device-lane.mjs <start --issue N --pr P --sha S [--platforms ios,android] [--mode smoke] " +
  "[--trigger testing|on-demand] [--force-attempt]|status|stop --issue N [--reason R]|housekeeping|" +
  "selftest [--platform android|ios] [--build]|render --run-dir D|_supervise --run-dir D> " +
  "[--repo-root R] [--run-root D] [--dry-run 1] [--now ISO]";

class UsageError extends Error {}

/** parseFlags with the lane's value-less switches pulled out first. */
export function parseArgv(argv) {
  const switches = {};
  const rest = [];
  for (const a of argv) {
    const name = a.startsWith("--") ? a.slice(2) : null;
    if (name && BOOLEAN_FLAGS.has(name)) switches[name] = true;
    else rest.push(a);
  }
  const { flags } = parseFlags(rest);
  return { ...flags, ...switches };
}

export async function main(argv, deps = createDeviceDeps()) {
  const [sub, ...rest] = argv;
  const flags = parseArgv(rest);
  const repoRoot = path.resolve(flags["repo-root"] ?? process.cwd());
  const common = {
    repoRoot,
    runRoot: flags["run-root"] ? path.resolve(flags["run-root"]) : undefined,
    dryRun: flags["dry-run"] === "1" || flags["dry-run"] === "true",
    now: flags.now,
  };
  switch (sub) {
    case "start": {
      for (const name of ["issue", "pr", "sha"])
        if (!flags[name]) throw new UsageError(`missing --${name}`);
      if (!SHA40.test(flags.sha)) throw new UsageError(`--sha must be a 40-hex SHA: ${flags.sha}`);
      if (!/^\d+$/.test(flags.issue) || !/^\d+$/.test(flags.pr)) {
        throw new UsageError("--issue and --pr must be numbers");
      }
      try {
        parsePlatforms(flags.platforms);
      } catch (err) {
        throw new UsageError(err.message);
      }
      try {
        return await runStart(
          {
            ...common,
            issue: flags.issue,
            pr: flags.pr,
            sha: flags.sha,
            platforms: flags.platforms,
            mode: flags.mode,
            trigger: flags.trigger,
            forceAttempt: Boolean(flags["force-attempt"]),
          },
          deps,
        );
      } catch (err) {
        return { started: false, reason: "error", error: err.message };
      }
    }
    case "status":
      return runStatus(common, deps);
    case "stop":
      if (!flags.issue) throw new UsageError("missing --issue");
      return runStop({ ...common, issue: flags.issue, reason: flags.reason }, deps);
    case "housekeeping":
      try {
        return await runHousekeeping(common, deps);
      } catch (err) {
        return { state: "error", error: err.message };
      }
    case "render": {
      if (!flags["run-dir"]) throw new UsageError("missing --run-dir");
      const output = parseJson(readText(deps.fs, path.join(flags["run-dir"], OUTPUT_FILE)), null);
      return { text: renderOutput(output) };
    }
    case "selftest": {
      const platforms = flags.platform ? parsePlatforms(flags.platform) : [...PLATFORMS];
      const checks = await runSelftestChecks({ repoRoot, platforms }, deps);
      if (!flags.build) {
        return flags.json
          ? { ok: checks.ok, checks: checks.checks, exitCode: checks.ok ? 0 : 2 }
          : { text: selftestTable(checks.checks), exitCode: checks.ok ? 0 : 2 };
      }
      if (platforms.length !== 1)
        throw new UsageError("selftest --build needs --platform android|ios");
      const built = await runSelftestBuild(
        { repoRoot, platform: platforms[0], runRoot: common.runRoot },
        deps,
      );
      return {
        text: `${selftestTable(checks.checks)}\n${JSON.stringify(built, null, 2)}\n`,
        exitCode: built.ok ? 0 : 2,
      };
    }
    case "_supervise":
      if (!flags["run-dir"]) throw new UsageError("missing --run-dir");
      await runSupervise({ runDir: flags["run-dir"] }, { deps });
      return null;
    default:
      throw new UsageError(sub ? `unknown subcommand: ${sub}` : "missing subcommand");
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => {
      if (out == null) return;
      const { exitCode, text, ...rest } = out;
      if (typeof text === "string") process.stdout.write(text);
      else process.stdout.write(JSON.stringify(rest) + "\n");
      if (Number.isInteger(exitCode) && exitCode !== 0) process.exitCode = exitCode;
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message, usage: USAGE }) + "\n");
      process.exit(1);
    },
  );
}
