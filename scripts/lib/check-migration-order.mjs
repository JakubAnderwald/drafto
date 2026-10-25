#!/usr/bin/env node
// Migration order rule for `pnpm migration:check` (scripts/check-migration-safety.sh,
// ADR 0057): a migration a branch ADDS must sort after every migration on its base.
//
// `supabase db push` refuses a local migration whose version is older than the newest
// one already applied ("Found local migration files to be inserted before the last
// migration on remote database") unless it is forced with --include-all. PR #646 hit
// this: its 20260922000001 migration sat open while main gained 20261020000001.
//
// Only files that are present locally but absent from the base tree are judged. That
// covers untracked files, uncommitted files and CI's merge ref alike, and it leaves
// main's own history alone (it already holds that out-of-order pair).
//
// CLI:
//   node scripts/lib/check-migration-order.mjs --base <ref> [--dir supabase/migrations]
//
// Prints one tab-separated line per finding, in the shape the safety script renders:
//   <dir>/<file>\t<message>\tgit mv <dir>/<file> <dir>/<suggested>_<rest>.sql
// No output and exit 0 when clean. Exit 2 when <ref> does not resolve to a commit.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { posix } from "node:path";

import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

const VERSION_RE = /^(\d+)_(.+)$/;
const DEFAULT_DIR = "supabase/migrations";

// The leading digits of a `<version>_<name>.sql` file name, or null when it has none.
export function versionOf(fileName) {
  const match = VERSION_RE.exec(fileName);
  return match ? match[1] : null;
}

// YYYYMMDD of `date` in UTC, so the suggestion doesn't depend on the runner's zone.
function utcDay(date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

// The repo's next free version: today's first slot (YYYYMMDD000001), or one past
// the base's newest version when that is already today or later. Versions are
// compared as BigInt and returned as a 14-digit string.
export function suggestVersion(baseMax, today = new Date()) {
  const todayFirst = BigInt(`${utcDay(today)}000001`);
  const next = baseMax === null || baseMax === undefined ? 0n : BigInt(baseMax) + 1n;
  const pick = next > todayFirst ? next : todayFirst;
  return pick.toString().padStart(14, "0");
}

// Files in `localFiles` but not in `baseFiles` whose version is <= the newest base
// version. Each finding carries a suggested version that is unique: it skips every
// version already used locally and every earlier suggestion, so two stale files on
// one branch never get the same new name.
export function findOutOfOrder({ localFiles, baseFiles, today = new Date() }) {
  const baseSet = new Set(baseFiles);
  let baseMax = null;
  for (const name of baseFiles) {
    const version = versionOf(name);
    if (version !== null && (baseMax === null || BigInt(version) > baseMax)) {
      baseMax = BigInt(version);
    }
  }
  if (baseMax === null) return [];

  const taken = new Set();
  for (const name of [...localFiles, ...baseFiles]) {
    const version = versionOf(name);
    if (version !== null) taken.add(BigInt(version));
  }

  const stale = localFiles
    .filter((name) => !baseSet.has(name))
    .map((name) => ({ name, version: versionOf(name) }))
    .filter(({ version }) => version !== null && BigInt(version) <= baseMax)
    .sort((a, b) => {
      const diff = BigInt(a.version) - BigInt(b.version);
      if (diff !== 0n) return diff < 0n ? -1 : 1;
      return a.name < b.name ? -1 : 1;
    });

  const baseMaxText = baseMax.toString().padStart(14, "0");
  let floor = BigInt(suggestVersion(baseMax, today));
  return stale.map(({ name, version }) => {
    while (taken.has(floor)) floor += 1n;
    const suggested = floor.toString().padStart(14, "0");
    taken.add(floor);
    return { file: name, version, baseMax: baseMaxText, suggested };
  });
}

function git(args) {
  return spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

// File names (not paths) of the `*.sql` files directly under `dir` in `ref`'s tree.
function baseFileNames(ref, dir) {
  const res = git(["ls-tree", "-z", "--name-only", ref, "--", `${dir}/`]);
  if (res.status !== 0) {
    throw new Error(`git ls-tree ${ref} -- ${dir}/ failed: ${res.stderr.trim()}`);
  }
  return res.stdout
    .split("\0")
    .filter((path) => path.endsWith(".sql"))
    .map((path) => posix.basename(path));
}

function localFileNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".sql"));
}

// A full 40-hex SHA (CI passes one) reads better shortened in the message.
function refLabel(ref) {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

export function formatFinding(finding, { dir, ref }) {
  const rest = finding.file.slice(finding.version.length + 1);
  const path = `${dir}/${finding.file}`;
  const message =
    `new migration version ${finding.version} is not newer than ${refLabel(ref)}'s ` +
    `newest migration (${finding.baseMax}); supabase db push would refuse it`;
  const hint = `git mv ${path} ${dir}/${finding.suggested}_${rest}`;
  return `${path}\t${message}\t${hint}`;
}

function main(argv) {
  let flags;
  try {
    ({ flags } = parseFlags(argv));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const ref = flags.base;
  const dir = (flags.dir ?? DEFAULT_DIR).replace(/\/+$/, "");
  if (!ref) {
    process.stderr.write("Usage: check-migration-order.mjs --base <ref> [--dir <dir>]\n");
    return 2;
  }
  if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status !== 0) {
    process.stderr.write(`Base ref '${ref}' does not resolve to a commit.\n`);
    return 2;
  }
  let findings;
  try {
    findings = findOutOfOrder({
      localFiles: localFileNames(dir),
      baseFiles: baseFileNames(ref, dir),
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  for (const finding of findings) {
    process.stdout.write(`${formatFinding(finding, { dir, ref })}\n`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
