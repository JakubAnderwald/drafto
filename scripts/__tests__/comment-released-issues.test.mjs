import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  main,
  parseReleaseIssuesEnv,
  unionCandidates,
  _setExecFileForTests,
} from "../comment-released-issues.mjs";

// The Fastlane "now live" hook. Two behaviours pinned here (ADR-0042):
//   - DRAFTO_RELEASE_ISSUES (set by the nightly support runner through
//     dispatch-release.mjs --release-issues) is unioned with the tag-range
//     `Closes #N` refs, so a build announces the fixes it was dispatched for
//     even when the tag walk misses them;
//   - an issue is announced once per platform: any existing
//     `<!-- now-live:<platform>:… -->` since its latest close suppresses a new
//     one, whatever the build number.
// All git / gh calls are injected; nothing touches the network.

afterEach(() => _setExecFileForTests(null));

const ARGV = [
  "--platform",
  "android",
  "--build",
  "120",
  "--track",
  "Google Play internal track (build 120)",
  "--tag-prefix",
  "mobile@",
  "--paths",
  "apps/mobile/,packages/shared/",
];

function harness({ logBodies = "", supportIssues = [], comments = {} }) {
  const posted = [];
  const calls = [];
  _setExecFileForTests(async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (line.startsWith("git tag --list")) return { stdout: "mobile@1.0.0+android.119\n" };
    if (line.startsWith("git rev-parse")) {
      return { stdout: line.includes("HEAD") ? "head\n" : "tagsha\n" };
    }
    if (line.startsWith("git log")) return { stdout: logBodies };
    if (line.includes("issues?labels=support")) return { stdout: JSON.stringify(supportIssues) };
    const m = /issues\/(\d+)\/comments/.exec(line);
    if (m) return { stdout: JSON.stringify(comments[m[1]] ?? []) };
    if (line.startsWith("gh issue comment")) {
      posted.push({ issue: Number(args[2]), body: args[args.indexOf("--body") + 1] });
      return { stdout: "" };
    }
    throw new Error(`unmocked: ${line}`);
  });
  return { posted, calls };
}

describe("parseReleaseIssuesEnv / unionCandidates", () => {
  it("reads issue numbers and skips anything else", () => {
    assert.deepEqual(parseReleaseIssuesEnv("658, 661,abc,,0,-3"), [658, 661]);
    assert.deepEqual(parseReleaseIssuesEnv(undefined), []);
  });

  it("unions and sorts", () => {
    assert.deepEqual(unionCandidates([661, 12], [658, 661]), [12, 658, 661]);
  });
});

describe("comment-released-issues main", () => {
  it("announces an env-supplied issue the tag range missed", async () => {
    const h = harness({
      logBodies: "",
      supportIssues: [{ number: 658, closed_at: "2026-10-05T22:25:31Z" }],
    });
    const out = await main(ARGV, { DRAFTO_RELEASE_ISSUES: "658" });
    assert.deepEqual(out.commented, [658]);
    assert.equal(h.posted.length, 1);
    assert.match(h.posted[0].body, /^Now live in Google Play internal track \(build 120\)\./);
    assert.match(h.posted[0].body, /<!-- drafto-progress -->/);
    assert.match(h.posted[0].body, /<!-- now-live:android:120 -->/);
  });

  it("still intersects env-supplied issues with the support label", async () => {
    const h = harness({ supportIssues: [{ number: 10, closed_at: null }] });
    const out = await main(ARGV, { DRAFTO_RELEASE_ISSUES: "658" });
    assert.deepEqual(out.skippedNonSupport, [658]);
    assert.equal(h.posted.length, 0);
  });

  it("unions the tag range with the env list", async () => {
    const h = harness({
      logBodies: "fix: a thing\n\nCloses #700\x00",
      supportIssues: [
        { number: 658, closed_at: "2026-10-05T22:25:31Z" },
        { number: 700, closed_at: "2026-10-06T00:00:00Z" },
      ],
    });
    const out = await main(ARGV, { DRAFTO_RELEASE_ISSUES: "658" });
    assert.deepEqual(out.commented, [658, 700]);
    assert.deepEqual(
      h.posted.map((p) => p.issue),
      [658, 700],
    );
  });

  it("skips an issue already announced for the platform by ANY build", async () => {
    const h = harness({
      logBodies: "Closes #658\x00",
      supportIssues: [{ number: 658, closed_at: "2026-10-05T22:25:31Z" }],
      comments: {
        658: [
          {
            body: "Now live in Google Play internal track (build 118). <!-- drafto-progress --> <!-- now-live:android:118 -->",
            created_at: "2026-10-06T01:00:00Z",
          },
        ],
      },
    });
    const out = await main(ARGV, {});
    assert.deepEqual(out.skipped, [658]);
    assert.equal(h.posted.length, 0);
  });

  it("does not let another platform's notice suppress this one", async () => {
    const h = harness({
      logBodies: "Closes #658\x00",
      supportIssues: [{ number: 658, closed_at: "2026-10-05T22:25:31Z" }],
      comments: {
        658: [{ body: "<!-- now-live:ios:44 -->", created_at: "2026-10-06T01:00:00Z" }],
      },
    });
    const out = await main(ARGV, {});
    assert.deepEqual(out.commented, [658]);
    assert.equal(h.posted.length, 1);
  });

  it("announces again after a reopen + re-fix (old notice predates the latest close)", async () => {
    const h = harness({
      logBodies: "Closes #658\x00",
      supportIssues: [{ number: 658, closed_at: "2026-10-07T12:00:00Z" }],
      comments: {
        658: [{ body: "<!-- now-live:android:110 -->", created_at: "2026-10-01T00:00:00Z" }],
      },
    });
    const out = await main(ARGV, {});
    assert.deepEqual(out.commented, [658]);
    assert.equal(h.posted.length, 1);
  });

  it("does nothing when there are no candidates at all", async () => {
    const h = harness({ supportIssues: [{ number: 658, closed_at: null }] });
    const out = await main(ARGV, {});
    assert.deepEqual(out, { commented: [], skipped: [], skippedNonSupport: [] });
    assert.ok(!h.calls.some((c) => c.includes("issues?labels=support")));
  });
});
