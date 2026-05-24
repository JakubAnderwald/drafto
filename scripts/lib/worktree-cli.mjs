#!/usr/bin/env node
// Headless git-worktree manager for the dark factory's --implement / --watch
// modes.
//
// The factory gives each In Progress issue its own worktree + branch so the
// two implement slots (slot 0 / slot 1) never stomp each other and the main
// checkout stays clean for the human. This module is pure git plumbing —
// deterministic branch / path naming plus worktree add / remove / list — and
// deliberately does NOT copy gitignored env files or run `pnpm install`.
// factory-agent.sh owns those side-effects so it can log, time, and fail them
// in the right place (see scripts/factory-prompt.md "Working directory").
//
// Naming conventions (must match scripts/factory-prompt.md + the proposal):
//   - branch:   factory/issue-<n>
//   - worktree: <repoRoot>/worktrees/factory-issue-<n>
//
// Commands (each prints a single JSON object, or an array for `list`):
//   add    --issue <n> [--base <ref>] [--root <repoRoot>]
//   remove --issue <n> [--root <repoRoot>] [--force] [--delete-branch]
//   path   --issue <n> [--root <repoRoot>]
//   list   [--root <repoRoot>]
//
// `add` is idempotent: if the worktree is already registered it's reused; if
// only the branch exists (a retry after a crashed run) the branch is
// re-attached to a fresh worktree so the prior commits / PR head carry over.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

// Canonicalise a path for comparison: git stores worktree paths fully
// resolved (e.g. macOS /var → /private/var), so a raw path.resolve compare
// would miss a registered worktree. Fall back to path.resolve when the path
// isn't on disk (a stale entry git hasn't pruned yet).
function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Default repo root: the checkout containing scripts/. factory-agent.sh always
// passes --root explicitly (REPO_ROOT), but the default keeps ad-hoc CLI use
// and unit tests honest.
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function branchForIssue(issueNumber) {
  return `factory/issue-${issueNumber}`;
}

export function worktreePathForIssue(root, issueNumber) {
  return path.join(root, "worktrees", `factory-issue-${issueNumber}`);
}

// Run git in `cwd`. Throws on non-zero unless allowFail is set, in which case
// the raw result (status + stdout + stderr) is returned for the caller to
// inspect. spawn failures (git missing) always throw.
function git(args, { cwd, allowFail = false } = {}) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.error) throw new Error(`git ${args.join(" ")} failed to spawn: ${res.error.message}`);
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} exited ${res.status}: ${(res.stderr || "").trim()}`);
  }
  return res;
}

// Parse `git worktree list --porcelain` into [{path, head, branch}]. The
// porcelain format is newline-delimited records separated by a blank line;
// `branch` is a full ref (refs/heads/...) or absent for a detached HEAD.
export function parseWorktreePorcelain(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice("worktree ".length), head: null, branch: null };
    } else if (line.startsWith("HEAD ") && cur) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length);
    } else if (line === "" && cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function listWorktrees(root = DEFAULT_ROOT) {
  const res = git(["worktree", "list", "--porcelain"], { cwd: root });
  return parseWorktreePorcelain(res.stdout);
}

// Only the factory's own worktrees (branch refs/heads/factory/issue-*).
export function listFactoryWorktrees(root = DEFAULT_ROOT) {
  return listWorktrees(root)
    .filter((w) => typeof w.branch === "string" && w.branch.startsWith("refs/heads/factory/issue-"))
    .map((w) => ({
      path: w.path,
      branch: w.branch.replace(/^refs\/heads\//, ""),
      issueNumber: Number(w.branch.replace(/^refs\/heads\/factory\/issue-/, "")) || null,
    }));
}

function branchExists(root, branch) {
  return (
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: root,
      allowFail: true,
    }).status === 0
  );
}

export function addWorktree({ root = DEFAULT_ROOT, issueNumber, base = "origin/main" } = {}) {
  if (issueNumber == null || issueNumber === "") {
    throw new Error("addWorktree requires issueNumber");
  }
  const branch = branchForIssue(issueNumber);
  const wtPath = worktreePathForIssue(root, issueNumber);

  // Clear stale registrations (dirs deleted out from under git) so a re-add
  // after an aborted run doesn't trip over a ghost entry.
  git(["worktree", "prune"], { cwd: root, allowFail: true });

  // Already registered at the canonical path → reuse as-is. This is the retry
  // path: --watch resumes in the same worktree --implement created.
  const existing = listWorktrees(root).find((w) => canonical(w.path) === canonical(wtPath));
  if (existing) {
    return { path: wtPath, branch, reused: true, created: false };
  }

  // A leftover directory that git doesn't know about would make `worktree add`
  // fail with an opaque "already exists". Surface it explicitly so the agent's
  // failure trap reports something actionable instead of looping.
  if (existsSync(wtPath)) {
    throw new Error(
      `worktree path exists but is not a registered worktree: ${wtPath}. ` +
        `Remove it manually (rm -rf) then retry.`,
    );
  }

  if (branchExists(root, branch)) {
    // Branch survived a prior run (commits / open PR). Re-attach it to a fresh
    // worktree rather than branching again — keeps the PR head ref continuous.
    git(["worktree", "add", wtPath, branch], { cwd: root });
    return { path: wtPath, branch, reused: false, created: true, branchReused: true };
  }

  git(["worktree", "add", "-b", branch, wtPath, base], { cwd: root });
  return { path: wtPath, branch, reused: false, created: true, branchReused: false };
}

export function removeWorktree({
  root = DEFAULT_ROOT,
  issueNumber,
  force = false,
  deleteBranch = false,
} = {}) {
  if (issueNumber == null || issueNumber === "") {
    throw new Error("removeWorktree requires issueNumber");
  }
  const branch = branchForIssue(issueNumber);
  const wtPath = worktreePathForIssue(root, issueNumber);

  const removeArgs = ["worktree", "remove"];
  if (force) removeArgs.push("--force");
  removeArgs.push(wtPath);
  // allowFail: an unregistered / already-gone worktree should be a no-op, not
  // an error — cleanup is meant to be safe to run repeatedly.
  const rm = git(removeArgs, { cwd: root, allowFail: true });
  git(["worktree", "prune"], { cwd: root, allowFail: true });

  let branchDeleted = false;
  if (deleteBranch) {
    // -D (not -d): the factory deletes the branch only when it's done with the
    // issue, and the PR has its own copy of the commits, so an "unmerged"
    // warning from -d is noise here.
    const br = git(["branch", "-D", branch], { cwd: root, allowFail: true });
    branchDeleted = br.status === 0;
  }

  return {
    removed: rm.status === 0,
    path: wtPath,
    branch,
    branchDeleted,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

// Local arg parser: parse-flags.mjs throws on value-less flags, but `add` /
// `remove` take the boolean flags --force / --delete-branch, so we walk argv
// directly here.
function parseArgs(argv) {
  const flags = {};
  const bools = new Set(["force", "delete-branch"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const eq = key.indexOf("=");
    if (eq !== -1) {
      flags[key.slice(0, eq)] = key.slice(eq + 1);
    } else if (bools.has(key)) {
      flags[key] = true;
    } else {
      flags[key] = argv[++i];
    }
  }
  return flags;
}

function main(argv) {
  const [sub, ...rest] = argv;
  const flags = parseArgs(rest);
  const root = flags.root ?? DEFAULT_ROOT;
  switch (sub) {
    case "add":
      return addWorktree({ root, issueNumber: flags.issue, base: flags.base ?? "origin/main" });
    case "remove":
      return removeWorktree({
        root,
        issueNumber: flags.issue,
        force: Boolean(flags.force),
        deleteBranch: Boolean(flags["delete-branch"]),
      });
    case "path":
      if (flags.issue == null) throw new Error("path requires --issue <n>");
      return { path: worktreePathForIssue(root, flags.issue), branch: branchForIssue(flags.issue) };
    case "list":
      return listFactoryWorktrees(root);
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: worktree-cli.mjs <add --issue <n> [--base <ref>] [--root <dir>]|" +
          "remove --issue <n> [--root <dir>] [--force] [--delete-branch]|" +
          "path --issue <n> [--root <dir>]|list [--root <dir>]>\n",
      );
      return null;
    default:
      throw new Error(`Unknown subcommand: ${sub}`);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const result = main(process.argv.slice(2));
    if (result !== null && result !== undefined) {
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
    process.exit(1);
  }
}
