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
// main's own history alone (it already holds that out-of-order pair). For each added
// file it reports:
//   - a version that isn't 14 digits (the Supabase CLI orders versions as strings, so
//     only equal-length versions sort the way they read);
//   - a version that a base file has under another name: a rename of a migration
//     main already has, which must be reverted, not renumbered;
//   - a version not newer than the base's newest, or shared with another file.
// When any added file needs a new version, the branch's added migrations are
// renumbered together, in their current order, so a stale CREATE never lands after
// the fresh ALTER that depends on it. Files that only move to keep that order are
// reported as `move`, not as errors.
//
// CLI:
//   node scripts/lib/check-migration-order.mjs --base <ref> [--dir supabase/migrations]
//
// Prints one tab-separated line per finding, in the shape the safety script renders:
//   <error|move>\t<dir>/<file>\t<message>\t[git mv <dir>/<file> <dir>/<new>_<name>.sql]
// The last field is empty when there is nothing to rename. No output and exit 0 when
// clean. Exit 2 when <ref> does not resolve to a commit.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { posix } from "node:path";

import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

const VERSION_RE = /^(\d+)_(.+)$/;
const VALID_NAME_RE = /^(\d{14})_(.+)$/;
const VERSION_DIGITS = 14;
const DEFAULT_DIR = "supabase/migrations";

// The leading digits of a `<version>_<name>.sql` file name, or null when it has none.
export function versionOf(fileName) {
  const match = VERSION_RE.exec(fileName);
  return match ? match[1] : null;
}

// True for `<14-digit version>_<name>` — the only shape whose string order (the
// Supabase CLI's) matches its numeric order.
export function isValidMigrationName(fileName) {
  return VALID_NAME_RE.test(fileName);
}

// YYYYMMDD of `date` in UTC, so the suggestion doesn't depend on the runner's zone.
function utcDay(date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

// The 14-digit version after `version`. 14 digits stay below 2^53, so Number is exact.
function nextVersion(version) {
  const next = String(Number(version) + 1).padStart(VERSION_DIGITS, "0");
  if (next.length !== VERSION_DIGITS) {
    throw new Error(`no 14-digit migration version follows ${version}`);
  }
  return next;
}

// Equal-length version strings compare the way the Supabase CLI orders them.
function later(a, b) {
  return a > b ? a : b;
}

// The repo's next free version: today's first slot (YYYYMMDD000001), or one past
// the base's newest version when that is already today or later. Always 14 digits.
export function suggestVersion(baseMax, today = new Date()) {
  const todayFirst = `${utcDay(today)}000001`;
  return baseMax ? later(nextVersion(baseMax), todayFirst) : todayFirst;
}

// The newest 14-digit version among `names` (migration file names), or null.
export function newestVersion(names) {
  let max = null;
  for (const name of names) {
    if (!isValidMigrationName(name)) continue;
    const version = versionOf(name);
    if (max === null || version > max) max = version;
  }
  return max;
}

// The 14-digit versions named by `entries`: versions, migration file names, or
// {file} objects such as claimedVersions() returns. Anything else is ignored.
function versionsIn(entries) {
  const out = new Set();
  for (const entry of entries ?? []) {
    const text =
      typeof entry === "string" ? entry : typeof entry?.file === "string" ? entry.file : "";
    const version = versionOf(text) ?? text;
    if (/^\d{14}$/.test(version)) out.add(version);
  }
  return out;
}

// The versions a card's new migrations take, in order (ADR-0079). Each is after
// main's newest, after the newest migration the card's own open PR already adds
// (`ownNames`, on a revision) and after today's 000000, and none is in
// `claimed`, which other open PRs already add. They are strictly increasing.
// The factory hands them to the implementer, so two cards implemented on the
// same day don't both pick <today>000001, and a revision's new migration sorts
// after the ones its PR already has.
export function allocateMigrationVersions({
  mainNames = [],
  ownNames = [],
  claimed = [],
  today = new Date(),
  count = 5,
} = {}) {
  const taken = versionsIn(claimed);
  const mainNewest = newestVersion(mainNames);
  const ownNewest = newestVersion(ownNames);
  const floor = mainNewest && ownNewest ? later(mainNewest, ownNewest) : (mainNewest ?? ownNewest);
  const versions = [];
  let version = suggestVersion(floor, today);
  while (versions.length < count) {
    while (taken.has(version)) version = nextVersion(version);
    versions.push(version);
    version = nextVersion(version);
  }
  return versions;
}

// version → {prs, files} of the open PRs whose claims (`{pr, file}` entries,
// versions or file names) name it.
function claimIndex(claims) {
  const by = new Map();
  for (const entry of claims ?? []) {
    for (const version of versionsIn([entry])) {
      const at = by.get(version) ?? { prs: [], files: [] };
      if (Number.isInteger(entry?.pr) && !at.prs.includes(entry.pr)) at.prs.push(entry.pr);
      if (typeof entry?.file === "string" && !at.files.includes(entry.file)) {
        at.files.push(entry.file);
      }
      by.set(version, at);
    }
  }
  return by;
}

function byVersionThenName(a, b) {
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return 0;
}

// Judges the files in `localFiles` that `baseFiles` lacks. Returns findings
// `{ kind: "error" | "move", reason, file, version?, suggested?, baseMax?, others?, after? }`:
//   shape         error  the version isn't 14 digits (no suggestion)
//   renamed-base  error  a base file with this version is gone locally (no suggestion)
//   duplicate-base error the version is also a base file's that is still present
//   stale         error  the version is not newer than the base's newest
//   duplicate     error  the version is also an earlier added file's
//   claimed       error  the version is one `moveOff` names, or `moveNewOff` for a
//                        file in `newFiles` (only when they're passed)
//   order         move   a fresh file renumbered to stay after a renamed one
// Every suggestion is free: it skips the versions of every local and base file and
// every earlier suggestion, so no `git mv` target collides with an existing file.
// `extraTaken` (versions or file names) only makes suggestions skip more versions:
// the factory passes the ones other open PRs use (ADR-0077). It never changes what
// is reported, so CI and the CLI, which don't pass it, behave as before.
// `moveOff` ({pr, file} entries, versions or file names) is the factory's
// implement post-check (ADR-0079): an added file whose version an older open PR
// already adds moves too, reported as `claimed` with that PR's `prs` and files
// (`others`). `moveNewOff` is the same for the files in `newFiles` only, the
// migrations the implement run itself added: they move off any open PR's
// version, and their finding has `addedInRun: true` unless `moveOff` also names
// the version. Both lists' versions are skipped like `extraTaken`'s. Nothing
// else passes them.
export function checkMigrationOrder({
  localFiles,
  baseFiles,
  today = new Date(),
  extraTaken = [],
  moveOff = [],
  moveNewOff = [],
  newFiles = [],
}) {
  const baseSet = new Set(baseFiles);
  const localSet = new Set(localFiles);
  const baseByVersion = new Map();
  let baseMax = null;
  for (const name of baseFiles) {
    if (!isValidMigrationName(name)) continue;
    const version = versionOf(name);
    baseByVersion.set(version, [...(baseByVersion.get(version) ?? []), name]);
    if (baseMax === null || version > baseMax) baseMax = version;
  }

  const findings = [];
  const candidates = [];
  for (const file of localFiles.filter((name) => !baseSet.has(name)).sort()) {
    if (!isValidMigrationName(file)) {
      findings.push({ kind: "error", reason: "shape", file });
      continue;
    }
    const version = versionOf(file);
    const sameVersionOnBase = baseByVersion.get(version) ?? [];
    const keptBase = sameVersionOnBase.filter((name) => localSet.has(name));
    if (sameVersionOnBase.length > 0 && keptBase.length === 0) {
      findings.push({
        kind: "error",
        reason: "renamed-base",
        file,
        version,
        others: sameVersionOnBase,
      });
      continue;
    }
    candidates.push({ file, version, keptBase });
  }
  candidates.sort(byVersionThenName);

  const claimedBy = claimIndex(moveOff);
  const newClaimedBy = claimIndex(moveNewOff);
  const newSet = new Set(newFiles ?? []);
  // The claims an added file moves off, or null: `moveOff`'s for any added
  // file, and `moveNewOff`'s for a file the implement run added.
  const claimOf = (c) => {
    const older = claimedBy.get(c.version);
    const any = newSet.has(c.file) ? newClaimedBy.get(c.version) : undefined;
    if (!older && !any) return null;
    const union = (key) => [...new Set([...(older?.[key] ?? []), ...(any?.[key] ?? [])])];
    return { prs: union("prs"), files: union("files"), addedInRun: !older };
  };
  const isStale = (c) => baseMax !== null && c.version <= baseMax;
  const isClaimed = (c) => claimOf(c) !== null;
  const uses = new Map();
  for (const c of candidates) uses.set(c.version, (uses.get(c.version) ?? 0) + 1);
  const needsRenumber = candidates.some(
    (c) => isStale(c) || c.keptBase.length > 0 || uses.get(c.version) > 1 || isClaimed(c),
  );
  if (!needsRenumber) return findings;

  const taken = new Set();
  for (const name of [...localFiles, ...baseFiles]) {
    if (isValidMigrationName(name)) taken.add(versionOf(name));
  }
  for (const version of versionsIn(extraTaken)) taken.add(version);
  for (const version of claimedBy.keys()) taken.add(version);
  for (const version of newClaimedBy.keys()) taken.add(version);
  const floor = suggestVersion(baseMax, today);
  const seen = new Map();
  let prev = baseMax;
  let prevFile = null;
  for (const c of candidates) {
    const earlier = seen.get(c.version) ?? [];
    seen.set(c.version, [...earlier, c.file]);
    // A fresh file already after the previous one keeps its version.
    if (
      !isStale(c) &&
      c.keptBase.length === 0 &&
      !isClaimed(c) &&
      (prev === null || c.version > prev)
    ) {
      prev = c.version;
      prevFile = c.file;
      continue;
    }
    let suggested = prev === null ? floor : later(nextVersion(prev), floor);
    while (taken.has(suggested)) suggested = nextVersion(suggested);
    taken.add(suggested);
    const base = { file: c.file, version: c.version, suggested, baseMax };
    if (c.keptBase.length > 0) {
      findings.push({ kind: "error", reason: "duplicate-base", ...base, others: c.keptBase });
    } else if (isStale(c)) {
      findings.push({ kind: "error", reason: "stale", ...base });
    } else if (isClaimed(c)) {
      const by = claimOf(c);
      findings.push({
        kind: "error",
        reason: "claimed",
        ...base,
        others: by.files,
        prs: by.prs,
        ...(by.addedInRun ? { addedInRun: true } : {}),
      });
    } else if (earlier.length > 0) {
      findings.push({ kind: "error", reason: "duplicate", ...base, others: earlier });
    } else {
      findings.push({ kind: "move", reason: "order", ...base, after: prevFile });
    }
    prev = suggested;
    prevFile = c.file;
  }
  return findings;
}

function git(args) {
  return spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

// File names (not paths) of the `*.sql` files directly under `dir` in `ref`'s
// tree. `git ls-tree` without -r lists only that directory's own entries, so a
// file in a subdirectory never counts. This is the one lister of a tree's
// migrations: CI's check (below), the conflict pass (worktree-cli.mjs) and the
// renumber gate (migration-renumber.mjs, ADR-0077) all read them through it.
// `cwd` is the repo to read (default: this process's), `env` the git
// environment (default: this process's). Throws when git fails.
export function migrationNamesAt(ref, { cwd, dir = DEFAULT_DIR, env } = {}) {
  const res = spawnSync("git", ["ls-tree", "-z", "--name-only", ref, "--", `${dir}/`], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    const why = String(res.stderr || res.error?.message || "").trim();
    throw new Error(`git ls-tree ${ref} -- ${dir}/ failed: ${why}`);
  }
  return res.stdout
    .split("\0")
    .filter((path) => path.endsWith(".sql"))
    .map((path) => posix.basename(path));
}

// The same names from a recursive path list, such as `git ls-files`: the
// `*.sql` paths whose directory is exactly `dir`, as file names, deduplicated
// (an unmerged path is listed once per stage).
export function directMigrationNames(paths, dir = DEFAULT_DIR) {
  return [
    ...new Set(
      paths
        .filter((path) => path.endsWith(".sql") && posix.dirname(path) === dir)
        .map((path) => posix.basename(path)),
    ),
  ];
}

// The `*.sql` file names in the working tree's `dir`: what the checkout holds,
// committed or not. Exported for migration-renumber.mjs's claimed-check.
export function localFileNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".sql"));
}

// A full 40-hex SHA (CI passes one) reads better shortened in the message.
function refLabel(ref) {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

// "open PR #829", "open PRs #829, #830", or "another open PR" with no numbers.
export function openPrs(prs = []) {
  const list = (prs ?? []).filter((n) => Number.isInteger(n));
  if (list.length === 0) return "another open PR";
  return `open PR${list.length > 1 ? "s" : ""} ${list.map((n) => `#${n}`).join(", ")}`;
}

function messageFor(finding, label) {
  const others = (finding.others ?? []).join(", ");
  switch (finding.reason) {
    case "shape":
      return "version must be 14 digits, YYYYMMDDHHMMSS (name it <version>_<name>.sql)";
    case "renamed-base":
      return (
        `renames ${others}, which ${label} already has — migration files on main ` +
        "must not be renamed; revert the rename"
      );
    case "duplicate-base":
      return (
        `new migration version ${finding.version} is already used by ${others}, which ` +
        `${label} has; it must be newer than ${label}'s newest migration (${finding.baseMax})`
      );
    case "stale":
      return (
        `new migration version ${finding.version} is not newer than ${label}'s newest ` +
        `migration (${finding.baseMax}); supabase db push would refuse it`
      );
    case "duplicate":
      return `version ${finding.version} is also used by ${others}; every migration needs its own version`;
    case "claimed":
      return (
        `version ${finding.version} is also used by ${openPrs(finding.prs)}` +
        `${others ? ` (${others})` : ""}; ` +
        (finding.addedInRun ? "this run added it, so it moves" : "the newer PR moves")
      );
    case "order":
      return `renumbered to stay after ${finding.after}`;
    default:
      throw new Error(`unknown finding reason: ${finding.reason}`);
  }
}

export function formatFinding(finding, { dir, ref }) {
  const path = `${dir}/${finding.file}`;
  const rename = finding.suggested
    ? `git mv ${path} ${dir}/${finding.suggested}_${VALID_NAME_RE.exec(finding.file)[2]}`
    : "";
  return [finding.kind, path, messageFor(finding, refLabel(ref)), rename].join("\t");
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
    findings = checkMigrationOrder({
      localFiles: localFileNames(dir),
      baseFiles: migrationNamesAt(ref, { dir }),
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
