#!/usr/bin/env node
// Phase-D beta-channel dispatch for the dark factory.
//
// After --release squash-merges an Approved card at Phase D, this module kicks
// off beta builds for the native platforms the PR changed. Per
// docs/operations/builds-and-releases.md, the CI release workflows are
// non-functional and "all builds run locally via Fastlane", so this dispatches
// the SAME local lanes the operator runs by hand, detached (fire-and-forget) on
// the Mac mini — it never blocks the 5-min tick. The Fastlane post-hook
// (comment-released-issues.mjs) posts the "now live" notice when a build lands.
//
// BETA CHANNELS ONLY. Production store lanes (release:prod:* / *:production /
// production-release.yml) are NEVER constructed, and assertBetaOnly() throws if
// one is ever passed — a code invariant, not just a convention.
//
// Functions:
//   derivePlatforms(diffFiles) → {mobile, desktop, web}   (pure)
//        Map a newline-separated `gh pr diff --name-only` list to changed
//        platforms. apps/mobile/→mobile, apps/desktop/→desktop, apps/web/→web,
//        packages/shared/→both native (shared ships to both apps). web is
//        informational only — Vercel auto-deploys main, nothing to dispatch.
//   platformsToLanes(platforms) → [{id, cwd, command, args}]   (pure)
//        mobile → apps/mobile `pnpm release:beta:all` (iOS TestFlight + Android
//        internal); desktop → apps/desktop `pnpm release:beta` (macOS TestFlight).
//   assertBetaOnly(lane)
//        Throws if the lane resolves to a production command.
//   resolveLaneRoot(lane, {repoRoot, desktopRoot, env})   (pure)
//        The checkout a lane builds from. Desktop does NOT build from repoRoot —
//        see the fossil rule below.
//   assertDesktopFossil(root)
//        Throws unless <root>/node_modules/react is 19.1.x.
//   dispatchLanes({repoRoot, desktopRoot, diffFiles|platforms, dryRun, only})
//        → {dispatched[], failed[], skipped[], platforms}   (ASYNC)
//        Derive → assert → spawn each lane detached, resolving only once the OS
//        confirms the process started. dryRun records without spawning.
//        dispatched[] = confirmed started (carries pid, logPath, exitPath);
//        failed[] = could not start (must not suppress a retry);
//        skipped[] = a guard refused it. `only` restricts to a subset of lane
//        ids so a caller can re-dispatch just the missing ones.
//
// ⚠️  THE DESKTOP FOSSIL. react-native-macos@0.81 needs React 19.1.x, but the
// monorepo declares 19.2.x (mobile needs it; React must be one instance). A
// desktop build from a checkout carrying 19.2 COMPILES FINE AND CRASHES AT
// RUNTIME (Hermes EXC_BAD_ACCESS / blank screen), so a green build is no proof.
// The factory's own checkout is a normal install and therefore carries 19.2 —
// dispatching the desktop lane under repoRoot ships a broken build. Desktop
// lanes resolve to DESKTOP_FOSSIL_ROOT_DEFAULT (or DRAFTO_DESKTOP_BUILD_ROOT)
// instead, and assertDesktopFossil() enforces the invariant at dispatch time.
// See docs/operations/desktop-build-fossil.md and ADR-0027.
//
// CLI (called from scripts/factory-agent.sh --release):
//   derive-platforms (--diff-file <path|-> | --diff <str>)
//   dispatch (--diff-file <path|-> | --platforms mobile,desktop) [--repo-root <dir>]
//           [--desktop-root <dir>]
//
// Prints JSON to stdout and exits 0; errors print {"error": "..."} to stderr and
// exit non-zero — same shape as factory-project.mjs / state-cli.mjs.

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, openSync, appendFileSync, rmSync, closeSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

export const DEFAULT_REPO_ROOT = ".";

// The only checkout whose node_modules can build a working macOS app: the
// primary checkout, installed before the React 19.2 bump and never reinstalled.
// Override with DRAFTO_DESKTOP_BUILD_ROOT (e.g. a clonefile replica of it).
export const DESKTOP_FOSSIL_ROOT_DEFAULT = "/Users/jakub/code/drafto";

// react-native-macos@0.81 pairs with React 19.1.x. Hardcoded because the repo
// has no declared source of truth for it — package.json's override pins 19.2.6
// for mobile, and the working desktop version exists only in the fossil
// node_modules on disk. Bump this (and ADR-0027) when react-native-macos moves.
export const DESKTOP_REACT_RANGE = /^19\.1\./;

// Production lanes the factory must NEVER auto-invoke (beta channels only —
// production store submission stays a manual, explicitly-approved step per
// CLAUDE.md "Release Authorization").
const PROD_DENYLIST = [
  /release:prod\b/i,
  /release:production\b/i,
  /production-release\.yml/i,
  /fastlane\s+\w+\s+production/i,
];

let _spawnForTests = null;
export function _setSpawnForTests(impl) {
  _spawnForTests = impl;
}

// Pure: changed native platforms from a `gh pr diff --name-only` list.
export function derivePlatforms(diffFiles) {
  const lines = String(diffFiles ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let mobile = false;
  let desktop = false;
  let web = false;
  for (const f of lines) {
    if (/^apps\/mobile\//.test(f)) mobile = true;
    else if (/^apps\/desktop\//.test(f)) desktop = true;
    else if (/^apps\/web\//.test(f)) web = true;
    else if (/^packages\/shared\//.test(f)) {
      mobile = true;
      desktop = true;
    }
  }
  return { mobile, desktop, web };
}

// Pure: beta lanes for the changed native platforms. web is intentionally absent
// (no dispatch — Vercel auto-deploys main on merge).
export function platformsToLanes(platforms) {
  const lanes = [];
  if (platforms?.mobile) {
    lanes.push({ id: "mobile", cwd: "apps/mobile", command: "pnpm", args: ["release:beta:all"] });
  }
  if (platforms?.desktop) {
    lanes.push({ id: "desktop", cwd: "apps/desktop", command: "pnpm", args: ["release:beta"] });
  }
  return lanes;
}

export function assertBetaOnly(lane) {
  const s = `${lane.command} ${(lane.args ?? []).join(" ")}`;
  for (const re of PROD_DENYLIST) {
    if (re.test(s)) throw new Error(`refusing to dispatch a non-beta lane: ${s}`);
  }
}

// Pure: which checkout a lane builds from. Everything builds from repoRoot
// except desktop, which must come from a fossil checkout (see the header note).
export function resolveLaneRoot(lane, { repoRoot = DEFAULT_REPO_ROOT, desktopRoot, env } = {}) {
  if (lane?.id !== "desktop") return repoRoot;
  const e = env ?? process.env;
  return desktopRoot || e.DRAFTO_DESKTOP_BUILD_ROOT || DESKTOP_FOSSIL_ROOT_DEFAULT;
}

// Throw unless `root` is a fossil checkout. This is the enforcement point for
// the rule in docs/operations/desktop-build-fossil.md: a `pnpm install` in the
// build root (or building from a fresh checkout / worktree / CI) silently
// replaces React 19.1 with 19.2 and produces a crashing app. Refuse loudly
// instead of shipping it.
export function assertDesktopFossil(root, { readFile = readFileSync } = {}) {
  const pkgPath = join(root, "node_modules", "react", "package.json");
  let version;
  try {
    version = JSON.parse(readFile(pkgPath, "utf8")).version;
  } catch (err) {
    throw new Error(
      `desktop build root ${root} has no readable ${pkgPath} (${err.message}); ` +
        `expected a fossil checkout with React ${DESKTOP_REACT_RANGE.source}`,
    );
  }
  if (!DESKTOP_REACT_RANGE.test(String(version))) {
    throw new Error(
      `refusing to build desktop from ${root}: React ${version} is not 19.1.x. ` +
        `react-native-macos@0.81 compiles against 19.2 but crashes at runtime — ` +
        `build from the fossil checkout and never 'pnpm install' it ` +
        `(docs/operations/desktop-build-fossil.md).`,
    );
  }
  return version;
}

// Where a lane's combined stdout/stderr goes. Overridable so tests don't write
// into the repo. Falls back to the system temp dir if the log dir is unusable —
// losing the log is bad, but failing the dispatch over it is worse.
// `logKey` scopes the file to ONE dispatch. Keying on lane.id alone made every
// dispatch of a platform share one path, so: a re-dispatch after a new commit
// read the still-running old lane's exit code as its own; two In Test cards in
// the same tick clobbered each other; and the post-merge --release lane wrote
// the very file a pre-merge card was waiting on. Callers pass
// `<issue>-<sha12>` (pre-merge) or `release-<sha12>` (post-merge).
export function laneLogPath(lane, { logDir, logKey } = {}) {
  const dir = logDir || join(process.cwd(), "logs", "factory");
  const key = String(logKey ?? "");
  // The consumer (intest_check_lane_outcomes, in bash) reconstructs this path
  // from the same inputs rather than reading it back, so BOTH transformations
  // that used to live here were invisible to it: a silent tmpdir() relocation
  // and a character-sanitising rewrite. Neither is tolerable in a path that two
  // programs must agree on. The key is now REJECTED if it isn't already
  // path-safe, and a missing log dir is a hard failure — the caller turns both
  // into a failed lane, which retries, instead of a lane whose outcome file
  // nobody can find.
  if (key && !/^[A-Za-z0-9._-]+$/.test(key)) {
    throw new Error(`laneLogPath: unsafe logKey ${JSON.stringify(key)}`);
  }
  const name = `beta-lane-${lane.id}${key ? `-${key}` : ""}.log`;
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

// The parent's copy of the log fd: spawn() dups it into the child, so nothing
// else ever closes ours. Leaked once per lane on every path without this.
function closeLaneFd(fd) {
  if (typeof fd !== "number") return;
  try {
    closeSync(fd);
  } catch {
    /* already closed / never opened */
  }
}

// Single-quote a string for `sh -c`. The lane command is built in code (never
// from user input), but the log path comes from a caller-supplied directory.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Pure: the `sh -c` script for a lane. The lane's own exit code is written to
// <logPath>.exit the moment it finishes.
//
// Why a shell wrapper rather than an 'exit' listener: the dispatcher exits
// within milliseconds of spawning, and the lane runs detached for 20-40 minutes
// after that — there is no parent left to observe the exit. Without this file,
// a lane that fails at minute 20 is indistinguishable from one that succeeded,
// which is exactly how #463's iOS lane failed silently on an Apple HTTP 500.
export function laneShellScript(lane, logPath) {
  const cmd = [lane.command, ...(lane.args ?? [])].join(" ");
  return `${cmd}; echo $? > ${shQuote(`${logPath}.exit`)}`;
}

// Spawn a lane detached so a ~20-40 min Fastlane build never blocks the tick,
// and RESOLVE ONLY once the OS confirms the process actually started.
//
// Two failure modes this closes, both observed on #463:
//   - Output was `stdio: "ignore"`, so a lane that died on startup looked
//     identical to one building for 40 minutes.
//   - The function returned before the async 'error' event could fire, so an
//     unstartable lane was still reported as dispatched — and since the caller
//     records a retry-suppressing SHA off that report, the failure became
//     permanent.
// Now: 'spawn' → {ok:true}; 'error' → {ok:false, reason}. The caller can tell
// the difference, and only a confirmed start suppresses a retry.
async function realSpawnDetached(lane, { repoRoot, laneEnv, logDir, logKey }) {
  let logPath;
  try {
    logPath = laneLogPath(lane, { logDir, logKey });
  } catch (err) {
    // Unusable log dir or an unsafe key: fail the lane loudly. Relocating the
    // file would leave the bash-side outcome check reading a path that will
    // never exist, i.e. "still building" for ever.
    return { ok: false, reason: `cannot place lane log: ${err.message}` };
  }
  const exitPath = `${logPath}.exit`;
  // A stale .exit from a previous run would be read as this run's outcome.
  try {
    rmSync(exitPath, { force: true });
  } catch {
    // Best-effort. Callers include an ATTEMPT number in logKey precisely so a
    // retry never shares a path with the attempt it replaces — a lane declared
    // stale may still be alive (the check is a timeout, not a death
    // certificate) and would otherwise write its exit code over the retry's.
  }
  let out;
  try {
    out = openSync(logPath, "a");
  } catch {
    out = "ignore";
  }
  // Node converts only a SUBSET of uv_spawn errnos (ENOENT, EACCES, EAGAIN,
  // EMFILE, ENFILE, ENOSYS, EPERM) into the async 'error' event; the rest
  // (ENOTDIR, ELOOP, ENAMETOOLONG, EIO) are THROWN from spawn() itself. Unguarded
  // that escapes dispatchLanes, discarding lanes already confirmed started and
  // emitting no JSON at all — the caller sees a crash rather than a failed lane.
  let child;
  try {
    child = spawn("sh", ["-c", laneShellScript(lane, logPath)], {
      cwd: join(repoRoot, lane.cwd),
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, ...(laneEnv ?? {}) },
    });
  } catch (err) {
    closeLaneFd(out);
    try {
      appendFileSync(logPath, `lane ${lane.id} failed to start: ${err.message}\n`);
    } catch {
      process.stderr.write(`lane ${lane.id} failed to start: ${err.message}\n`);
    }
    return { ok: false, reason: err.message, logPath };
  }

  const outcome = await new Promise((resolve) => {
    child.once("spawn", () => resolve({ ok: true }));
    child.once("error", (err) => resolve({ ok: false, reason: err.message }));
  });

  // Keep a listener attached for the rest of the child's life: an 'error' after
  // a successful spawn would otherwise be rethrown and kill the dispatcher.
  child.on("error", (err) => {
    try {
      appendFileSync(logPath, `lane ${lane.id} error after start: ${err.message}\n`);
    } catch {
      process.stderr.write(`lane ${lane.id} error after start: ${err.message}\n`);
    }
  });

  if (!outcome.ok) {
    closeLaneFd(out);
    try {
      appendFileSync(logPath, `lane ${lane.id} failed to start: ${outcome.reason}\n`);
    } catch {
      process.stderr.write(`lane ${lane.id} failed to start: ${outcome.reason}\n`);
    }
    return { ok: false, reason: outcome.reason, logPath };
  }
  closeLaneFd(out);
  child.unref();
  return { ok: true, pid: child.pid, logPath, exitPath };
}

// Async because a lane is only counted as dispatched once the OS confirms it
// started. Returns three disjoint buckets:
//
//   dispatched — 'spawn' fired; the process exists and its exit code will land
//                in <logPath>.exit
//   failed     — the lane could not start at all; it must NOT suppress a retry
//   skipped    — a guard refused it before any spawn (fossil assertion)
//
// `only` restricts the run to a subset of lane ids, so a caller can re-dispatch
// just the lanes that are missing rather than re-running a successful one.
export async function dispatchLanes({
  repoRoot = DEFAULT_REPO_ROOT,
  desktopRoot,
  diffFiles,
  platforms,
  dryRun = false,
  env,
  laneEnv,
  logDir,
  logKey,
  only,
} = {}) {
  const plats = platforms ?? derivePlatforms(diffFiles);
  const onlySet = only ? new Set(only) : null;
  const lanes = platformsToLanes(plats).filter((l) => !onlySet || onlySet.has(l.id));
  const spawnFn = _spawnForTests ?? realSpawnDetached;
  const dispatched = [];
  const failed = [];
  const skipped = [];
  for (const lane of lanes) {
    assertBetaOnly(lane);
    const laneRoot = resolveLaneRoot(lane, { repoRoot, desktopRoot, env });
    // A failed guard skips only its own lane: a desktop checkout that lost its
    // fossil must not stop the mobile beta from shipping.
    if (lane.id === "desktop") {
      try {
        assertDesktopFossil(laneRoot);
      } catch (err) {
        skipped.push({ id: lane.id, root: laneRoot, reason: err.message });
        continue;
      }
    }
    const spawned = dryRun
      ? null
      : await spawnFn(lane, { repoRoot: laneRoot, laneEnv, logDir, logKey });
    // A spawn helper that reports {ok:false} did not start the lane. Anything
    // else — including a legacy test mock returning nothing — counts as started.
    if (spawned && spawned.ok === false) {
      failed.push({
        id: lane.id,
        root: laneRoot,
        reason: spawned.reason ?? "failed to start",
        ...(spawned.logPath ? { logPath: spawned.logPath } : {}),
      });
      continue;
    }
    dispatched.push({
      id: lane.id,
      cwd: lane.cwd,
      root: laneRoot,
      command: `${lane.command} ${lane.args.join(" ")}`,
      // Present when the spawn helper reports them — the log path is what makes
      // a dead lane diagnosable, and .exit is how its outcome is learned later.
      ...(spawned?.pid ? { pid: spawned.pid } : {}),
      ...(spawned?.logPath ? { logPath: spawned.logPath } : {}),
      ...(spawned?.exitPath ? { exitPath: spawned.exitPath } : {}),
    });
  }
  return { dispatched, failed, skipped, platforms: plats };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function readDiff(flags) {
  if (flags.diff !== undefined) return flags.diff;
  const src = flags["diff-file"];
  if (!src) throw new Error("requires --diff-file <path|-> or --diff <str>");
  if (src === "-") return readStdin();
  return readFileSync(src, "utf8");
}

function parsePlatforms(csv) {
  const set = new Set(
    String(csv)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return { mobile: set.has("mobile"), desktop: set.has("desktop"), web: set.has("web") };
}

async function main(argv) {
  const [sub, ...rawRest] = argv;
  // parseFlags requires a value for every flag by design, so pull the one bare
  // boolean out before handing it the rest.
  const dryRun = rawRest.includes("--dry-run");
  const rest = rawRest.filter((a) => a !== "--dry-run");
  const { flags } = parseFlags(rest);
  switch (sub) {
    case "derive-platforms":
      return derivePlatforms(await readDiff(flags));
    case "dispatch": {
      const platforms = flags.platforms ? parsePlatforms(flags.platforms) : undefined;
      const diffFiles = platforms ? undefined : await readDiff(flags);
      return dispatchLanes({
        repoRoot: flags["repo-root"] ?? DEFAULT_REPO_ROOT,
        desktopRoot: flags["desktop-root"],
        diffFiles,
        platforms,
        dryRun,
        logDir: flags["log-dir"],
        logKey: flags["log-key"],
      });
    }
    // Pre-merge dispatch from an In Test card's PR head. Same lanes and the same
    // beta-only invariant; the extra flags become env vars for the Fastlane
    // hooks so the resulting build is identifiable as a pre-merge test build
    // (release-notes prefix + the "build N is up" comment on the issue).
    case "dispatch-premerge": {
      const platforms = flags.platforms ? parsePlatforms(flags.platforms) : undefined;
      const diffFiles = platforms ? undefined : await readDiff(flags);
      const issue = flags.issue;
      if (!issue) throw new Error("dispatch-premerge requires --issue <n>");
      return dispatchLanes({
        repoRoot: flags["repo-root"] ?? DEFAULT_REPO_ROOT,
        desktopRoot: flags["desktop-root"],
        diffFiles,
        platforms,
        dryRun,
        logDir: flags["log-dir"],
        logKey: flags["log-key"],
        only: flags.only
          ? flags.only
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
        laneEnv: {
          DRAFTO_INTEST_ISSUE: String(issue),
          DRAFTO_INTEST_PR: String(flags.pr ?? ""),
          DRAFTO_INTEST_SHA: String(flags.sha ?? ""),
        },
      });
    }
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: dispatch-release.mjs <derive-platforms (--diff-file <path|-> | --diff <str>)|" +
          "dispatch (--diff-file <path|-> | --platforms mobile,desktop) [--repo-root <dir>] " +
          "[--desktop-root <dir>] [--log-dir <dir>] [--log-key <key>] [--dry-run]|" +
          "dispatch-premerge (same flags) --issue <n> [--pr <n>] [--sha <sha>] [--only <ids>]>\n",
      );
      return null;
    default:
      throw new Error(`Unknown subcommand: ${sub}`);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => {
      if (out === null || out === undefined) return;
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    },
  );
}
