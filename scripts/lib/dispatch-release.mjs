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
//   dispatchLanes({repoRoot, diffFiles|platforms, dryRun}) → {dispatched[], platforms}
//        Derive → assert → spawn each lane detached. dryRun records without
//        spawning. Returns the dispatched lane descriptors (JSON-serialisable).
//
// CLI (called from scripts/factory-agent.sh --release):
//   derive-platforms (--diff-file <path|-> | --diff <str>)
//   dispatch (--diff-file <path|-> | --platforms mobile,desktop) [--repo-root <dir>]
//
// Prints JSON to stdout and exits 0; errors print {"error": "..."} to stderr and
// exit non-zero — same shape as factory-project.mjs / state-cli.mjs.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

export const DEFAULT_REPO_ROOT = ".";

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

// Spawn a lane detached so a ~20-min Fastlane build never blocks the tick. The
// child inherits the factory's env (Phase-D prereq: MATCH_PASSWORD / ASC keys /
// keystore must be present in the Mac-mini launchd env — see the runbook).
function realSpawnDetached(lane, { repoRoot }) {
  const child = spawn(lane.command, lane.args, {
    cwd: join(repoRoot, lane.cwd),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

export function dispatchLanes({
  repoRoot = DEFAULT_REPO_ROOT,
  diffFiles,
  platforms,
  dryRun = false,
} = {}) {
  const plats = platforms ?? derivePlatforms(diffFiles);
  const lanes = platformsToLanes(plats);
  const spawnFn = _spawnForTests ?? realSpawnDetached;
  const dispatched = [];
  for (const lane of lanes) {
    assertBetaOnly(lane);
    if (!dryRun) spawnFn(lane, { repoRoot });
    dispatched.push({
      id: lane.id,
      cwd: lane.cwd,
      command: `${lane.command} ${lane.args.join(" ")}`,
    });
  }
  return { dispatched, platforms: plats };
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
  const [sub, ...rest] = argv;
  const { flags } = parseFlags(rest);
  switch (sub) {
    case "derive-platforms":
      return derivePlatforms(await readDiff(flags));
    case "dispatch": {
      const platforms = flags.platforms ? parsePlatforms(flags.platforms) : undefined;
      const diffFiles = platforms ? undefined : await readDiff(flags);
      return dispatchLanes({
        repoRoot: flags["repo-root"] ?? DEFAULT_REPO_ROOT,
        diffFiles,
        platforms,
      });
    }
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: dispatch-release.mjs <derive-platforms (--diff-file <path|-> | --diff <str>)|" +
          "dispatch (--diff-file <path|-> | --platforms mobile,desktop) [--repo-root <dir>]>\n",
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
