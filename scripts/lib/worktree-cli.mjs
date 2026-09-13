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
//   add    --issue <n> [--base <ref>] [--root <repoRoot>] [--fetch]
//   remove --issue <n> [--root <repoRoot>] [--force] [--delete-branch]
//   path   --issue <n> [--root <repoRoot>]
//   list   [--root <repoRoot>]
//
// `add` is idempotent, resolving the branch in four tiers so a revision run
// always lands on the PR's own commits:
//   1. the worktree is already registered  → reuse it as-is
//   2. the local branch exists             → re-attach it (with --fetch, first
//                                            reconciled against origin: behind
//                                            defers to tier 3, ahead is kept,
//                                            diverged throws)
//   3. --fetch and origin has the branch   → fetch + branch from origin/<b>
//   4. otherwise                           → create it from <base>
//
// Tier 3 exists because factory-agent.sh deletes the local branch when a card
// leaves its active states, which used to silently drop the factory to tier 4
// and branch a revision run off origin/main — producing a worktree with none
// of the open PR's commits. `git ls-remote` is the liveness probe (it asks the
// remote directly, so a stale remote-tracking ref can't fool it), and an
// unreachable remote is fatal rather than falling through to <base>: branching
// from the wrong base is the data-loss path, and factory-agent.sh handles an
// `add` failure by releasing the slot without burning retry budget.

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

// Cap on the git calls that touch the network. Without it a black-holed
// connection blocks spawnSync forever, and because factory-agent-loop.sh only
// reaps a lock whose owning PID is dead, a hung tick stops the entire pipeline
// silently — every later tick exits on the still-held mutex.
const NETWORK_TIMEOUT_MS = Number(process.env.FACTORY_GIT_NETWORK_TIMEOUT_MS ?? 60000);

// Run git in `cwd`. Throws on non-zero unless allowFail is set, in which case
// the raw result (status + stdout + stderr) is returned for the caller to
// inspect. spawn failures (git missing) always throw. Pass timeoutMs for any
// call that reaches the network.
function git(args, { cwd, allowFail = false, timeoutMs } = {}) {
  const opts = { cwd, encoding: "utf8" };
  if (timeoutMs) {
    opts.timeout = timeoutMs;
    // launchd gives the factory no tty, so a credential or host-key prompt
    // would hang until the timeout instead of failing fast. Refuse to prompt.
    opts.env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes",
    };
  }
  const res = spawnSync("git", args, opts);
  // A timeout kills the child and reports through res.error. Surface it as an
  // ordinary failure for allowFail callers so they can classify it (the remote
  // probe maps it to "unreachable", which fails closed) rather than having it
  // throw straight past their handling.
  if (res.error && allowFail) {
    return {
      ...res,
      status: typeof res.status === "number" ? res.status : 128,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? String(res.error.message ?? res.error),
    };
  }
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

// Does origin carry <branch> right now? Asks the remote rather than trusting
// refs/remotes/origin/<branch>, which `git branch -D` leaves behind and which
// --release's server-side branch delete never prunes. git ls-remote exits 2
// when the ref matches nothing, and non-zero-non-2 when the remote is
// unreachable — a distinction the caller depends on.
function remoteBranchState(root, branch) {
  const res = git(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], {
    cwd: root,
    allowFail: true,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (res.status === 0) return "present";
  if (res.status === 2) return "absent";
  return "unreachable";
}

function revParse(root, ref) {
  const res = git(["rev-parse", "--verify", "--quiet", ref], { cwd: root, allowFail: true });
  return res.status === 0 ? res.stdout.trim() : null;
}

function isAncestor(root, maybeAncestor, descendant) {
  return (
    git(["merge-base", "--is-ancestor", maybeAncestor, descendant], { cwd: root, allowFail: true })
      .status === 0
  );
}

export function addWorktree({
  root = DEFAULT_ROOT,
  issueNumber,
  base = "origin/main",
  fetchRemote = false,
} = {}) {
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

  // Ask origin once, up front, and reuse the answer for both the local-branch
  // and no-branch paths below. Skipped entirely without --fetch, which keeps
  // `add` a purely local operation for callers that want it that way.
  let remote = null;
  if (fetchRemote) {
    remote = remoteBranchState(root, branch);
    if (remote === "unreachable") {
      throw new Error(
        `could not reach origin to check for ${branch}; refusing to branch from ${base} ` +
          `and orphan a possible open PR`,
      );
    }
    if (remote === "present") {
      git(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
        cwd: root,
        timeoutMs: NETWORK_TIMEOUT_MS,
      });
    }
  }

  if (branchExists(root, branch)) {
    // Branch survived a prior run (commits / open PR). Re-attaching it keeps
    // the PR head ref continuous — but only if it is not BEHIND origin. Since
    // the factory now deliberately keeps branches while a PR is open, anything
    // that pushes to the PR in the meantime (a review suggestion, a human)
    // would otherwise leave this worktree on a stale tip, and the agent's push
    // would be rejected with no sanctioned way to recover.
    const localSha = remote === "present" ? revParse(root, `refs/heads/${branch}`) : null;
    const remoteSha = remote === "present" ? revParse(root, `refs/remotes/origin/${branch}`) : null;
    let dropLocal = false;
    if (localSha && remoteSha && localSha !== remoteSha) {
      if (isAncestor(root, localSha, remoteSha)) {
        // Strictly behind: the local ref carries nothing origin doesn't have,
        // so drop it and take origin's below. update-ref (not branch -D) so a
        // branch checked out in some other worktree fails loudly rather than
        // being silently skipped.
        dropLocal =
          git(["update-ref", "-d", `refs/heads/${branch}`], {
            cwd: root,
            allowFail: true,
          }).status === 0;
      } else if (!isAncestor(root, remoteSha, localSha)) {
        throw new Error(
          `local ${branch} (${localSha.slice(0, 12)}) has diverged from ` +
            `origin/${branch} (${remoteSha.slice(0, 12)}); refusing to guess which is right — ` +
            `reconcile the branch by hand`,
        );
      }
      // else: strictly ahead (unpushed commits from a crashed run) — keep it.
    }
    if (!dropLocal) {
      git(["worktree", "add", wtPath, branch], { cwd: root });
      return {
        path: wtPath,
        branch,
        reused: false,
        created: true,
        branchReused: true,
        fromRemote: false,
        base: branch,
      };
    }
  }

  // No usable local branch. If origin still carries it, an open PR is almost
  // certainly built on it and branching from <base> would orphan its commits.
  if (remote === "present") {
    git(["worktree", "add", "--track", "-b", branch, wtPath, `origin/${branch}`], { cwd: root });
    return {
      path: wtPath,
      branch,
      reused: false,
      created: true,
      branchReused: true,
      fromRemote: true,
      base: `origin/${branch}`,
    };
  }

  if (fetchRemote) {
    // Absent on origin: drop any stale remote-tracking ref so a later run can't
    // mistake it for live work, then branch fresh from <base>.
    git(["update-ref", "-d", `refs/remotes/origin/${branch}`], { cwd: root, allowFail: true });
    // Refresh <base> too — --implement and --watch never fetch, so origin/main
    // would otherwise be as old as the last release. Best-effort: a stale base
    // is an annoyance, while an unreachable origin above is data loss.
    if (base.startsWith("origin/")) {
      git(["fetch", "origin", base.slice("origin/".length)], { cwd: root, allowFail: true });
    }
  }

  git(["worktree", "add", "-b", branch, wtPath, base], { cwd: root });
  return {
    path: wtPath,
    branch,
    reused: false,
    created: true,
    branchReused: false,
    fromRemote: false,
    base,
  };
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
  let branchHead = null;
  if (deleteBranch) {
    // Record the tip before deleting so the log carries enough to undo a
    // mistaken teardown (`git branch factory/issue-<n> <oid>`). Deciding
    // whether deletion is safe is factory-agent.sh's job — it owns the `gh`
    // call that knows if a PR still points here (see branch_keep_reason).
    const head = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: root,
      allowFail: true,
    });
    branchHead = head.status === 0 ? head.stdout.trim() : null;
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
    branchHead,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

// Local arg parser: parse-flags.mjs throws on value-less flags, but `add` /
// `remove` take the boolean flags --force / --delete-branch, so we walk argv
// directly here.
function parseArgs(argv) {
  const flags = {};
  const bools = new Set(["force", "delete-branch", "fetch"]);
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
      return addWorktree({
        root,
        issueNumber: flags.issue,
        base: flags.base ?? "origin/main",
        fetchRemote: Boolean(flags.fetch),
      });
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
        "Usage: worktree-cli.mjs <add --issue <n> [--base <ref>] [--root <dir>] [--fetch]|" +
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
