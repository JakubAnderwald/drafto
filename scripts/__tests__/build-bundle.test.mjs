import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInboundThreadBundle, buildGithubCommentBatchBundle } from "../lib/build-bundle.mjs";
import {
  bumpCounters,
  bumpNotification,
  THREAD_24H_CAP,
  ADMIN_NOTIFY_COOLDOWN_MS,
} from "../lib/policy.mjs";
import { emptyState } from "../lib/state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "build-bundle.mjs");

const NOW = "2026-04-27T12:00:00.000Z";
const OAUTH_USER = "support@drafto.eu";
const ALLOWLIST = "jakub@anderwald.info,joanna@anderwald.info";
const ADMIN_EMAIL = "jakub@anderwald.info";

function basePending(overrides = {}) {
  return {
    threadId: "T-100",
    messageId: "M-100",
    folderId: "F-INBOX",
    subject: "Help with PDF export",
    fromAddress: "jane@example.com",
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    allowlist: ALLOWLIST,
    adminEmail: ADMIN_EMAIL,
    oauthUserEmail: OAUTH_USER,
    phase: "D",
    ...overrides,
  };
}

describe("buildInboundThreadBundle — shape", () => {
  it("produces a kind=inbound_thread bundle with normalised thread", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: { threadId: "T-100", messages: [{ messageId: "M-100" }] },
      headers: { From: "jane@example.com" },
      state: emptyState(),
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.kind, "inbound_thread");
    assert.equal(bundle.thread.threadId, "T-100");
    assert.equal(bundle.thread.messages.length, 1);
    assert.equal(bundle.config.phase, "D");
    assert.deepEqual(bundle.config.allowlist, ["jakub@anderwald.info", "joanna@anderwald.info"]);
    assert.equal(bundle.config.adminEmail, ADMIN_EMAIL);
    assert.equal(bundle.config.oauthUserEmail, OAUTH_USER);
  });

  it("normalises a raw [<msg>...] thread array into {threadId, messages}", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: [{ messageId: "M-100" }, { messageId: "M-99" }],
      headers: {},
      state: emptyState(),
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.thread.threadId, "T-100");
    assert.equal(bundle.thread.messages.length, 2);
  });

  it("falls back to the pending entry as the only message when thread is null", () => {
    const pending = basePending({ threadId: null });
    const bundle = buildInboundThreadBundle({
      pending,
      thread: null,
      headers: {},
      state: emptyState(),
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.thread.threadId, null);
    assert.equal(bundle.thread.messages.length, 1);
    assert.equal(bundle.thread.messages[0].messageId, "M-100");
    // Singletons key off messageId for tracking.
    assert.equal(bundle.state.trackKey, "M-100");
  });
});

describe("buildInboundThreadBundle — humanIntervened detection", () => {
  it("flags humanIntervened when the latest message is from the OAuth user", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending({ fromAddress: OAUTH_USER }),
      thread: null,
      headers: { From: OAUTH_USER },
      state: emptyState(),
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.state.humanIntervened, true);
  });

  it("does NOT flag humanIntervened when the OAuth user's reply is auto-replied", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending({ fromAddress: OAUTH_USER }),
      thread: null,
      headers: { "Auto-Submitted": "auto-replied" },
      state: emptyState(),
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.state.humanIntervened, false);
  });

  it("is case-insensitive on the OAuth-user comparison", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending({ fromAddress: "Support@Drafto.EU" }),
      thread: null,
      headers: {},
      state: emptyState(),
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.state.humanIntervened, true);
  });

  it("returns false when the latest sender is the customer", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: {},
      state: emptyState(),
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.state.humanIntervened, false);
  });
});

describe("buildInboundThreadBundle — rateLimitOk and envelope guard", () => {
  it("rateLimitOk=true for a fresh thread + benign headers", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: { "Content-Type": "text/plain" },
      state: emptyState(),
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.state.rateLimitOk, true);
    assert.equal(bundle.state.rateLimitReason, null);
  });

  it("rateLimitOk=false when Auto-Submitted is set (loop guard)", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: { "Auto-Submitted": "auto-replied" },
      state: emptyState(),
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.state.rateLimitOk, false);
    assert.match(bundle.state.rateLimitReason, /Auto-Submitted/);
  });

  it("rateLimitOk=false when Precedence: bulk", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: { Precedence: "bulk" },
      state: emptyState(),
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.state.rateLimitOk, false);
    assert.match(bundle.state.rateLimitReason, /Precedence/);
  });

  it("rateLimitOk=false after THREAD_24H_CAP auto-replies in 24h", () => {
    const state = emptyState();
    for (let i = 0; i < THREAD_24H_CAP; i++) {
      bumpCounters(
        state,
        "T-100",
        "jane@example.com",
        new Date(Date.parse(NOW) - (i + 1) * 60_000).toISOString(),
      );
    }
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: {},
      state,
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.state.rateLimitOk, false);
    assert.match(bundle.state.rateLimitReason, /thread cap/);
  });

  it("envelope guard wins over rate-limit when both trip", () => {
    const state = emptyState();
    for (let i = 0; i < THREAD_24H_CAP; i++) {
      bumpCounters(
        state,
        "T-100",
        "jane@example.com",
        new Date(Date.parse(NOW) - (i + 1) * 60_000).toISOString(),
      );
    }
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: { "Auto-Submitted": "auto-replied" },
      state,
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.state.rateLimitOk, false);
    assert.match(bundle.state.rateLimitReason, /Auto-Submitted/);
  });
});

describe("buildInboundThreadBundle — shouldNotifyAdmin cooldown", () => {
  it("true on a fresh thread", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: {},
      state: emptyState(),
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.state.shouldNotifyAdmin, true);
  });

  it("false within the 24h cooldown after a notification was bumped", () => {
    const state = emptyState();
    bumpNotification(state, "T-100", NOW);
    const within = new Date(Date.parse(NOW) + ADMIN_NOTIFY_COOLDOWN_MS - 60_000).toISOString();
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: {},
      state,
      config: baseConfig(),
      nowIso: within,
    });
    assert.equal(bundle.state.shouldNotifyAdmin, false);
  });

  it("history surfaces the prior cooldown stamp for Claude to see", () => {
    const state = emptyState();
    bumpNotification(state, "T-100", NOW);
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: {},
      state,
      config: baseConfig(),
      nowIso: NOW,
    });
    assert.equal(bundle.history.lastAdminNotificationAt, NOW);
  });
});

describe("buildInboundThreadBundle — config normalisation", () => {
  it("parses a CSV allowlist into a lowercase list", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: {},
      state: emptyState(),
      config: baseConfig({ allowlist: " Jakub@Anderwald.info , joanna@anderwald.info " }),
      nowIso: NOW,
    });
    assert.deepEqual(bundle.config.allowlist, ["jakub@anderwald.info", "joanna@anderwald.info"]);
  });

  it("accepts a pre-parsed array allowlist", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: {},
      state: emptyState(),
      config: baseConfig({
        allowlist: ["JAKUB@anderwald.info", "joanna@anderwald.info"],
      }),
      nowIso: NOW,
    });
    assert.deepEqual(bundle.config.allowlist, ["jakub@anderwald.info", "joanna@anderwald.info"]);
  });

  it("defaults phase to D when missing", () => {
    const cfg = baseConfig();
    delete cfg.phase;
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: {},
      state: emptyState(),
      config: cfg,
      nowIso: NOW,
    });
    assert.equal(bundle.config.phase, "D");
  });

  it("preserves an explicit Phase E for forward-compat", () => {
    const bundle = buildInboundThreadBundle({
      pending: basePending(),
      thread: null,
      headers: {},
      state: emptyState(),
      config: baseConfig({ phase: "E" }),
      nowIso: NOW,
    });
    assert.equal(bundle.config.phase, "E");
  });
});

describe("buildGithubCommentBatchBundle (Phase F)", () => {
  it("produces a kind=github_comment_batch bundle with normalised comment shape", () => {
    const bundle = buildGithubCommentBatchBundle({
      issue: { number: 42, title: "Bug: PDF export", state: "OPEN" },
      comments: [
        {
          id: 1,
          user: { login: "customer" },
          body: "Still broken",
          created_at: "2026-04-28T12:00:00.000Z",
        },
        // gh issue list returns `author.login` instead of `user.login`; the
        // builder must normalise both into the prompt's `{user: {login}}`
        // shape so the prompt logic stays uniform.
        {
          id: 2,
          author: { login: "another" },
          body: "Also affected",
          createdAt: "2026-04-28T13:00:00.000Z",
        },
      ],
      zohoThreadId: "8537837000999",
    });
    assert.equal(bundle.kind, "github_comment_batch");
    assert.equal(bundle.issue.number, 42);
    assert.equal(bundle.issue.title, "Bug: PDF export");
    assert.equal(bundle.issue.state, "OPEN");
    assert.equal(bundle.zoho_thread_id, "8537837000999");
    assert.equal(bundle.comments.length, 2);
    assert.equal(bundle.comments[0].user.login, "customer");
    assert.equal(bundle.comments[0].createdAt, "2026-04-28T12:00:00.000Z");
    assert.equal(bundle.comments[1].user.login, "another");
    assert.equal(bundle.comments[1].createdAt, "2026-04-28T13:00:00.000Z");
  });

  it("defaults missing fields rather than throwing — pre-filtering keeps these rare", () => {
    const bundle = buildGithubCommentBatchBundle({});
    assert.equal(bundle.issue.number, null);
    assert.equal(bundle.issue.title, "");
    assert.equal(bundle.comments.length, 0);
    assert.equal(bundle.zoho_thread_id, "");
  });

  it("CLI dispatches on `kind` to the github_comment_batch builder", () => {
    const input = {
      kind: "github_comment_batch",
      issue: { number: 7, title: "Hi", state: "OPEN" },
      comments: [
        { id: 1, user: { login: "c" }, body: "hi", created_at: "2026-04-28T00:00:00.000Z" },
      ],
      zohoThreadId: "T-1",
    };
    const r = spawnSync("node", [CLI], {
      encoding: "utf8",
      input: JSON.stringify(input),
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.kind, "github_comment_batch");
    assert.equal(out.issue.number, 7);
    assert.equal(out.zoho_thread_id, "T-1");
  });
});
