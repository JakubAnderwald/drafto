import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main,
  findLastReleaseTag,
  findClosedIssueNumbers,
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
// And the tag walk: each platform's range starts at its own previous release
// (`--tag-glob 'mobile@*+<platform>.*'`, then `<tag-prefix>*`), newest by
// creatordate, skipping every tag on HEAD.
// The git / gh calls are injected, except in the real-git case at the end,
// which builds a throwaway repo; nothing touches the network.

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

// `tags` maps a `git tag --list` glob to the tags it lists (newest first, as
// `--sort=-creatordate` would); a glob mapped to an Error makes that call fail.
// `commits` maps a tag to its commit; anything unlisted resolves to a commit of
// its own, and HEAD to "head".
const DEFAULT_TAGS = { "mobile@*": ["mobile@1.0.0+android.119"] };

function harness({
  logBodies = "",
  supportIssues = [],
  comments = {},
  tags = DEFAULT_TAGS,
  commits = {},
}) {
  const posted = [];
  const calls = [];
  const gitCwds = [];
  _setExecFileForTests(async (cmd, args, opts = {}) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (cmd === "git") gitCwds.push({ line, cwd: opts.cwd });
    if (cmd === "git" && args[0] === "tag" && args[1] === "--list") {
      const listed = tags[args[2]] ?? [];
      if (listed instanceof Error) throw listed;
      return { stdout: listed.map((t) => `${t}\n`).join("") };
    }
    if (cmd === "git" && args[0] === "rev-parse") {
      if (args[1] === "HEAD") return { stdout: "head\n" };
      if (args[1] === "--show-toplevel") return { stdout: "/repo-root\n" };
      const tag = args[1].replace(/\^\{commit\}$/, "");
      if (commits[tag] instanceof Error) throw commits[tag];
      return { stdout: `${commits[tag] ?? `sha-of-${tag}`}\n` };
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
  return { posted, calls, gitCwds };
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

describe("comment-released-issues tag walk", () => {
  const ANDROID = [...ARGV, "--tag-glob", "mobile@*+android.*"];
  const tagLists = (calls) => calls.filter((c) => c.startsWith("git tag --list"));
  const logRange = (calls) => calls.find((c) => c.startsWith("git log")).split(" ")[2];

  it("starts the Android walk at the last Android tag, even when an iOS tag sorts higher", async () => {
    const h = harness({
      tags: {
        "mobile@*+android.*": ["mobile@1.7.0+android.88"],
        "mobile@*": ["mobile@1.7.0+ios.80", "mobile@1.7.0+android.88"],
      },
    });
    await main(ANDROID, {});
    assert.deepEqual(tagLists(h.calls), ["git tag --list mobile@*+android.* --sort=-creatordate"]);
    assert.equal(logRange(h.calls), "mobile@1.7.0+android.88..HEAD");
  });

  it("skips every tag on HEAD, not just the newest", async () => {
    const h = harness({
      tags: {
        "mobile@*+android.*": [
          "mobile@1.7.0+android.90",
          "mobile@1.7.0+android.89",
          "mobile@1.7.0+android.88",
        ],
      },
      commits: { "mobile@1.7.0+android.90": "head", "mobile@1.7.0+android.89": "head" },
    });
    await main(ANDROID, {});
    assert.ok(h.calls.includes("git rev-parse mobile@1.7.0+android.89^{commit}"));
    assert.equal(logRange(h.calls), "mobile@1.7.0+android.88..HEAD");
  });

  it("falls back to <tag-prefix>* when the platform has no tag off HEAD", async () => {
    const h = harness({
      tags: {
        "mobile@*+android.*": ["mobile@1.7.0+android.88"],
        "mobile@*": ["mobile@1.7.0+android.88", "mobile@1.7.0+ios.80"],
      },
      commits: { "mobile@1.7.0+android.88": "head" },
    });
    await main(ANDROID, {});
    assert.deepEqual(tagLists(h.calls), [
      "git tag --list mobile@*+android.* --sort=-creatordate",
      "git tag --list mobile@* --sort=-creatordate",
    ]);
    assert.equal(logRange(h.calls), "mobile@1.7.0+ios.80..HEAD");
  });

  it("falls back to <tag-prefix>* when the platform has never been tagged", async () => {
    const h = harness({ tags: { "mobile@*": ["mobile@1.6.0+ios.70"] } });
    await main(ANDROID, {});
    assert.equal(logRange(h.calls), "mobile@1.6.0+ios.70..HEAD");
  });

  it("treats a failing tag listing as no tags for that glob", async () => {
    const h = harness({
      tags: {
        "mobile@*+android.*": new Error("git exploded"),
        "mobile@*": ["mobile@1.6.0+ios.70"],
      },
    });
    await main(ANDROID, {});
    assert.equal(logRange(h.calls), "mobile@1.6.0+ios.70..HEAD");
  });

  it("skips a tag that does not resolve to a commit", async () => {
    const h = harness({
      tags: { "mobile@*+android.*": ["mobile@1.7.0+android.89", "mobile@1.7.0+android.88"] },
      commits: { "mobile@1.7.0+android.89": new Error("not a commit") },
    });
    await main(ANDROID, {});
    assert.equal(logRange(h.calls), "mobile@1.7.0+android.88..HEAD");
  });

  it("runs every git call after --show-toplevel from the repository root", async () => {
    const h = harness({ tags: { "mobile@*+android.*": ["mobile@1.7.0+android.88"] } });
    await main(ANDROID, {});
    assert.equal(h.gitCwds[0].line, "git rev-parse --show-toplevel");
    const rest = h.gitCwds.slice(1);
    assert.ok(rest.some((c) => c.line.startsWith("git log")));
    for (const c of rest) assert.equal(c.cwd, "/repo-root", c.line);
  });

  it("warns when the --tag-glob falls through to <tag-prefix>*", async () => {
    harness({ tags: { "mobile@*": ["mobile@1.6.0+ios.70"] } });
    const written = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    try {
      await main(ANDROID, {});
    } finally {
      process.stderr.write = original;
    }
    assert.ok(
      written.some((w) =>
        w.includes("warning: no mobile@*+android.* tag off HEAD, fell back to mobile@*"),
      ),
      written.join(""),
    );
  });

  it("walks all of HEAD when no glob leaves a tag", async () => {
    const h = harness({ tags: {} });
    await main(ANDROID, {});
    assert.equal(logRange(h.calls), "HEAD");
  });

  it("lists only <tag-prefix>* without --tag-glob (desktop)", async () => {
    const desktop = ARGV.map((a) => (a === "mobile@" ? "desktop@" : a));
    const h = harness({ tags: { "desktop@*": ["desktop@0.5.0+105"] } });
    await main(desktop, {});
    assert.deepEqual(tagLists(h.calls), ["git tag --list desktop@* --sort=-creatordate"]);
    assert.equal(logRange(h.calls), "desktop@0.5.0+105..HEAD");
  });

  it("lists a --tag-glob equal to <tag-prefix>* once", async () => {
    const h = harness({ tags: {} });
    await main([...ARGV, "--tag-glob", "mobile@*"], {});
    assert.deepEqual(tagLists(h.calls), ["git tag --list mobile@* --sort=-creatordate"]);
  });

  it("logs the range and the glob that picked its tag", async () => {
    harness({ tags: { "mobile@*": ["mobile@1.6.0+ios.70"] } });
    const written = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    try {
      await main(ANDROID, {});
    } finally {
      process.stderr.write = original;
    }
    assert.ok(
      written.includes(
        "comment-released-issues: range mobile@1.6.0+ios.70..HEAD (from mobile@*)\n",
      ),
      written.join(""),
    );
  });

  it("findLastReleaseTag reports which glob picked the tag", async () => {
    harness({
      tags: { "mobile@*+ios.*": [], "mobile@*": ["mobile@1.7.0+android.88"] },
    });
    assert.deepEqual(await findLastReleaseTag({ globs: ["mobile@*+ios.*", "mobile@*"] }), {
      tag: "mobile@1.7.0+android.88",
      glob: "mobile@*",
    });
    assert.deepEqual(await findLastReleaseTag({ globs: ["mobile@*+ios.*"] }), {
      tag: "",
      glob: null,
    });
  });
});

// Real git, to pin what `--sort=-creatordate` and `^{commit}` actually do. The
// history: Android 88 ships, a support fix lands, iOS 81 ships, one more commit
// is HEAD. The Android build must start at android.88 — starting at the newer
// iOS tag would hide #700, which Android never shipped.
describe("findLastReleaseTag against a real repo", () => {
  let d;
  let n = 0;
  // The code under test runs git with the inherited process.env, so the git
  // plumbing variables a hook sets (GIT_DIR, …) are cleared there for this
  // block, or `git init` / `commit` / `tag` would act on the real repository.
  // Global and system config are ignored too, so a global hooksPath or signing
  // setting can't change the result.
  const ISOLATE = {
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const saved = {};
  const g = (args, env = {}) => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      { cwd: d, encoding: "utf8", env: { ...process.env, ...env } },
    );
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  // One commit per day, so creatordate ordering never depends on timing.
  const commit = (msg) => {
    n += 1;
    const date = `2026-01-${String(n).padStart(2, "0")}T12:00:00Z`;
    mkdirSync(join(d, "apps/mobile"), { recursive: true });
    writeFileSync(join(d, "apps/mobile/f.txt"), msg);
    g(["add", "-A"]);
    g(["commit", "-q", "--no-verify", "-m", msg], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  };
  const PATHS = ["apps/mobile/"];

  before(() => {
    for (const [key, value] of Object.entries(ISOLATE)) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _setExecFileForTests(null);
    d = mkdtempSync(join(tmpdir(), "drafto-now-live-"));
    g(["init", "-q", "-b", "main"]);
    commit("feat: shipped in android 88");
    g(["tag", "mobile@1.7.0+android.88"]);
    commit("fix: the support fix\n\nCloses #700");
    commit("chore: shipped in ios 81");
    g(["tag", "mobile@1.7.0+ios.81"]);
    commit("feat: this release");
  });

  after(() => {
    if (d) rmSync(d, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("starts the Android walk at android.88, so #700 is announced", async () => {
    const out = await findLastReleaseTag({ globs: ["mobile@*+android.*", "mobile@*"], cwd: d });
    assert.deepEqual(out, { tag: "mobile@1.7.0+android.88", glob: "mobile@*+android.*" });
    assert.deepEqual(await findClosedIssueNumbers({ tag: out.tag, paths: PATHS, cwd: d }), [700]);
  });

  it("starts the iOS walk at ios.81, which already shipped #700", async () => {
    const out = await findLastReleaseTag({ globs: ["mobile@*+ios.*", "mobile@*"], cwd: d });
    assert.deepEqual(out, { tag: "mobile@1.7.0+ios.81", glob: "mobile@*+ios.*" });
    assert.deepEqual(await findClosedIssueNumbers({ tag: out.tag, paths: PATHS, cwd: d }), []);
  });

  it("main finds #700 when started inside apps/mobile, as Fastlane runs it", async () => {
    // Real git, run from the subdirectory unless main passes a cwd; gh mocked.
    const sub = join(d, "apps/mobile");
    const posted = [];
    _setExecFileForTests(async (cmd, args, opts = {}) => {
      if (cmd === "git") {
        const r = spawnSync(cmd, args, { cwd: opts.cwd ?? sub, encoding: "utf8" });
        if (r.status !== 0) throw new Error(r.stderr);
        return { stdout: r.stdout };
      }
      const line = `${cmd} ${args.join(" ")}`;
      if (line.includes("issues?labels=support")) {
        return { stdout: JSON.stringify([{ number: 700, closed_at: "2026-01-02T12:00:00Z" }]) };
      }
      if (/issues\/700\/comments/.test(line)) return { stdout: "[]" };
      if (line.startsWith("gh issue comment")) {
        posted.push(Number(args[2]));
        return { stdout: "" };
      }
      throw new Error(`unmocked: ${line}`);
    });
    try {
      const out = await main([...ARGV, "--tag-glob", "mobile@*+android.*"], {});
      assert.deepEqual(out.commented, [700]);
      assert.deepEqual(posted, [700]);
    } finally {
      _setExecFileForTests(null);
    }
  });

  it("skips tags on HEAD and orders by date, not version", async () => {
    g(["tag", "mobile@1.7.0+android.89"]);
    g(["tag", "mobile@1.8.0+ios.99", "HEAD~2"]);
    // An annotated tag on HEAD, dated after everything else so it lists first.
    // Its own object id is not HEAD's; only `^{commit}` peels it to HEAD.
    g(["tag", "-a", "-m", "annotated", "mobile@1.7.0+android.90"], {
      GIT_COMMITTER_DATE: "2026-02-01T12:00:00Z",
    });
    try {
      // android.90 and android.89 are on HEAD, so android.88 still wins.
      assert.equal(
        (await findLastReleaseTag({ globs: ["mobile@*+android.*"], cwd: d })).tag,
        "mobile@1.7.0+android.88",
      );
      // ios.99 sorts first by version (1.8.0) but sits on older history; by
      // date, ios.81 is still the newest iOS release off HEAD.
      assert.equal(
        (await findLastReleaseTag({ globs: ["mobile@*+ios.*"], cwd: d })).tag,
        "mobile@1.7.0+ios.81",
      );
    } finally {
      g(["tag", "-d", "mobile@1.7.0+android.89", "mobile@1.8.0+ios.99", "mobile@1.7.0+android.90"]);
    }
  });

  it("never picks a closed-testing tag (mobile-alpha@, mobile-beta@)", async () => {
    // On a newer commit than android.88, so either would win if git matched it.
    g(["tag", "mobile-alpha@1.7.0+android.95", "HEAD~1"]);
    g(["tag", "mobile-beta@1.7.0+android.96", "HEAD~1"]);
    try {
      assert.equal(
        (await findLastReleaseTag({ globs: ["mobile@*+android.*", "mobile@*"], cwd: d })).tag,
        "mobile@1.7.0+android.88",
      );
      const listed = g(["tag", "--list", "mobile@*"]).split("\n").filter(Boolean);
      assert.deepEqual(listed.sort(), ["mobile@1.7.0+android.88", "mobile@1.7.0+ios.81"]);
    } finally {
      g(["tag", "-d", "mobile-alpha@1.7.0+android.95", "mobile-beta@1.7.0+android.96"]);
    }
  });
});
