import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
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

  // A card's worktree stays registered through In Review and In Test, so a push
  // to the PR from elsewhere ("Update branch" on GitHub, --release updating a
  // BEHIND PR) used to leave the reused worktree on a stale tip: the next run's
  // push was rejected and the agent had no sanctioned way to recover.
  function pushFromElsewhere(issue, file) {
    const clone = mkdtempSync(join(tmpdir(), "wt-cli-elsewhere-"));
    gitIn(clone, ["clone", "-q", bare, "."]);
    gitIn(clone, ["config", "user.email", "other@example.com"]);
    gitIn(clone, ["config", "user.name", "Other"]);
    gitIn(clone, ["checkout", "-q", `factory/issue-${issue}`]);
    writeFileSync(join(clone, file), "elsewhere\n");
    gitIn(clone, ["add", "."]);
    gitIn(clone, ["commit", "-q", "-m", "elsewhere"]);
    gitIn(clone, ["push", "-q", "origin", `factory/issue-${issue}`]);
    rmSync(clone, { recursive: true, force: true });
  }

  function registeredAndPushed(issue) {
    runCli(["add", "--issue", String(issue), "--root", repo, "--base", "main"]);
    const wt = worktreePathForIssue(repo, issue);
    writeFileSync(join(wt, "ours.txt"), "ours\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-q", "-m", "ours"]);
    gitIn(wt, ["push", "-q", "origin", `factory/issue-${issue}`]);
    return wt;
  }

  it("fast-forwards a registered worktree that is behind origin", () => {
    const wt = registeredAndPushed(120);
    pushFromElsewhere(120, "update-branch.txt");

    const res = runCli(["add", "--issue", "120", "--root", repo, "--base", "main", "--fetch"]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.reused, true);
    assert.equal(out.fastForwarded, true);
    assert.ok(existsSync(join(wt, "update-branch.txt")), "origin's commit must be in the worktree");
    assert.equal(
      gitIn(wt, ["rev-parse", "HEAD"]).trim(),
      gitIn(repo, ["rev-parse", "refs/remotes/origin/factory/issue-120"]).trim(),
    );
  });

  it("leaves a registered worktree alone without --fetch, or when it is level or ahead", () => {
    const wt = registeredAndPushed(121);
    pushFromElsewhere(121, "later.txt");
    let out = JSON.parse(
      runCli(["add", "--issue", "121", "--root", repo, "--base", "main"]).stdout,
    );
    assert.equal(out.fastForwarded, false, "no --fetch, no network, no move");
    assert.ok(!existsSync(join(wt, "later.txt")));

    gitIn(wt, ["pull", "-q", "--ff-only", "origin", "factory/issue-121"]);
    writeFileSync(join(wt, "unpushed.txt"), "unpushed\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-q", "-m", "unpushed"]);
    const before = gitIn(wt, ["rev-parse", "HEAD"]).trim();
    out = JSON.parse(
      runCli(["add", "--issue", "121", "--root", repo, "--base", "main", "--fetch"]).stdout,
    );
    assert.equal(out.fastForwarded, false, "ahead of origin: keep the unpushed commit");
    assert.equal(gitIn(wt, ["rev-parse", "HEAD"]).trim(), before);
  });

  it("refuses to reuse a registered worktree that has diverged from origin", () => {
    const wt = registeredAndPushed(122);
    pushFromElsewhere(122, "remote-side.txt");
    writeFileSync(join(wt, "local-side.txt"), "local\n");
    gitIn(wt, ["add", "."]);
    gitIn(wt, ["commit", "-q", "-m", "local side"]);

    const res = runCli(["add", "--issue", "122", "--root", repo, "--base", "main", "--fetch"]);
    assert.equal(res.status, 1, "divergence must fail closed, not silently pick a side");
    assert.match(JSON.parse(res.stderr).error, /diverged/);
  });

  it("refuses to fast-forward a registered worktree over uncommitted changes", () => {
    const wt = registeredAndPushed(123);
    pushFromElsewhere(123, "remote-only.txt");
    writeFileSync(join(wt, "ours.txt"), "edited, not committed\n");

    const res = runCli(["add", "--issue", "123", "--root", repo, "--base", "main", "--fetch"]);
    assert.equal(res.status, 1);
    assert.match(JSON.parse(res.stderr).error, /uncommitted changes/);
    assert.equal(
      gitIn(wt, ["status", "--porcelain"]).trim(),
      "M ours.txt",
      "the edit must survive",
    );
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

// The --watch conflict pass (ADR-0061): bash merges origin/main into a PR
// branch GitHub reports as CONFLICTING, the agent resolves what git couldn't,
// and bash checks the result before trusting the agent's "fixed".
describe("worktree-cli merge-main / merge-abort / merge-check / push", () => {
  let repo;
  let bare;

  function commitAll(cwd, message) {
    gitIn(cwd, ["add", "-A"]);
    gitIn(cwd, ["commit", "-q", "-m", message]);
  }

  function write(dir, rel, content) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }

  // Another contributor lands <files> on main, as #757 and #762 did under #755.
  function advanceMain(files) {
    const clone = mkdtempSync(join(tmpdir(), "wt-cli-main-"));
    gitIn(clone, ["clone", "-q", bare, "."]);
    gitIn(clone, ["config", "user.email", "other@example.com"]);
    gitIn(clone, ["config", "user.name", "Other"]);
    for (const [rel, content] of Object.entries(files)) write(clone, rel, content);
    commitAll(clone, "main moves on");
    gitIn(clone, ["push", "-q", "origin", "main"]);
    const sha = gitIn(clone, ["rev-parse", "HEAD"]).trim();
    rmSync(clone, { recursive: true, force: true });
    return sha;
  }

  // A factory card's worktree with the PR's commit pushed, as --implement leaves it.
  function prWorktree(issue, files) {
    runCli(["add", "--issue", String(issue), "--root", repo, "--base", "main", "--fetch"]);
    const wt = worktreePathForIssue(repo, issue);
    for (const [rel, content] of Object.entries(files)) write(wt, rel, content);
    commitAll(wt, "pr work");
    gitIn(wt, ["push", "-q", "origin", `factory/issue-${issue}`]);
    return wt;
  }

  function json(res) {
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  }

  before(() => {
    bare = mkdtempSync(join(tmpdir(), "wt-cli-merge-origin-"));
    gitIn(bare, ["init", "--bare", "-q", "-b", "main"]);
    repo = mkdtempSync(join(tmpdir(), "wt-cli-merge-"));
    gitIn(repo, ["init", "-q", "-b", "main"]);
    gitIn(repo, ["config", "user.email", "test@example.com"]);
    gitIn(repo, ["config", "user.name", "Test"]);
    write(repo, "docs/adr/0001-first.md", "# 1\n");
    write(repo, "docs/adr/README.md", "| 0001 | first |\n");
    commitAll(repo, "seed");
    gitIn(repo, ["remote", "add", "origin", bare]);
    gitIn(repo, ["push", "-q", "-u", "origin", "main"]);
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  it("reports up-to-date when main has nothing new", () => {
    const wt = prWorktree(200, { "pr.txt": "pr\n" });
    const before = gitIn(wt, ["rev-parse", "HEAD"]).trim();
    const out = json(runCli(["merge-main", "--path", wt]));
    assert.equal(out.status, "up-to-date");
    assert.equal(out.branch, "factory/issue-200");
    assert.equal(out.ahead, false);
    assert.deepEqual(out.adrCollisions, []);
    assert.equal(gitIn(wt, ["rev-parse", "HEAD"]).trim(), before);
  });

  it("merges a main that moved without conflicts, then pushes the merge", () => {
    const wt = prWorktree(201, { "pr-201.txt": "pr\n" });
    const mainSha = advanceMain({ "unrelated.txt": "main\n" });

    const out = json(runCli(["merge-main", "--path", wt]));
    assert.equal(out.status, "clean");
    assert.equal(out.mainSha, mainSha, "it must fetch main itself — a resumed worktree never does");
    assert.equal(out.ahead, true, "the merge commit is not on origin yet");
    assert.ok(existsSync(join(wt, "unrelated.txt")));

    const pushed = json(runCli(["push", "--path", wt]));
    assert.equal(pushed.branch, "factory/issue-201");
    assert.equal(
      gitIn(bare, ["rev-parse", "refs/heads/factory/issue-201"]).trim(),
      gitIn(wt, ["rev-parse", "HEAD"]).trim(),
    );
    const check = json(runCli(["merge-check", "--path", wt, "--main-sha", mainSha]));
    assert.equal(check.resolved, true);
    assert.equal(check.mainIsAncestor, true);
  });

  it("leaves a conflicting merge in progress and reports the files and the ADR clash", () => {
    // #755's shape: the PR and main each took the next ADR number and added an
    // index row on the same line.
    const wt = prWorktree(202, {
      "docs/adr/0002-from-the-pr.md": "# 2 (pr)\n",
      "docs/adr/README.md": "| 0001 | first |\n| 0002 | from the pr |\n",
    });
    const mainSha = advanceMain({
      "docs/adr/0002-from-main.md": "# 2 (main)\n",
      "docs/adr/README.md": "| 0001 | first |\n| 0002 | from main |\n",
    });

    const out = json(runCli(["merge-main", "--path", wt]));
    assert.equal(out.status, "conflicts");
    assert.equal(out.mainSha, mainSha);
    assert.deepEqual(out.conflictedFiles, ["docs/adr/README.md"]);
    assert.deepEqual(out.adrCollisions, [
      { number: "0002", files: ["0002-from-main.md", "0002-from-the-pr.md"] },
    ]);
    assert.equal(out.nextFreeAdr, "0003");

    const midway = json(
      runCli([
        "merge-check",
        "--path",
        wt,
        "--main-sha",
        mainSha,
        "--files-json",
        JSON.stringify(["docs/adr/README.md"]),
      ]),
    );
    assert.equal(midway.inProgress, true);
    assert.deepEqual(midway.unmergedFiles, ["docs/adr/README.md"]);
    assert.equal(midway.resolved, false);

    const again = runCli(["merge-main", "--path", wt]);
    assert.equal(again.status, 1, "never start a second merge over an unfinished one");
    assert.match(JSON.parse(again.stderr).error, /already in progress/);
  });

  it("merge-abort restores the branch, and is a no-op when nothing is in progress", () => {
    const wt = worktreePathForIssue(repo, 202);
    const prHead = gitIn(bare, ["rev-parse", "refs/heads/factory/issue-202"]).trim();
    assert.deepEqual(json(runCli(["merge-abort", "--path", wt])), { aborted: true });
    assert.equal(gitIn(wt, ["rev-parse", "HEAD"]).trim(), prHead);
    assert.equal(gitIn(wt, ["status", "--porcelain"]).trim(), "");
    assert.deepEqual(json(runCli(["merge-abort", "--path", wt])), { aborted: false });
  });

  it("accepts a resolution only once it is committed with no markers or ADR clash left", () => {
    const wt = worktreePathForIssue(repo, 202);
    const { mainSha } = json(runCli(["merge-main", "--path", wt]));
    const files = ["--files-json", JSON.stringify(["docs/adr/README.md"])];

    // An agent that `git add`s the file with the markers still in it.
    gitIn(wt, ["add", "docs/adr/README.md"]);
    gitIn(wt, ["commit", "-q", "--no-edit"]);
    let check = json(runCli(["merge-check", "--path", wt, "--main-sha", mainSha, ...files]));
    assert.equal(check.inProgress, false);
    assert.equal(check.mainIsAncestor, true);
    assert.deepEqual(check.filesWithMarkers, ["docs/adr/README.md"]);
    assert.equal(check.adrCollisions.length, 1);
    assert.equal(check.resolved, false);

    // The fix made in the working tree only: what bash would push (HEAD) still
    // has the markers and the clash, so it must not pass.
    gitIn(wt, ["mv", "docs/adr/0002-from-the-pr.md", "docs/adr/0003-from-the-pr.md"]);
    write(
      wt,
      "docs/adr/README.md",
      "| 0001 | first |\n| 0002 | from main |\n| 0003 | from the pr |\n",
    );
    check = json(runCli(["merge-check", "--path", wt, "--main-sha", mainSha, ...files]));
    assert.equal(check.adrCollisions.length, 1, "judged on HEAD, not the working tree");
    assert.ok(check.uncommittedFiles.length > 0);
    assert.equal(check.resolved, false);

    // Committed: keep both rows, renumber the PR's own ADR.
    commitAll(wt, "fix: renumber ADR after main moved");
    check = json(runCli(["merge-check", "--path", wt, "--main-sha", mainSha, ...files]));
    assert.deepEqual(check.filesWithMarkers, []);
    assert.deepEqual(check.adrCollisions, []);
    assert.deepEqual(check.uncommittedFiles, []);
    assert.equal(check.resolved, true);
  });

  it("merge-check reads a path with a comma in it whole", () => {
    const wt = worktreePathForIssue(repo, 202);
    write(wt, "docs/a,b.md", "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n");
    commitAll(wt, "a file with a comma");
    const head = gitIn(wt, ["rev-parse", "HEAD"]).trim();
    const check = json(
      runCli(["merge-check", "--path", wt, "--main-sha", head, "--files-json", '["docs/a,b.md"]']),
    );
    assert.deepEqual(check.filesWithMarkers, ["docs/a,b.md"]);
    gitIn(wt, ["reset", "-q", "--hard", "HEAD~1"]);
  });

  it("does not count an untracked stray ADR as a clash", () => {
    const wt = prWorktree(208, { "pr-208.txt": "pr\n" });
    advanceMain({ "main-208.txt": "main\n" });
    write(wt, "docs/adr/0001-stray-copy.md", "# left behind by a failed pass\n");
    const out = json(runCli(["merge-main", "--path", wt]));
    assert.equal(out.status, "clean");
    assert.deepEqual(out.adrCollisions, []);
  });

  it("reports an unreachable origin as transient, touching nothing", () => {
    const wt = prWorktree(209, { "pr-209.txt": "pr\n" });
    const before = gitIn(wt, ["rev-parse", "HEAD"]).trim();
    gitIn(repo, ["remote", "set-url", "origin", join(tmpdir(), "wt-cli-no-such-origin")]);
    try {
      const out = json(runCli(["merge-main", "--path", wt]));
      assert.equal(out.status, "unreachable");
      assert.ok(out.detail);
      assert.equal(gitIn(wt, ["rev-parse", "HEAD"]).trim(), before);
    } finally {
      gitIn(repo, ["remote", "set-url", "origin", bare]);
    }
  });

  it("flags an ADR number clash that git merged without a conflict", () => {
    const wt = prWorktree(203, { "docs/adr/0009-pr.md": "# 9 (pr)\n" });
    advanceMain({ "docs/adr/0009-main.md": "# 9 (main)\n" });
    const out = json(runCli(["merge-main", "--path", wt]));
    assert.equal(out.status, "clean", "different file names never conflict textually");
    assert.deepEqual(out.adrCollisions, [
      { number: "0009", files: ["0009-main.md", "0009-pr.md"] },
    ]);
    assert.equal(out.nextFreeAdr, "0010");
  });

  it("ignores an ADR number clash that main already has", () => {
    const wt = prWorktree(204, { "pr-204.txt": "pr\n" });
    advanceMain({ "docs/adr/0020-one.md": "# a\n", "docs/adr/0020-two.md": "# b\n" });
    const out = json(runCli(["merge-main", "--path", wt]));
    assert.equal(out.status, "clean");
    assert.deepEqual(out.adrCollisions, [], "main's own duplicate is not this PR's to fix");
  });

  it("reports an error and leaves the tree as it was when git refuses to merge", () => {
    const wt = prWorktree(205, { "pr-205.txt": "pr\n" });
    advanceMain({ "shared.txt": "main's version\n" });
    write(wt, "shared.txt", "an uncommitted local file\n");
    const before = gitIn(wt, ["rev-parse", "HEAD"]).trim();

    const out = json(runCli(["merge-main", "--path", wt]));
    assert.equal(out.status, "error");
    assert.ok(out.detail, "git's reason must be passed on for the log");
    assert.equal(gitIn(wt, ["rev-parse", "HEAD"]).trim(), before);
    assert.equal(
      spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: wt }).status,
      1,
      "no half-merge may be left behind",
    );
    assert.equal(gitIn(wt, ["status", "--porcelain"]).trim(), "?? shared.txt");
  });

  it("refuses to push anything but a factory branch", () => {
    const res = runCli(["push", "--path", repo]);
    assert.equal(res.status, 1);
    assert.match(JSON.parse(res.stderr).error, /not a factory branch/);
  });

  // A failed pass must not strand a local merge commit the PR never got: once
  // anyone else pushes, the branch has diverged and `add` refuses it every tick.
  it("merge-abort --to drops a committed merge that never reached origin", () => {
    const wt = prWorktree(206, { "pr-206.txt": "pr\n" });
    advanceMain({ "main-206.txt": "main\n" });
    const out = json(runCli(["merge-main", "--path", wt]));
    assert.equal(out.status, "clean");
    assert.equal(out.before, gitIn(bare, ["rev-parse", "refs/heads/factory/issue-206"]).trim());
    write(wt, "pr-206.txt", "half-done edit\n");
    write(wt, "docs/adr/0002-stray.md", "# an untracked copy\n");

    const res = json(runCli(["merge-abort", "--path", wt, "--to", out.before]));
    assert.deepEqual(res, { aborted: false, rolledBackTo: out.before });
    assert.equal(gitIn(wt, ["rev-parse", "HEAD"]).trim(), out.before);
    assert.equal(
      gitIn(wt, ["status", "--porcelain"]).trim(),
      "",
      "leftover edits and untracked files go too",
    );
  });

  it("merge-abort --to also undoes an amend that rewrote the branch", () => {
    const wt = prWorktree(210, { "pr-210.txt": "pr\n" });
    const before = gitIn(wt, ["rev-parse", "HEAD"]).trim();
    write(wt, "pr-210.txt", "rewritten\n");
    gitIn(wt, ["commit", "-q", "-a", "--amend", "--no-edit"]);
    assert.notEqual(gitIn(wt, ["rev-parse", "HEAD"]).trim(), before);

    const res = json(runCli(["merge-abort", "--path", wt, "--to", before]));
    assert.deepEqual(res, { aborted: false, rolledBackTo: before });
    assert.equal(gitIn(wt, ["rev-parse", "HEAD"]).trim(), before, "no longer diverged");
  });

  it("merge-abort --to never touches a merge that is already on the PR", () => {
    const wt = prWorktree(207, { "pr-207.txt": "pr\n" });
    advanceMain({ "main-207.txt": "main\n" });
    const out = json(runCli(["merge-main", "--path", wt]));
    json(runCli(["push", "--path", wt]));
    const pushed = gitIn(wt, ["rev-parse", "HEAD"]).trim();

    const res = json(runCli(["merge-abort", "--path", wt, "--to", out.before]));
    assert.deepEqual(res, { aborted: false, rolledBackTo: null });
    assert.equal(gitIn(wt, ["rev-parse", "HEAD"]).trim(), pushed);
  });
});
