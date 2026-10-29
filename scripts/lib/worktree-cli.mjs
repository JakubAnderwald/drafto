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
//   add         --issue <n> [--base <ref>] [--root <repoRoot>] [--fetch]
//   remove      --issue <n> [--root <repoRoot>] [--force] [--delete-branch]
//   path        --issue <n> [--root <repoRoot>]
//   list        [--root <repoRoot>]
//   merge-main  --path <worktree> [--main <branch>]
//   merge-abort --path <worktree> [--to <sha>]
//   merge-check --path <worktree> --main-sha <sha> [--files-json '["a","b"]']
//   push        --path <worktree>
//
// The merge-* commands and `push` are the --watch conflict pass (ADR-0061):
// bash starts the merge of origin/main into a PR branch that GitHub reports as
// CONFLICTING, the agent resolves what git couldn't, and bash checks the
// result. Bash, not the agent, starts merges, so a run never ends mid-merge
// with nobody to clean up.
//
// `add` is idempotent, resolving the branch in four tiers so a revision run
// always lands on the PR's own commits:
//   1. the worktree is already registered  → reuse it (with --fetch, first
//                                            fast-forwarded when strictly
//                                            behind origin; diverged or dirty
//                                            throws)
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
import { ADR_DIR, newAdrCollisions, nextFreeAdrNumber } from "./adr-numbers.mjs";

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
  if (res.status === 0) return { state: "present" };
  if (res.status === 2) return { state: "absent" };
  // Keep git's stderr: a broken git binary (e.g. an unaccepted Xcode license)
  // also lands here, and "could not reach origin" alone points at the network.
  return {
    state: "unreachable",
    detail: String(res.stderr ?? "")
      .trim()
      .split("\n")[0],
  };
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

// A registered worktree stays put while its card is In Review or In Test, so
// anything that pushes to the PR meanwhile ("Update branch" on GitHub, --release
// updating a BEHIND PR, a human) leaves it on a stale tip. The next run would
// commit there and its push would be rejected, with no sanctioned way for the
// agent to recover. Fast-forward it when it is strictly behind and clean; keep
// it when ahead (unpushed commits); throw when diverged or dirty, like the
// re-attach path. Returns whether it moved.
function syncRegisteredWorktree(root, wtPath, branch) {
  const probe = remoteBranchState(root, branch);
  if (probe.state === "unreachable") {
    throw new Error(
      `could not reach origin to check ${branch} before reusing ${wtPath}` +
        (probe.detail ? ` (git: ${probe.detail})` : ""),
    );
  }
  if (probe.state !== "present") return false;
  git(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd: root,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  const localSha = revParse(wtPath, "HEAD");
  const remoteSha = revParse(root, `refs/remotes/origin/${branch}`);
  if (!localSha || !remoteSha || localSha === remoteSha) return false;
  if (isAncestor(root, remoteSha, localSha)) return false;
  if (!isAncestor(root, localSha, remoteSha)) {
    throw new Error(
      `worktree ${wtPath} (${localSha.slice(0, 12)}) has diverged from ` +
        `origin/${branch} (${remoteSha.slice(0, 12)}); refusing to guess which is right — ` +
        `reconcile the branch by hand`,
    );
  }
  if (git(["status", "--porcelain"], { cwd: wtPath }).stdout.trim()) {
    throw new Error(
      `worktree ${wtPath} is behind origin/${branch} and has uncommitted changes; ` +
        `reconcile it by hand`,
    );
  }
  git(["merge", "--ff-only", "--quiet", `origin/${branch}`], { cwd: wtPath });
  return true;
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

  // Already registered at the canonical path → reuse it. This is the retry
  // path: --watch resumes in the same worktree --implement created. With
  // --fetch it is first brought level with origin, like the re-attach path.
  const existing = listWorktrees(root).find((w) => canonical(w.path) === canonical(wtPath));
  if (existing) {
    const fastForwarded = fetchRemote ? syncRegisteredWorktree(root, wtPath, branch) : false;
    return { path: wtPath, branch, reused: true, created: false, fastForwarded };
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
    const probe = remoteBranchState(root, branch);
    remote = probe.state;
    if (remote === "unreachable") {
      throw new Error(
        `could not reach origin to check for ${branch}; refusing to branch from ${base} ` +
          `and orphan a possible open PR` +
          (probe.detail ? ` (git: ${probe.detail})` : ""),
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

// ── Merging main into a PR branch (ADR-0061) ───────────────────────────────

// MERGE_HEAD is a per-worktree ref, so this sees only this worktree's merge.
function mergeInProgress(wtPath) {
  return revParse(wtPath, "MERGE_HEAD") !== null;
}

function unmergedFiles(wtPath) {
  const res = git(["diff", "--name-only", "--diff-filter=U"], { cwd: wtPath, allowFail: true });
  return [
    ...new Set(
      String(res.stdout ?? "")
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean),
    ),
  ];
}

function currentBranch(wtPath) {
  const res = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: wtPath, allowFail: true });
  return res.status === 0 ? res.stdout.trim() : null;
}

// ADR file names in <ref>'s tree, so a collision main already has can be told
// apart from one this merge created (adr-numbers.mjs newAdrCollisions).
function adrFileNamesAt(wtPath, ref) {
  if (!ref) return [];
  const res = git(["ls-tree", "--name-only", ref, `${ADR_DIR}/`], { cwd: wtPath, allowFail: true });
  if (res.status !== 0) return [];
  return String(res.stdout)
    .split("\n")
    .filter(Boolean)
    .map((f) => path.basename(f));
}

// Does HEAD carry commits origin/<branch> doesn't? Reads the remote-tracking
// ref, which `add --fetch` refreshed earlier in the same tick.
function hasUnpushedCommits(wtPath, branch) {
  const head = revParse(wtPath, "HEAD");
  const remote = revParse(wtPath, `refs/remotes/origin/${branch}`);
  if (!head) return false;
  if (!remote) return true;
  return head !== remote && !isAncestor(wtPath, head, remote);
}

// ADR file names git is tracking in the index, which mid-merge holds both
// sides' added files. Untracked strays (a copy a failed pass left behind) are
// not part of any commit, so they must not count as a clash.
function adrFileNamesInIndex(wtPath) {
  const res = git(["ls-files", "--", `${ADR_DIR}/`], { cwd: wtPath, allowFail: true });
  if (res.status !== 0) return [];
  // A conflicted path is listed once per stage; one name is one file.
  return [
    ...new Set(
      String(res.stdout)
        .split("\n")
        .filter(Boolean)
        .map((f) => path.basename(f)),
    ),
  ];
}

function adrState(files, wtPath, mainSha) {
  return {
    adrCollisions: newAdrCollisions(files, adrFileNamesAt(wtPath, mainSha)),
    nextFreeAdr: nextFreeAdrNumber(files),
  };
}

function firstLine(res) {
  return String(res.stderr || res.stdout || "")
    .trim()
    .split("\n")[0];
}

// Fetch origin/<mainBranch> and merge it into the worktree's branch. The
// statuses:
//   up-to-date — main is already in the branch; nothing changed
//   clean      — git merged it on its own and committed the merge
//   conflicts  — the merge is left in progress for the agent to resolve
//   error      — git refused to merge (e.g. a dirty tree); the tree is as before
//   unreachable — origin/main couldn't be fetched; nothing was touched. It is
//                 transient, so the caller retries without spending budget.
// `adrCollisions` lists numbers the merge left on two ADR files that main
// doesn't itself duplicate — a clean merge can produce one, so it is reported
// for every status. `ahead` says whether HEAD still has to be pushed.
export function mergeMain({ wtPath, mainBranch = "main" } = {}) {
  if (!wtPath) throw new Error("mergeMain requires a worktree path");
  if (mergeInProgress(wtPath)) {
    throw new Error(`a merge is already in progress in ${wtPath}; run merge-abort first`);
  }
  const branch = currentBranch(wtPath);
  if (!branch) throw new Error(`${wtPath} is on a detached HEAD; refusing to merge into it`);

  // Resumed worktrees never refresh main on their own (see `add` tier 4), so
  // without this fetch the merge would bring in whatever main was at the last
  // release and GitHub would still report the PR as conflicting.
  const mainRef = `refs/remotes/origin/${mainBranch}`;
  const fetched = git(["fetch", "origin", `+refs/heads/${mainBranch}:${mainRef}`], {
    cwd: wtPath,
    allowFail: true,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (fetched.status !== 0) {
    return { status: "unreachable", branch, detail: firstLine(fetched) };
  }
  const mainSha = revParse(wtPath, mainRef);
  const before = revParse(wtPath, "HEAD");
  // The short name keeps git's default message readable: "Merge
  // remote-tracking branch 'origin/main' into factory/issue-<n>".
  const res = git(["merge", "--no-edit", `origin/${mainBranch}`], {
    cwd: wtPath,
    allowFail: true,
  });

  // `before` is what merge-abort --to rolls back to if the pass fails.
  const base = { branch, mainSha, before };
  if (res.status === 0) {
    const status = revParse(wtPath, "HEAD") === before ? "up-to-date" : "clean";
    return {
      status,
      ...base,
      conflictedFiles: [],
      ...adrState(adrFileNamesInIndex(wtPath), wtPath, mainSha),
      ahead: hasUnpushedCommits(wtPath, branch),
    };
  }
  const conflicted = mergeInProgress(wtPath) ? unmergedFiles(wtPath) : [];
  if (conflicted.length > 0) {
    return {
      status: "conflicts",
      ...base,
      conflictedFiles: conflicted,
      ...adrState(adrFileNamesInIndex(wtPath), wtPath, mainSha),
      ahead: true,
    };
  }
  // Leave the worktree exactly as it was: the next tick's `add` refuses to
  // fast-forward a dirty tree, and a half-merge nobody owns would be one.
  abortMerge({ wtPath });
  return {
    status: "error",
    ...base,
    detail: firstLine(res),
    conflictedFiles: [],
    adrCollisions: [],
    ahead: false,
  };
}

// Abort an unfinished merge, if there is one. Safe to call at any time.
//
// With `to` (the HEAD merge-main started from), also roll back a pass whose
// result never reached origin: reset to `to`, dropping whatever HEAD carries
// that origin lacks (an unpushed merge, or an amend that rewrote history), then
// remove the untracked files the pass left. Without this, a local merge commit
// the PR never received leaves the branch diverged as soon as anyone else
// pushes, and `add` refuses a diverged worktree on every later tick; a stray
// file can block the next merge outright. Ignored files (env, node_modules)
// are kept, and a HEAD that did reach origin is never touched.
export function abortMerge({ wtPath, to } = {}) {
  if (!wtPath) throw new Error("abortMerge requires a worktree path");
  const aborted = mergeInProgress(wtPath)
    ? git(["merge", "--abort"], { cwd: wtPath, allowFail: true }).status === 0
    : false;
  if (!to) return { aborted };

  const head = revParse(wtPath, "HEAD");
  const branch = currentBranch(wtPath);
  const onlyLocal = head === to || (branch !== null && hasUnpushedCommits(wtPath, branch));
  if (!onlyLocal) return { aborted, rolledBackTo: null };
  git(["reset", "--hard", "--quiet", to], { cwd: wtPath });
  git(["clean", "-fd", "--quiet"], { cwd: wtPath, allowFail: true });
  return { aborted, rolledBackTo: to };
}

// A conflict marker left in a file the agent `git add`ed still commits. Only
// the opening and closing markers count: a bare "=======" is also a Markdown
// heading underline.
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;

function filesWithMarkers(wtPath, files) {
  return files.filter((file) => {
    const res = git(["show", `HEAD:${file}`], { cwd: wtPath, allowFail: true });
    return res.status === 0 && CONFLICT_MARKER.test(String(res.stdout));
  });
}

// What bash checks after the agent says it resolved the merge. `files` is the
// conflicted-file list merge-main returned. Everything is judged on HEAD — the
// commit bash will push — never the working tree: the resolution is accepted
// only when the merge is committed, nothing tracked is left uncommitted, main
// is in HEAD, none of those files kept a conflict marker, and HEAD's ADRs share
// no number main doesn't already duplicate.
export function checkMerge({ wtPath, mainSha, files = [] } = {}) {
  if (!wtPath) throw new Error("checkMerge requires a worktree path");
  const head = revParse(wtPath, "HEAD");
  const inProgress = mergeInProgress(wtPath);
  const unmerged = inProgress ? unmergedFiles(wtPath) : [];
  const uncommitted = String(
    git(["status", "--porcelain", "--untracked-files=no"], { cwd: wtPath, allowFail: true })
      .stdout ?? "",
  )
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  const mainIsAncestor = Boolean(mainSha && head && isAncestor(wtPath, mainSha, head));
  const markers = filesWithMarkers(wtPath, files);
  const { adrCollisions } = adrState(adrFileNamesAt(wtPath, "HEAD"), wtPath, mainSha);
  return {
    head,
    inProgress,
    unmergedFiles: unmerged,
    uncommittedFiles: uncommitted,
    mainIsAncestor,
    filesWithMarkers: markers,
    adrCollisions,
    resolved:
      !inProgress &&
      uncommitted.length === 0 &&
      mainIsAncestor &&
      markers.length === 0 &&
      adrCollisions.length === 0,
  };
}

// Push HEAD to the branch's own ref on origin. Only factory branches: this
// runs unattended, and a worktree that somehow sits on main must never push.
export function pushBranch({ wtPath } = {}) {
  if (!wtPath) throw new Error("pushBranch requires a worktree path");
  const branch = currentBranch(wtPath);
  if (!branch || !/^factory\/issue-\d+$/.test(branch)) {
    throw new Error(`refusing to push ${branch ?? "a detached HEAD"}: not a factory branch`);
  }
  git(["push", "origin", `HEAD:refs/heads/${branch}`], {
    cwd: wtPath,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  const head = revParse(wtPath, "HEAD");
  // Keep the remote-tracking ref level with what we just pushed, so a later
  // merge-main in the same tick doesn't report the branch as still ahead.
  git(["update-ref", `refs/remotes/origin/${branch}`, head], { cwd: wtPath, allowFail: true });
  return { pushed: true, branch, head };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseFileList(json) {
  if (!json) return [];
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error("--files-json must be a JSON array of paths");
  return list.filter((f) => typeof f === "string" && f.length > 0);
}

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
    case "merge-main":
      return mergeMain({ wtPath: flags.path, mainBranch: flags.main ?? "main" });
    case "merge-abort":
      return abortMerge({ wtPath: flags.path, to: flags.to });
    case "merge-check":
      return checkMerge({
        wtPath: flags.path,
        mainSha: flags["main-sha"],
        // JSON, not a delimited list: a path may contain any delimiter.
        files: parseFileList(flags["files-json"]),
      });
    case "push":
      return pushBranch({ wtPath: flags.path });
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: worktree-cli.mjs <add --issue <n> [--base <ref>] [--root <dir>] [--fetch]|" +
          "remove --issue <n> [--root <dir>] [--force] [--delete-branch]|" +
          "path --issue <n> [--root <dir>]|list [--root <dir>]|" +
          "merge-main --path <wt> [--main <branch>]|merge-abort --path <wt> [--to <sha>]|" +
          "merge-check --path <wt> --main-sha <sha> [--files-json <json array>]|push --path <wt>>\n",
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
