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
