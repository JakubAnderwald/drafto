import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  branchForIssue,
  worktreePathForIssue,
  parseWorktreePorcelain,
} from "../lib/worktree-cli.mjs";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "worktree-cli.mjs");

function gitIn(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function runCli(args) {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

describe("worktree-cli pure helpers", () => {
  it("derives the documented branch + worktree naming", () => {
    assert.equal(branchForIssue(412), "factory/issue-412");
    assert.equal(worktreePathForIssue("/repo", 412), "/repo/worktrees/factory-issue-412");
  });

  it("parses git worktree list --porcelain into records", () => {
    const sample = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/worktrees/factory-issue-7",
      "HEAD def456",
      "branch refs/heads/factory/issue-7",
      "",
    ].join("\n");
    const parsed = parseWorktreePorcelain(sample);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[1].path, "/repo/worktrees/factory-issue-7");
    assert.equal(parsed[1].branch, "refs/heads/factory/issue-7");
  });
});

describe("worktree-cli against a real temp repo", () => {
  let repo;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "wt-cli-"));
    gitIn(repo, ["init", "-q", "-b", "main"]);
    gitIn(repo, ["config", "user.email", "test@example.com"]);
    gitIn(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "README.md"), "seed\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-q", "-m", "seed"]);
  });

  after(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("add creates the worktree + branch from a base ref", () => {
    const res = runCli(["add", "--issue", "42", "--root", repo, "--base", "main"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.branch, "factory/issue-42");
    assert.equal(out.created, true);
    assert.equal(out.reused, false);
    assert.ok(existsSync(out.path), "worktree dir should exist on disk");
  });

  it("add is idempotent — re-adding reuses the existing worktree", () => {
    const res = runCli(["add", "--issue", "42", "--root", repo, "--base", "main"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.reused, true);
    assert.equal(out.created, false);
  });

  it("list reports only factory worktrees", () => {
    const res = runCli(["list", "--root", repo]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.length, 1);
    assert.equal(out[0].branch, "factory/issue-42");
    assert.equal(out[0].issueNumber, 42);
  });

  it("remove --delete-branch tears down both worktree and branch", () => {
    const res = runCli(["remove", "--issue", "42", "--root", repo, "--delete-branch"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.removed, true);
    assert.equal(out.branchDeleted, true);
    assert.equal(existsSync(out.path), false, "worktree dir should be gone");

    const branches = gitIn(repo, ["branch", "--list", "factory/issue-42"]).trim();
    assert.equal(branches, "", "branch should be deleted");
  });

  it("remove on an absent worktree is a safe no-op (does not throw)", () => {
    const res = runCli(["remove", "--issue", "999", "--root", repo]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.removed, false, "nothing to remove → removed:false, exit 0");
  });

  it("re-attaches a surviving branch to a fresh worktree (retry path)", () => {
    // First add, then remove the worktree but KEEP the branch — simulating a
    // crashed --implement run that left commits on factory/issue-7.
    runCli(["add", "--issue", "7", "--root", repo, "--base", "main"]);
    const wt = worktreePathForIssue(repo, 7);
    // commit something on the branch via the worktree so it diverges
    writeFileSync(join(wt, "work.txt"), "wip\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-q", "-m", "wip"]);
    runCli(["remove", "--issue", "7", "--root", repo]); // keep branch

    const res = runCli(["add", "--issue", "7", "--root", repo, "--base", "main"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.created, true);
    assert.equal(out.branchReused, true, "existing branch must be re-attached, not recreated");
    assert.ok(existsSync(join(out.path, "work.txt")), "prior commit should be present");
  });
});

// The bug this suite pins: factory-agent.sh deletes the local branch whenever a
// card leaves its active states, including while the PR is still open. Before
// --fetch, `add` saw no local branch and silently branched the revision run off
// origin/main, so the agent edited pre-PR files and its push was rejected.
describe("worktree-cli remote branch resolution (--fetch)", () => {
  let repo;
  let bare;

  // A dedicated repo + bare "origin": the suite above shares one repo across
  // tests in declaration order, so adding a remote there would perturb it.
  before(() => {
    bare = mkdtempSync(join(tmpdir(), "wt-cli-origin-"));
    gitIn(bare, ["init", "--bare", "-q", "-b", "main"]);

    repo = mkdtempSync(join(tmpdir(), "wt-cli-remote-"));
    gitIn(repo, ["init", "-q", "-b", "main"]);
    gitIn(repo, ["config", "user.email", "test@example.com"]);
    gitIn(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "README.md"), "seed\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-q", "-m", "seed"]);
    gitIn(repo, ["remote", "add", "origin", bare]);
    gitIn(repo, ["push", "-q", "-u", "origin", "main"]);
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  it("recovers the PR's commits from origin after the local branch was deleted", () => {
    runCli(["add", "--issue", "77", "--root", repo, "--base", "main"]);
    const wt = worktreePathForIssue(repo, 77);
    writeFileSync(join(wt, "pr-work.txt"), "the PR's commits\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-q", "-m", "pr work"]);
    gitIn(wt, ["push", "-q", "origin", "factory/issue-77"]);
    // The cleanup sweep: worktree AND local branch destroyed, PR still open.
    runCli(["remove", "--issue", "77", "--root", repo, "--force", "--delete-branch"]);
    assert.equal(gitIn(repo, ["branch", "--list", "factory/issue-77"]).trim(), "");

    const res = runCli(["add", "--issue", "77", "--root", repo, "--base", "main", "--fetch"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.fromRemote, true, "must re-attach from origin, not branch from base");
    assert.equal(out.branchReused, true);
    assert.equal(out.base, "origin/factory/issue-77");
    assert.ok(
      existsSync(join(out.path, "pr-work.txt")),
      "the open PR's commits must be present in the recovered worktree",
    );
  });

  it("branches from base when origin has no such branch", () => {
    const res = runCli(["add", "--issue", "88", "--root", repo, "--base", "main", "--fetch"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.fromRemote, false);
    assert.equal(out.branchReused, false);
    assert.equal(out.base, "main");
  });

  it("clears a stale remote-tracking ref instead of trusting it", () => {
    // --release deletes the remote branch server-side and nothing prunes
    // locally, so refs/remotes/origin/<b> can outlive the real branch.
    const sha = gitIn(repo, ["rev-parse", "HEAD"]).trim();
    gitIn(repo, ["update-ref", "refs/remotes/origin/factory/issue-99", sha]);

    const res = runCli(["add", "--issue", "99", "--root", repo, "--base", "main", "--fetch"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).fromRemote, false, "a stale ref must not look live");
    const stale = spawnSync(
      "git",
      ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/factory/issue-99"],
      { cwd: repo, encoding: "utf8" },
    );
    assert.notEqual(stale.status, 0, "the stale remote-tracking ref should have been deleted");
  });

  it("refuses to branch from base when origin is unreachable", () => {
    const broken = mkdtempSync(join(tmpdir(), "wt-cli-broken-"));
    gitIn(broken, ["init", "-q", "-b", "main"]);
    gitIn(broken, ["config", "user.email", "test@example.com"]);
    gitIn(broken, ["config", "user.name", "Test"]);
    writeFileSync(join(broken, "README.md"), "seed\n");
    gitIn(broken, ["add", "."]);
    gitIn(broken, ["commit", "-q", "-m", "seed"]);
    gitIn(broken, ["remote", "add", "origin", join(broken, "does-not-exist.git")]);

    const res = runCli(["add", "--issue", "100", "--root", broken, "--base", "main", "--fetch"]);
    assert.equal(res.status, 1, "an unreachable origin must fail closed, not branch from base");
    assert.match(JSON.parse(res.stderr).error, /refusing to branch/);
    assert.ok(
      !existsSync(worktreePathForIssue(broken, 100)),
      "no worktree should be left behind on a refusal",
    );
    rmSync(broken, { recursive: true, force: true });
  });

  it("treats --fetch as a boolean, not a flag that swallows --base", () => {
    // parseArgs only knows a flag is boolean if it is in the `bools` Set;
    // otherwise `--fetch --base main` sets fetch="--base" and drops the base.
    const res = runCli(["add", "--issue", "101", "--root", repo, "--fetch", "--base", "main"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).base, "main", "--base must survive after --fetch");
  });

  it("touches the network only when --fetch is passed", () => {
    gitIn(repo, ["remote", "set-url", "origin", join(repo, "does-not-exist.git")]);
    const res = runCli(["add", "--issue", "102", "--root", repo, "--base", "main"]);
    gitIn(repo, ["remote", "set-url", "origin", bare]);
    assert.equal(res.status, 0, "without --fetch, add must not consult origin");
    assert.equal(JSON.parse(res.stdout).fromRemote, false);
  });

  it("takes origin's tip when the kept local branch is behind it", () => {
    // branch_keep_reason now keeps the local branch while a PR is open, so a
    // review suggestion or a human pushing to the PR leaves this ref stale.
    // Re-attaching it unchanged would get the agent's push rejected with no
    // sanctioned recovery, hard-stopping the card.
    runCli(["add", "--issue", "110", "--root", repo, "--base", "main"]);
    const wt = worktreePathForIssue(repo, 110);
    writeFileSync(join(wt, "ours.txt"), "ours\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-q", "-m", "ours"]);
    gitIn(wt, ["push", "-q", "origin", "factory/issue-110"]);
    // Someone else pushes on top, then our worktree goes away but the branch stays.
    const clone = mkdtempSync(join(tmpdir(), "wt-cli-other-"));
    gitIn(clone, ["clone", "-q", bare, "."]);
    gitIn(clone, ["config", "user.email", "other@example.com"]);
    gitIn(clone, ["config", "user.name", "Other"]);
    gitIn(clone, ["checkout", "-q", "factory/issue-110"]);
    writeFileSync(join(clone, "theirs.txt"), "theirs\n");
    gitIn(clone, ["add", "."]);
    gitIn(clone, ["commit", "-q", "-m", "theirs"]);
    gitIn(clone, ["push", "-q", "origin", "factory/issue-110"]);
    rmSync(clone, { recursive: true, force: true });
    runCli(["remove", "--issue", "110", "--root", repo, "--force"]); // keeps the branch

    const res = runCli(["add", "--issue", "110", "--root", repo, "--base", "main", "--fetch"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.fromRemote, true, "a behind local branch must yield to origin");
    assert.ok(
      existsSync(join(out.path, "theirs.txt")),
      "the commit pushed by someone else must be present",
    );
  });

  it("keeps a local branch that is ahead of origin (unpushed crash recovery)", () => {
    runCli(["add", "--issue", "111", "--root", repo, "--base", "main"]);
    const wt = worktreePathForIssue(repo, 111);
    writeFileSync(join(wt, "pushed.txt"), "pushed\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-q", "-m", "pushed"]);
    gitIn(wt, ["push", "-q", "origin", "factory/issue-111"]);
    writeFileSync(join(wt, "unpushed.txt"), "unpushed\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-q", "-m", "unpushed"]);
    runCli(["remove", "--issue", "111", "--root", repo, "--force"]);

    const res = runCli(["add", "--issue", "111", "--root", repo, "--base", "main", "--fetch"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.fromRemote, false, "unpushed local work must not be discarded");
    assert.ok(existsSync(join(out.path, "unpushed.txt")));
  });

  it("refuses to guess when the local branch has diverged from origin", () => {
    runCli(["add", "--issue", "112", "--root", repo, "--base", "main"]);
    const wt = worktreePathForIssue(repo, 112);
    writeFileSync(join(wt, "base.txt"), "base\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-q", "-m", "base"]);
    gitIn(wt, ["push", "-q", "origin", "factory/issue-112"]);
    const forkPoint = gitIn(wt, ["rev-parse", "HEAD"]).trim();
    // Remote moves one way...
    const clone = mkdtempSync(join(tmpdir(), "wt-cli-div-"));
    gitIn(clone, ["clone", "-q", bare, "."]);
    gitIn(clone, ["config", "user.email", "other@example.com"]);
    gitIn(clone, ["config", "user.name", "Other"]);
    gitIn(clone, ["checkout", "-q", "factory/issue-112"]);
    writeFileSync(join(clone, "remote-side.txt"), "remote\n");
    gitIn(clone, ["add", "."]);
    gitIn(clone, ["commit", "-q", "-m", "remote side"]);
    gitIn(clone, ["push", "-q", "origin", "factory/issue-112"]);
    rmSync(clone, { recursive: true, force: true });
    // ...and the local branch another.
    gitIn(wt, ["reset", "-q", "--hard", forkPoint]);
    writeFileSync(join(wt, "local-side.txt"), "local\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-q", "-m", "local side"]);
    runCli(["remove", "--issue", "112", "--root", repo, "--force"]);

    const res = runCli(["add", "--issue", "112", "--root", repo, "--base", "main", "--fetch"]);
    assert.equal(res.status, 1, "divergence must fail closed, not silently pick a side");
    assert.match(JSON.parse(res.stderr).error, /diverged/);
  });

  it("reports the deleted branch tip so a mistaken teardown is recoverable", () => {
    runCli(["add", "--issue", "103", "--root", repo, "--base", "main"]);
    const head = gitIn(repo, ["rev-parse", "refs/heads/factory/issue-103"]).trim();
    const res = runCli(["remove", "--issue", "103", "--root", repo, "--force", "--delete-branch"]);
    const out = JSON.parse(res.stdout);
    assert.equal(out.branchDeleted, true);
    assert.equal(out.branchHead, head, "the pre-delete tip must be reported for recovery");
  });
});
