import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

let lib;
let execCalls;

beforeEach(async () => {
  // Import fresh to reset the module-level `_execFileForTests` shim.
  lib = await import(`../lib/github-sync.mjs?t=${Date.now()}-${Math.random()}`);
  execCalls = [];
});

function makeExecFile(handlers) {
  return async (cmd, args) => {
    execCalls.push({ cmd, args });
    for (const { match, response } of handlers) {
      if (match(cmd, args)) {
        if (typeof response === "function") {
          const r = await response(cmd, args);
          return r;
        }
        return response;
      }
    }
    throw new Error(`unmatched exec: ${cmd} ${args.join(" ")}`);
  };
}

describe("filterNewComments (pure)", () => {
  const comments = [
    {
      id: 1,
      user: { login: "JakubAnderwald" },
      body: "bot",
      created_at: "2026-04-28T10:00:00.000Z",
    },
    {
      id: 2,
      user: { login: "customer" },
      body: "old",
      created_at: "2026-04-27T10:00:00.000Z",
    },
    {
      id: 3,
      user: { login: "customer" },
      body: "new1",
      created_at: "2026-04-28T11:00:00.000Z",
    },
    {
      id: 4,
      user: { login: "customer" },
      body: "new2",
      created_at: "2026-04-28T12:00:00.000Z",
    },
  ];

  it("filters out the bot user", async () => {
    const out = lib.filterNewComments(comments, "2026-04-28T00:00:00.000Z", "JakubAnderwald");
    const ids = out.map((c) => c.id);
    assert.deepEqual(ids, [3, 4]);
  });

  it("filters out comments older than the cursor", async () => {
    const out = lib.filterNewComments(comments, "2026-04-28T11:30:00.000Z", "JakubAnderwald");
    assert.deepEqual(
      out.map((c) => c.id),
      [4],
    );
  });

  it("treats missing cursor as the epoch (returns everything except the bot)", async () => {
    const out = lib.filterNewComments(comments, "", "JakubAnderwald");
    assert.deepEqual(
      out.map((c) => c.id),
      [2, 3, 4],
    );
  });

  it("rejects an invalid --since string instead of returning everything", async () => {
    assert.throws(
      () => lib.filterNewComments(comments, "not-a-date", "JakubAnderwald"),
      /not a valid ISO/,
    );
  });

  it("matches the bot user case-insensitively (GitHub usernames are case-insensitive)", async () => {
    const variant = [
      {
        id: 1,
        user: { login: "JAKUBANDERWALD" },
        body: "uppercase variant",
        created_at: "2026-04-28T11:00:00.000Z",
      },
      {
        id: 2,
        user: { login: "Customer" },
        body: "ok",
        created_at: "2026-04-28T12:00:00.000Z",
      },
    ];
    const out = lib.filterNewComments(variant, "2026-04-28T00:00:00.000Z", "JakubAnderwald");
    assert.deepEqual(
      out.map((c) => c.id),
      [2],
    );
  });

  it("forwards bot-authored comments carrying the progress marker (Phase G)", async () => {
    // The customer→GH→Zoho echo loop is broken by suppressing bot-authored
    // comments — but specific bot-authored comments (nightly-support's
    // "Working on it now", post-release-notes' "Now live in build X")
    // SHOULD reach the customer. The progress marker opts those in.
    const variant = [
      {
        id: 10,
        user: { login: "JakubAnderwald" },
        body: "Customer replied via support@drafto.eu: ...",
        created_at: "2026-04-28T11:00:00.000Z",
      },
      {
        id: 11,
        user: { login: "JakubAnderwald" },
        body: "Working on it now (from the nightly agent). <!-- drafto-progress -->",
        created_at: "2026-04-28T12:00:00.000Z",
      },
      {
        id: 12,
        user: { login: "JakubAnderwald" },
        body: "Now live in ios 1234. <!-- drafto-progress --> <!-- now-live:ios:1234 -->",
        created_at: "2026-04-28T13:00:00.000Z",
      },
    ];
    const out = lib.filterNewComments(variant, "2026-04-28T00:00:00.000Z", "JakubAnderwald");
    assert.deepEqual(
      out.map((c) => c.id),
      [11, 12],
    );
  });

  it("falls back to author.login when user.login is absent (gh json shape variant)", async () => {
    const variant = [
      {
        id: 99,
        author: { login: "JakubAnderwald" },
        body: "bot via gh issue list",
        created_at: "2026-04-28T11:00:00.000Z",
      },
      {
        id: 100,
        author: { login: "customer" },
        body: "ok",
        created_at: "2026-04-28T12:00:00.000Z",
      },
    ];
    const out = lib.filterNewComments(variant, "2026-04-28T00:00:00.000Z", "JakubAnderwald");
    assert.deepEqual(
      out.map((c) => c.id),
      [100],
    );
  });
});

describe("listSupportIssues (mocked gh)", () => {
  it("invokes `gh issue list` with the right flags and parses the JSON", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "issue" && args[1] === "list",
          response: {
            stdout: JSON.stringify([
              {
                number: 42,
                title: "test",
                state: "OPEN",
                body: "body",
                createdAt: "2026-04-28T10:00:00.000Z",
                labels: [{ name: "support" }],
              },
            ]),
          },
        },
      ]),
    );
    const issues = await lib.listSupportIssues({ state: "all", limit: 50 });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].number, 42);

    const args = execCalls[0].args;
    assert.deepEqual(args.slice(0, 2), ["issue", "list"]);
    assert.ok(args.includes("--label"));
    assert.ok(args.includes("support"));
    assert.ok(args.includes("--state"));
    assert.ok(args.includes("all"));
    assert.ok(args.includes("--limit"));
    assert.ok(args.includes("50"));
    assert.ok(
      args.includes("--json") &&
        args[args.indexOf("--json") + 1].includes("body") &&
        args[args.indexOf("--json") + 1].includes("createdAt"),
    );
  });
});

describe("findLinkedThread", () => {
  it("extracts zoho-thread-id from the issue body footer", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "issue" && args[1] === "view",
          response: {
            stdout: JSON.stringify({
              body: `## Description\n\nBug.\n\n<!-- drafto-support-agent v1\nreporter-email: jane@example.com\nreporter-allowlisted: false\nzoho-thread-id: 8537837000999\n-->`,
            }),
          },
        },
      ]),
    );
    const tid = await lib.findLinkedThread(123);
    assert.equal(tid, "8537837000999");
  });

  it("returns empty string when the issue has no footer", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "issue" && args[1] === "view",
          response: { stdout: JSON.stringify({ body: "no footer here" }) },
        },
      ]),
    );
    const tid = await lib.findLinkedThread(123);
    assert.equal(tid, "");
  });
});

describe("derivePlatforms (Phase G — pure)", () => {
  it("buckets web/mobile/desktop paths into the platform set", async () => {
    const out = lib.derivePlatforms([
      "apps/web/src/foo.ts",
      "apps/web/src/bar.ts",
      "apps/mobile/app/x.ts",
      "apps/desktop/src/y.ts",
    ]);
    assert.deepEqual(out, ["desktop", "mobile", "web"]);
  });

  it("ignores shared and root paths so we don't claim a single platform", async () => {
    const out = lib.derivePlatforms([
      "packages/shared/src/x.ts",
      "tsconfig.json",
      ".github/workflows/ci.yml",
    ]);
    assert.deepEqual(out, []);
  });

  it("accepts both string and {path} / {filename} shapes", async () => {
    const out = lib.derivePlatforms([
      "apps/web/a.ts",
      { path: "apps/mobile/b.ts" },
      { filename: "apps/desktop/c.ts" },
    ]);
    assert.deepEqual(out, ["desktop", "mobile", "web"]);
  });

  it("handles non-array / null input defensively", async () => {
    assert.deepEqual(lib.derivePlatforms(null), []);
    assert.deepEqual(lib.derivePlatforms(undefined), []);
    assert.deepEqual(lib.derivePlatforms("apps/web/a.ts"), []);
  });
});

describe("diffStateChanges (Phase G — pure)", () => {
  it("flags issues with no prior state as bootstrap (no email, just record)", async () => {
    const issues = [
      { number: 1, state: "OPEN", stateReason: null },
      { number: 2, state: "CLOSED", stateReason: "COMPLETED" },
    ];
    const changes = lib.diffStateChanges(issues, {});
    assert.equal(changes.length, 2);
    assert.ok(changes.every((c) => c.isBootstrap === true));
    assert.equal(changes[0].oldState, null);
    assert.equal(changes[0].newState.state, "open");
  });

  it("emits a change when state transitions", async () => {
    const issues = [{ number: 1, state: "CLOSED", stateReason: "completed" }];
    const known = { 1: { state: "open", state_reason: null } };
    const changes = lib.diffStateChanges(issues, known);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].isBootstrap, false);
    assert.deepEqual(changes[0].oldState, { state: "open", state_reason: null });
    assert.deepEqual(changes[0].newState, { state: "closed", state_reason: "completed" });
  });

  it("emits a change when only state_reason transitions (e.g. completed → not_planned)", async () => {
    const issues = [{ number: 1, state: "CLOSED", stateReason: "not_planned" }];
    const known = { 1: { state: "closed", state_reason: "completed" } };
    const changes = lib.diffStateChanges(issues, known);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].newState.state_reason, "not_planned");
  });

  it("emits no change when state and state_reason are unchanged", async () => {
    const issues = [{ number: 1, state: "CLOSED", stateReason: "completed" }];
    const known = { 1: { state: "closed", state_reason: "completed" } };
    assert.deepEqual(lib.diffStateChanges(issues, known), []);
  });

  it("treats string 'null' / empty / null as the same state_reason", async () => {
    const issues = [{ number: 1, state: "OPEN", stateReason: null }];
    const known = { 1: { state: "open", state_reason: "null" } };
    assert.deepEqual(lib.diffStateChanges(issues, known), []);
  });

  it("normalises state casing on both sides", async () => {
    const issues = [{ number: 1, state: "Closed", stateReason: "Completed" }];
    const known = { 1: { state: "closed", state_reason: "completed" } };
    assert.deepEqual(lib.diffStateChanges(issues, known), []);
  });
});

describe("extractIssueRefs (Phase G — pure)", () => {
  it("extracts Closes / Fixes / Resolves variants case-insensitively", async () => {
    const text = `feat: x

closes #123
Fixes #456
RESOLVES #789
fixed #1000
closed #2000
resolved #3000`;
    assert.deepEqual(lib.extractIssueRefs(text), [123, 456, 789, 1000, 2000, 3000]);
  });

  it("dedupes refs that appear multiple times", async () => {
    assert.deepEqual(lib.extractIssueRefs("Closes #1, fixes #1, also resolves #1"), [1]);
  });

  it("ignores #N references that lack a closing keyword", async () => {
    assert.deepEqual(lib.extractIssueRefs("see #99 for context"), []);
  });

  it("matches the long-form GitHub URL form too", async () => {
    const text = "Fixes https://github.com/JakubAnderwald/drafto/issues/42";
    assert.deepEqual(lib.extractIssueRefs(text), [42]);
  });

  it("returns [] for non-string / empty input", async () => {
    assert.deepEqual(lib.extractIssueRefs(null), []);
    assert.deepEqual(lib.extractIssueRefs(""), []);
    assert.deepEqual(lib.extractIssueRefs(undefined), []);
  });
});

describe("getStateChangeInfo (Phase G — mocked gh)", () => {
  it("returns zoho_thread_id, derived platforms, and the last non-bot comment", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        // 1) gh issue view --json body  → footer carries zoho-thread-id
        {
          match: (cmd, args) =>
            cmd === "gh" && args[0] === "issue" && args[1] === "view" && args.includes("body"),
          response: {
            stdout: JSON.stringify({
              body: `bug

<!-- drafto-support-agent v1
reporter-email: jane@example.com
reporter-allowlisted: false
zoho-thread-id: 8537837000999
-->`,
            }),
          },
        },
        // 2) gh issue view --json closedByPullRequestsReferences → PR #500
        {
          match: (cmd, args) =>
            cmd === "gh" &&
            args[0] === "issue" &&
            args[1] === "view" &&
            args.includes("closedByPullRequestsReferences"),
          response: {
            stdout: JSON.stringify({
              closedByPullRequestsReferences: [{ number: 500 }],
            }),
          },
        },
        // 3) gh pr view --json files → web + mobile paths
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "pr" && args[1] === "view",
          response: {
            stdout: JSON.stringify({
              files: [{ path: "apps/web/src/x.ts" }, { path: "apps/mobile/app/y.ts" }],
            }),
          },
        },
        // 4) gh api comments → most recent is from JakubAnderwald (bot, skip),
        //    second-newest is from a customer ("won't fix because too niche")
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "api",
          response: {
            stdout: JSON.stringify([
              { user: { login: "customer" }, body: "Too niche, sorry." },
              {
                user: { login: "JakubAnderwald" },
                body: "Working on it now <!-- drafto-progress -->",
              },
            ]),
          },
        },
      ]),
    );
    const info = await lib.getStateChangeInfo(42, { botUser: "JakubAnderwald" });
    assert.equal(info.zoho_thread_id, "8537837000999");
    assert.deepEqual(info.platforms, ["mobile", "web"]);
    assert.equal(info.lastComment, "Too niche, sorry.");
  });

  it("returns null lastComment when every comment is from the bot", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) =>
            cmd === "gh" && args[0] === "issue" && args[1] === "view" && args.includes("body"),
          response: { stdout: JSON.stringify({ body: "no footer" }) },
        },
        {
          match: (cmd, args) =>
            cmd === "gh" &&
            args[0] === "issue" &&
            args[1] === "view" &&
            args.includes("closedByPullRequestsReferences"),
          response: { stdout: JSON.stringify({ closedByPullRequestsReferences: [] }) },
        },
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "api",
          response: {
            stdout: JSON.stringify([{ user: { login: "JakubAnderwald" }, body: "Working on it" }]),
          },
        },
      ]),
    );
    const info = await lib.getStateChangeInfo(42, { botUser: "JakubAnderwald" });
    assert.equal(info.lastComment, null);
    assert.equal(info.zoho_thread_id, "");
    assert.deepEqual(info.platforms, []);
  });
});
