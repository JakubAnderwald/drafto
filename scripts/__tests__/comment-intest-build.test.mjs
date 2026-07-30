import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  fingerprintMarker,
  buildBody,
  commentIntestBuild,
  _setExecFileForTests,
} from "../comment-intest-build.mjs";

afterEach(() => _setExecFileForTests(null));

// Record every gh invocation; `commentsBody` is what the fake issue already has.
function fakeGh({ commentsBody = "", failList = false } = {}) {
  const calls = [];
  _setExecFileForTests(async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === "api") {
      if (failList) throw new Error("gh api exploded");
      return { stdout: commentsBody };
    }
    return { stdout: "https://github.com/x/y/issues/1#issuecomment-1\n" };
  });
  return calls;
}

describe("fingerprintMarker", () => {
  it("is per platform+build and carries the drafto-factory prefix", () => {
    // The prefix is load-bearing: owner_comments_since skips bodies containing
    // "<!-- drafto-factory", so a build notice can't be read as feedback and
    // roll the card back to In Progress.
    assert.equal(fingerprintMarker("ios", 147), "<!-- drafto-factory-intest-build:ios:147 -->");
    assert.notEqual(fingerprintMarker("ios", 147), fingerprintMarker("ios", 148));
    assert.notEqual(fingerprintMarker("ios", 147), fingerprintMarker("macos", 147));
    assert.ok(fingerprintMarker("android", 1).startsWith("<!-- drafto-factory"));
  });
});

describe("buildBody", () => {
  it("names the platform, build, track, PR and sha, and flags it pre-merge", () => {
    const body = buildBody({
      platform: "ios",
      build: 147,
      track: "TestFlight",
      pr: 591,
      sha: "a1b2c3d4e5f6a7b8c9",
    });
    assert.match(body, /iOS beta build 147 is up/);
    assert.match(body, /TestFlight/);
    assert.match(body, /PR #591/);
    // sha is truncated to 12 chars for readability.
    assert.match(body, /`a1b2c3d4e5f6`/);
    assert.ok(!body.includes("c9"), "sha must be truncated");
    assert.match(body, /pre-merge/);
    assert.match(body, /<!-- drafto-factory-intest-build:ios:147 -->/);
  });

  it("humanises every platform token", () => {
    assert.match(buildBody({ platform: "android", build: 1, track: "t" }), /Android beta build/);
    assert.match(buildBody({ platform: "macos", build: 1, track: "t" }), /macOS beta build/);
  });

  it("omits the PR clause when no PR is known", () => {
    const body = buildBody({ platform: "ios", build: 9, track: "TestFlight" });
    assert.ok(!body.includes("from PR"));
    assert.match(body, /iOS beta build 9 is up/);
  });
});

describe("commentIntestBuild", () => {
  it("posts the comment when the fingerprint is absent", async () => {
    const calls = fakeGh({ commentsBody: "some unrelated comment\n" });
    const out = await commentIntestBuild({
      issue: 463,
      platform: "ios",
      build: 147,
      track: "TestFlight",
      pr: 591,
    });
    assert.equal(out.commented, true);
    const post = calls.find((c) => c.args[0] === "issue");
    assert.ok(post, "expected a gh issue comment call");
    assert.deepEqual(post.args.slice(0, 5), [
      "issue",
      "comment",
      "463",
      "--repo",
      "JakubAnderwald/drafto",
    ]);
  });

  it("is idempotent — skips when the fingerprint is already present", async () => {
    const calls = fakeGh({
      commentsBody: `earlier\n${fingerprintMarker("ios", 147)}\n`,
    });
    const out = await commentIntestBuild({
      issue: 463,
      platform: "ios",
      build: 147,
      track: "TestFlight",
    });
    assert.equal(out.commented, false);
    assert.equal(out.reason, "already-commented");
    assert.equal(calls.filter((c) => c.args[0] === "issue").length, 0, "must not post a duplicate");
  });

  it("still posts when the comment list can't be read", async () => {
    // A missing build notice is worse than a duplicate one.
    const calls = fakeGh({ failList: true });
    const out = await commentIntestBuild({
      issue: 463,
      platform: "macos",
      build: 45,
      track: "TestFlight macOS",
    });
    assert.equal(out.commented, true);
    assert.equal(calls.filter((c) => c.args[0] === "issue").length, 1);
  });

  it("does not confuse a different build's fingerprint for its own", async () => {
    const calls = fakeGh({ commentsBody: `${fingerprintMarker("ios", 146)}\n` });
    const out = await commentIntestBuild({
      issue: 463,
      platform: "ios",
      build: 147,
      track: "TestFlight",
    });
    assert.equal(out.commented, true);
    assert.equal(calls.filter((c) => c.args[0] === "issue").length, 1);
  });
});
