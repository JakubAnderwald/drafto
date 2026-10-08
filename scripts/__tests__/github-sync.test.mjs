import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "github-sync.mjs",
);

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

describe("runGh retry behaviour (transient gh failures)", () => {
  function makeFlakyExec(failures, finalResponse) {
    let calls = 0;
    return async (cmd, args) => {
      execCalls.push({ cmd, args });
      calls += 1;
      if (calls <= failures.length) {
        throw failures[calls - 1];
      }
      return finalResponse;
    };
  }

  function transientErr(message) {
    const e = new Error(`Command failed: gh ...\n${message}`);
    e.stderr = message;
    return e;
  }

  function permanentErr(message) {
    const e = new Error(`Command failed: gh ...\n${message}`);
    e.stderr = message;
    return e;
  }

  it("retries on HTTP 504 from GitHub and returns the eventual success", async () => {
    lib._setSleepForTests(async () => {});
    lib._setExecFileForTests(
      makeFlakyExec(
        [transientErr("HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)")],
        { stdout: JSON.stringify([{ number: 1 }]) },
      ),
    );
    const issues = await lib.listSupportIssues({ state: "all" });
    assert.equal(issues.length, 1);
    assert.equal(execCalls.length, 2);
  });

  it("retries on HTTP 502 / 503 / 429 / connection reset / i/o timeout", async () => {
    const transients = [
      "HTTP 502: 502 Bad Gateway",
      "HTTP 503: Service Unavailable",
      "HTTP 429: Too Many Requests",
      "dial tcp: connection reset by peer",
      'Get "https://api.github.com/...": net/http: TLS handshake timeout (i/o timeout)',
      "ETIMEDOUT",
      "EAI_AGAIN getaddrinfo",
    ];
    for (const msg of transients) {
      lib._setSleepForTests(async () => {});
      lib._setExecFileForTests(makeFlakyExec([transientErr(msg)], { stdout: JSON.stringify([]) }));
      execCalls = [];
      const issues = await lib.listSupportIssues({ state: "all" });
      assert.equal(issues.length, 0, `should retry on: ${msg}`);
      assert.equal(execCalls.length, 2, `should retry exactly once for: ${msg}`);
    }
  });

  it("does NOT retry on permanent errors (HTTP 404 / auth / parse)", async () => {
    lib._setSleepForTests(async () => {});
    lib._setExecFileForTests(
      makeFlakyExec([permanentErr("HTTP 404: Not Found")], { stdout: JSON.stringify([]) }),
    );
    await assert.rejects(() => lib.listSupportIssues({ state: "all" }), /404/);
    assert.equal(execCalls.length, 1);
  });

  it("gives up after the configured retry budget and surfaces the last error", async () => {
    lib._setSleepForTests(async () => {});
    lib._setExecFileForTests(
      makeFlakyExec(
        [
          transientErr("HTTP 504: Gateway Timeout"),
          transientErr("HTTP 504: Gateway Timeout"),
          transientErr("HTTP 504: Gateway Timeout"),
          transientErr("HTTP 504: Gateway Timeout"),
        ],
        { stdout: "[]" },
      ),
    );
    await assert.rejects(() => lib.listSupportIssues({ state: "all" }), /504/);
    // 1 initial attempt + 3 retries = 4 calls total
    assert.equal(execCalls.length, 4);
  });

  it("backs off between retries (sleep is invoked with growing delays)", async () => {
    const delays = [];
    lib._setSleepForTests(async (ms) => {
      delays.push(ms);
    });
    lib._setExecFileForTests(
      makeFlakyExec(
        [transientErr("HTTP 504: Gateway Timeout"), transientErr("HTTP 504: Gateway Timeout")],
        { stdout: "[]" },
      ),
    );
    await lib.listSupportIssues({ state: "all" });
    assert.deepEqual(delays, [1000, 2000]);
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
  it("returns zoho_thread_id, derived platforms, and the closing-actor comment within the time window", async () => {
    const closeTime = "2026-04-28T19:00:00Z";
    const sameTime = "2026-04-28T19:00:30Z"; // within 60s window
    const wayLater = "2026-04-28T20:00:00Z"; // outside window
    lib._setExecFileForTests(
      makeExecFile([
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
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "pr" && args[1] === "view",
          response: {
            stdout: JSON.stringify({
              files: [{ path: "apps/web/src/x.ts" }, { path: "apps/mobile/app/y.ts" }],
            }),
          },
        },
        {
          // events endpoint: most recent close was by `maintainer` at 19:00.
          match: (cmd, args) =>
            cmd === "gh" && args[0] === "api" && args.some((a) => a.endsWith("/events")),
          response: {
            stdout: JSON.stringify([
              {
                event: "labeled",
                actor: { login: "maintainer" },
                created_at: "2026-04-28T18:00:00Z",
              },
              { event: "closed", actor: { login: "maintainer" }, created_at: closeTime },
            ]),
          },
        },
        {
          // comments endpoint: an older customer comment (out-of-window),
          // a same-actor + same-time comment (the closing rationale),
          // and a much-later customer comment (also out-of-window).
          match: (cmd, args) =>
            cmd === "gh" && args[0] === "api" && args.some((a) => a.endsWith("/comments")),
          response: {
            stdout: JSON.stringify([
              {
                user: { login: "customer" },
                body: "Original report.",
                created_at: "2026-04-28T10:00:00Z",
              },
              {
                user: { login: "maintainer" },
                body: "Out of scope — see ROADMAP.",
                created_at: sameTime,
              },
              { user: { login: "customer" }, body: "Thanks for clarifying.", created_at: wayLater },
            ]),
          },
        },
      ]),
    );
    const info = await lib.getStateChangeInfo(42, { botUser: "JakubAnderwald" });
    assert.equal(info.zoho_thread_id, "8537837000999");
    assert.deepEqual(info.platforms, ["mobile", "web"]);
    assert.equal(info.lastComment, "Out of scope — see ROADMAP.");
  });

  it("returns null lastComment when no comment falls within the closing-actor / time window", async () => {
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
          match: (cmd, args) =>
            cmd === "gh" && args[0] === "api" && args.some((a) => a.endsWith("/events")),
          response: {
            stdout: JSON.stringify([
              {
                event: "closed",
                actor: { login: "maintainer" },
                created_at: "2026-04-28T19:00:00Z",
              },
            ]),
          },
        },
        {
          match: (cmd, args) =>
            cmd === "gh" && args[0] === "api" && args.some((a) => a.endsWith("/comments")),
          response: {
            // Reporter posted a comment hours later — wrong actor AND outside
            // the window. Must NOT be surfaced as the closing reason.
            stdout: JSON.stringify([
              {
                user: { login: "reporter" },
                body: "Bumping this.",
                created_at: "2026-04-29T03:00:00Z",
              },
              { user: { login: "JakubAnderwald" }, body: "Working on it" },
            ]),
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

describe("resolveIssueRoute (pure — issue #658)", () => {
  const FOOTER = {
    "reporter-email": "footer@evil.example",
    "zoho-thread-id": "FOOTER-T",
    "zoho-message-id": "FOOTER-M",
  };

  it("singleton filing: routes by the recorded message id, subject and reporter", () => {
    const route = lib.resolveIssueRoute({
      stateEntry: {
        reporterEmail: "Jakub@Anderwald.info",
        zohoMessageId: "1791172614617005600",
        zohoSubject: "Editor loses focus",
      },
      footer: { "reporter-email": "jakub@anderwald.info", "zoho-thread-id": "null" },
    });
    assert.deepEqual(route, {
      threadId: null,
      messageId: "1791172614617005600",
      subject: "Editor loses focus",
      to: "jakub@anderwald.info",
      routable: true,
    });
  });

  it("state wins over the footer for both ids", () => {
    const route = lib.resolveIssueRoute({
      stateEntry: { reporterEmail: "a@b.co", zohoThreadId: "STATE-T", zohoMessageId: "STATE-M" },
      footer: FOOTER,
    });
    assert.equal(route.threadId, "STATE-T");
    assert.equal(route.messageId, "STATE-M");
  });

  it("falls back to the footer ids when state has none (pre-fix issues)", () => {
    const route = lib.resolveIssueRoute({
      stateEntry: { reporterEmail: "a@b.co" },
      footer: FOOTER,
    });
    assert.equal(route.threadId, "FOOTER-T");
    assert.equal(route.messageId, "FOOTER-M");
    assert.equal(route.routable, true);
  });

  it("uses the footer all-or-nothing: a recorded message id blocks a footer thread id", () => {
    // Old prompts patched a guessed "ackThreadId" into the footer. A footer
    // thread id must never outrank the message route the runner recorded.
    const route = lib.resolveIssueRoute({
      stateEntry: { reporterEmail: "a@b.co", zohoMessageId: "STATE-M" },
      footer: FOOTER,
    });
    assert.equal(route.threadId, null);
    assert.equal(route.messageId, "STATE-M");
    assert.equal(route.routable, true);
    // Same the other way round: a recorded thread id ignores the footer message id.
    const threaded = lib.resolveIssueRoute({
      stateEntry: { reporterEmail: "a@b.co", zohoThreadId: "STATE-T" },
      footer: FOOTER,
    });
    assert.equal(threaded.threadId, "STATE-T");
    assert.equal(threaded.messageId, null);
  });

  it("re-exports the shared normaliseRouteValue", () => {
    assert.equal(lib.normaliseRouteValue(" null "), null);
    assert.equal(lib.normaliseRouteValue(" 42 "), "42");
  });

  it("treats a 'null' / 'undefined' state value as absent and still falls back", () => {
    const route = lib.resolveIssueRoute({
      stateEntry: { reporterEmail: "a@b.co", zohoThreadId: "null", zohoMessageId: "undefined" },
      footer: { "zoho-message-id": "FOOTER-M" },
    });
    assert.equal(route.threadId, null);
    assert.equal(route.messageId, "FOOTER-M");
  });

  it("never takes the recipient from the footer (ADR-0025)", () => {
    const route = lib.resolveIssueRoute({ stateEntry: null, footer: FOOTER });
    assert.equal(route.to, null);
    // The footer thread id is still a usable route (the thread path takes its
    // recipient from Zoho), so this stays routable…
    assert.equal(route.routable, true);
    // …but a footer message id alone, with no recorded reporter, is not.
    const msgOnly = lib.resolveIssueRoute({
      stateEntry: null,
      footer: { "reporter-email": "footer@evil.example", "zoho-message-id": "FOOTER-M" },
    });
    assert.equal(msgOnly.to, null);
    assert.equal(msgOnly.messageId, "FOOTER-M");
    assert.equal(msgOnly.routable, false);
  });

  it("never takes the subject from the footer", () => {
    const route = lib.resolveIssueRoute({
      stateEntry: { reporterEmail: "a@b.co", zohoMessageId: "M" },
      footer: { subject: "forged" },
    });
    assert.equal(route.subject, null);
  });

  it("is unroutable with no thread id and no message id (legacy issues)", () => {
    assert.deepEqual(lib.resolveIssueRoute({ stateEntry: { reporterEmail: "a@b.co" } }), {
      threadId: null,
      messageId: null,
      subject: null,
      to: "a@b.co",
      routable: false,
    });
    assert.equal(lib.resolveIssueRoute().routable, false);
    assert.equal(lib.resolveIssueRoute({ stateEntry: "junk", footer: "junk" }).routable, false);
  });
});

describe("getIssueRoute (state file + mocked gh)", () => {
  async function withState(contents, fn) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "github-sync-route-"));
    const file = path.join(dir, "state.json");
    try {
      if (contents != null) await fsp.writeFile(file, JSON.stringify(contents));
      await fn(file);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  const SINGLETON_BODY = `Repro steps.

<!-- drafto-support-agent v1
reporter-email: jakub@anderwald.info
reporter-allowlisted: true
zoho-thread-id: null
zoho-message-id: 1791172614617005600
-->`;

  it("uses the supplied body and makes no gh call", async () => {
    lib._setExecFileForTests(makeExecFile([]));
    await withState(
      { issues: { 658: { reporterEmail: "jakub@anderwald.info", zohoSubject: "Focus bug" } } },
      async (file) => {
        const route = await lib.getIssueRoute(658, { stateFile: file, body: SINGLETON_BODY });
        assert.equal(execCalls.length, 0);
        assert.deepEqual(route, {
          threadId: null,
          messageId: "1791172614617005600",
          subject: "Focus bug",
          to: "jakub@anderwald.info",
          routable: true,
        });
      },
    );
  });

  it("fetches the body via `gh issue view` when none is supplied", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) =>
            cmd === "gh" && args[0] === "issue" && args[1] === "view" && args[2] === "360",
          response: { stdout: JSON.stringify({ body: SINGLETON_BODY }) },
        },
      ]),
    );
    await withState({ issues: { 360: { reporterEmail: "x@y.co" } } }, async (file) => {
      const route = await lib.getIssueRoute(360, { stateFile: file });
      assert.equal(execCalls.length, 1);
      assert.equal(route.messageId, "1791172614617005600");
      assert.equal(route.to, "x@y.co");
    });
  });

  it("handles a missing state file (ENOENT) as an empty state", async () => {
    lib._setExecFileForTests(makeExecFile([]));
    await withState(null, async (file) => {
      const route = await lib.getIssueRoute(1, { stateFile: file, body: "no footer" });
      assert.equal(route.routable, false);
    });
  });
});

describe("github-sync issue-route CLI", () => {
  async function withDir(fn) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "github-sync-cli-"));
    try {
      await fn(dir);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  it("reads the body from stdin with --body-file - and prints the route JSON", async () => {
    await withDir(async (dir) => {
      const stateFile = path.join(dir, "state.json");
      await fsp.writeFile(
        stateFile,
        JSON.stringify({
          issues: {
            658: {
              reporterEmail: "jakub@anderwald.info",
              zohoMessageId: "1791172614617005600",
              zohoSubject: "Editor loses focus",
            },
          },
        }),
      );
      const r = spawnSync(
        "node",
        [CLI, "issue-route", "658", "--body-file", "-", "--state-file", stateFile],
        {
          encoding: "utf8",
          input: "<!-- drafto-support-agent v1\nzoho-thread-id: null\n-->",
        },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), {
        threadId: null,
        messageId: "1791172614617005600",
        subject: "Editor loses focus",
        to: "jakub@anderwald.info",
        routable: true,
      });
    });
  });

  it("reads the body from a file path and reports unroutable issues", async () => {
    await withDir(async (dir) => {
      const bodyFile = path.join(dir, "body.md");
      await fsp.writeFile(bodyFile, "Apps-Script-era issue, no footer");
      const r = spawnSync(
        "node",
        [
          CLI,
          "issue-route",
          "12",
          "--body-file",
          bodyFile,
          "--state-file",
          path.join(dir, "absent.json"),
        ],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).routable, false);
    });
  });

  it("requires an issue number", () => {
    const r = spawnSync("node", [CLI, "issue-route"], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /issue-route requires <issue-number>/);
  });
});

describe("getStateChangeInfo — singleton footer (issue #658)", () => {
  it("reports a footer `zoho-thread-id: null` as an empty string, not 'null'", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) =>
            cmd === "gh" && args[0] === "issue" && args[1] === "view" && args.includes("body"),
          response: {
            stdout: JSON.stringify({
              body: "x\n\n<!-- drafto-support-agent v1\nzoho-thread-id: null\n-->",
            }),
          },
        },
        {
          match: (cmd, args) =>
            cmd === "gh" && args[0] === "issue" && args.includes("closedByPullRequestsReferences"),
          response: { stdout: JSON.stringify({ closedByPullRequestsReferences: [] }) },
        },
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "api",
          response: { stdout: "[]" },
        },
      ]),
    );
    const info = await lib.getStateChangeInfo(658);
    assert.equal(info.zoho_thread_id, "");
  });

  it("skips the `gh issue view` body fetch when the caller supplies the body", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) =>
            cmd === "gh" && args[0] === "issue" && args.includes("closedByPullRequestsReferences"),
          response: { stdout: JSON.stringify({ closedByPullRequestsReferences: [] }) },
        },
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "api",
          response: { stdout: "[]" },
        },
      ]),
    );
    const info = await lib.getStateChangeInfo(349, {
      body: "<!-- drafto-support-agent v1\nzoho-thread-id: 1777397751089013400\n-->",
    });
    assert.equal(info.zoho_thread_id, "1777397751089013400");
    assert.equal(
      execCalls.some((c) => c.args[0] === "issue" && c.args.includes("body")),
      false,
      "no body fetch",
    );
  });
});
