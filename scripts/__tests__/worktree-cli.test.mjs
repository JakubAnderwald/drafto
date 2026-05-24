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
