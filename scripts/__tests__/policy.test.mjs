import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAutoReplyableEnvelope,
  isBlockedSenderAddress,
  checkRateLimit,
  bumpCounters,
  humanIntervened,
  shouldNotifyAdmin,
  bumpNotification,
  parseAllowlist,
  isAllowlistedSender,
  THREAD_24H_CAP,
  SENDER_1H_CAP,
  DAILY_GLOBAL_CAP,
  ADMIN_NOTIFY_COOLDOWN_MS,
} from "../lib/policy.mjs";
import { emptyState } from "../lib/state.mjs";

describe("isAutoReplyableEnvelope", () => {
  it("accepts ordinary mail", () => {
    const r = isAutoReplyableEnvelope({ From: "a@b.com", "Content-Type": "text/plain" });
    assert.equal(r.ok, true);
  });

  it("rejects Auto-Submitted: auto-replied", () => {
    const r = isAutoReplyableEnvelope({ "Auto-Submitted": "auto-replied" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /Auto-Submitted/);
  });

  it("accepts Auto-Submitted: no", () => {
    const r = isAutoReplyableEnvelope({ "Auto-Submitted": "no" });
    assert.equal(r.ok, true);
  });

  it("rejects Precedence: bulk/junk/list", () => {
    for (const v of ["bulk", "junk", "list"]) {
      const r = isAutoReplyableEnvelope({ Precedence: v });
      assert.equal(r.ok, false, `should reject Precedence: ${v}`);
    }
  });

  it("rejects DSN via X-Failed-Recipients", () => {
    const r = isAutoReplyableEnvelope({ "X-Failed-Recipients": "user@example.com" });
    assert.equal(r.ok, false);
  });

  it("rejects DSN via Content-Type multipart/report", () => {
    const r = isAutoReplyableEnvelope({
      "Content-Type": 'multipart/report; report-type="delivery-status"; boundary=x',
    });
    assert.equal(r.ok, false);
  });

  it("is case-insensitive on header names", () => {
    const r = isAutoReplyableEnvelope({ "auto-submitted": "auto-replied" });
    assert.equal(r.ok, false);
  });
});

describe("isBlockedSenderAddress", () => {
  it("blocks noreply variants", () => {
    for (const e of ["noreply@x.com", "no-reply@x.com", "NoReply@X.com"]) {
      assert.equal(isBlockedSenderAddress(e), true, `should block ${e}`);
    }
  });
  it("blocks postmaster and mailer-daemon", () => {
    assert.equal(isBlockedSenderAddress("postmaster@x.com"), true);
    assert.equal(isBlockedSenderAddress("mailer-daemon@x.com"), true);
  });
  it("allows ordinary senders", () => {
    assert.equal(isBlockedSenderAddress("jane@example.com"), false);
  });
});

describe("checkRateLimit", () => {
  const now = "2026-04-26T12:00:00.000Z";

  it("allows when state is empty", () => {
    const r = checkRateLimit(emptyState(), "T1", "jane@example.com", now);
    assert.equal(r.ok, true);
  });

  it("rejects after THREAD_24H_CAP hits in 24h", () => {
    const state = emptyState();
    state.threads["T1"] = {
      autoReplies: Array.from({ length: THREAD_24H_CAP }, (_, i) =>
        new Date(Date.parse(now) - (i + 1) * 60_000).toISOString(),
      ),
      lastAdminNotificationAt: null,
    };
    const r = checkRateLimit(state, "T1", "jane@example.com", now);
    assert.equal(r.ok, false);
    assert.match(r.reason, /thread cap/);
  });

  it("ignores thread hits older than 24h", () => {
    const state = emptyState();
    const old = new Date(Date.parse(now) - 25 * 60 * 60 * 1000).toISOString();
    state.threads["T1"] = {
      autoReplies: Array.from({ length: THREAD_24H_CAP + 5 }, () => old),
      lastAdminNotificationAt: null,
    };
    const r = checkRateLimit(state, "T1", "jane@example.com", now);
    assert.equal(r.ok, true);
  });

  it("rejects after SENDER_1H_CAP hits in 1h", () => {
    const state = emptyState();
    state.senders["jane@example.com"] = {
      autoReplies: Array.from({ length: SENDER_1H_CAP }, (_, i) =>
        new Date(Date.parse(now) - (i + 1) * 60_000).toISOString(),
      ),
    };
    const r = checkRateLimit(state, "T1", "jane@example.com", now);
    assert.equal(r.ok, false);
    assert.match(r.reason, /sender cap/);
  });

  it("rejects after DAILY_GLOBAL_CAP hits in a day", () => {
    const state = emptyState();
    state.global.autoRepliesByDay[now.slice(0, 10)] = DAILY_GLOBAL_CAP;
    const r = checkRateLimit(state, "T1", "jane@example.com", now);
    assert.equal(r.ok, false);
    assert.match(r.reason, /daily global cap/);
  });
});

describe("bumpCounters", () => {
  const now = "2026-04-26T12:00:00.000Z";

  it("appends thread + sender + global counters", () => {
    const state = emptyState();
    bumpCounters(state, "T1", "Jane@Example.com", now);
    assert.equal(state.threads["T1"].autoReplies.length, 1);
    assert.equal(state.senders["jane@example.com"].autoReplies.length, 1);
    assert.equal(state.global.autoRepliesByDay["2026-04-26"], 1);
  });

  it("prunes stale per-thread/per-sender entries on bump", () => {
    const state = emptyState();
    const old = new Date(Date.parse(now) - 25 * 60 * 60 * 1000).toISOString();
    state.threads["T1"] = { autoReplies: [old, old, old], lastAdminNotificationAt: null };
    bumpCounters(state, "T1", "jane@example.com", now);
    assert.equal(state.threads["T1"].autoReplies.length, 1);
  });

  it("prunes stale per-sender entries (older than 1h) on bump", () => {
    const state = emptyState();
    const oldHit = new Date(Date.parse(now) - 2 * 60 * 60 * 1000).toISOString();
    const recentHit = new Date(Date.parse(now) - 30 * 60 * 1000).toISOString();
    state.senders["jane@example.com"] = { autoReplies: [oldHit, recentHit, oldHit] };
    bumpCounters(state, "T1", "jane@example.com", now);
    // Only the recent hit + the new bump should survive.
    assert.equal(state.senders["jane@example.com"].autoReplies.length, 2);
    assert.ok(state.senders["jane@example.com"].autoReplies.includes(recentHit));
    assert.ok(state.senders["jane@example.com"].autoReplies.includes(now));
  });
});

describe("humanIntervened", () => {
  const oauthUser = "support@drafto.eu";

  it("returns false when last sender is the customer", () => {
    assert.equal(humanIntervened({ lastMessageFrom: "jane@example.com" }, oauthUser), false);
  });

  it("returns true when last sender is OAuth user with no Auto-Submitted marker", () => {
    assert.equal(humanIntervened({ lastMessageFrom: oauthUser }, oauthUser), true);
  });

  it("returns false when last sender is OAuth user with Auto-Submitted: auto-replied", () => {
    assert.equal(
      humanIntervened(
        { lastMessageFrom: oauthUser, lastMessageAutoSubmitted: "auto-replied" },
        oauthUser,
      ),
      false,
    );
  });

  it("treats Auto-Submitted: no as not-agent", () => {
    assert.equal(
      humanIntervened({ lastMessageFrom: oauthUser, lastMessageAutoSubmitted: "no" }, oauthUser),
      true,
    );
  });

  it("is case-insensitive on the email", () => {
    assert.equal(humanIntervened({ lastMessageFrom: "Support@Drafto.EU" }, oauthUser), true);
  });
});

describe("shouldNotifyAdmin / bumpNotification", () => {
  const now = "2026-04-26T12:00:00.000Z";

  it("allows the first notification", () => {
    assert.equal(shouldNotifyAdmin(emptyState(), "T1", now), true);
  });

  it("blocks within the cooldown window", () => {
    const state = emptyState();
    bumpNotification(state, "T1", now);
    const within = new Date(Date.parse(now) + ADMIN_NOTIFY_COOLDOWN_MS - 1000).toISOString();
    assert.equal(shouldNotifyAdmin(state, "T1", within), false);
  });

  it("allows again after the cooldown elapses", () => {
    const state = emptyState();
    bumpNotification(state, "T1", now);
    const after = new Date(Date.parse(now) + ADMIN_NOTIFY_COOLDOWN_MS + 1000).toISOString();
    assert.equal(shouldNotifyAdmin(state, "T1", after), true);
  });
});

describe("allowlist parsing & matching", () => {
  it("parses comma-separated, normalises case + whitespace", () => {
    assert.deepEqual(parseAllowlist(" Jakub@Anderwald.info , joanna@anderwald.info ,, "), [
      "jakub@anderwald.info",
      "joanna@anderwald.info",
    ]);
  });

  it("matches case-insensitively", () => {
    const list = parseAllowlist("jakub@anderwald.info,joanna@anderwald.info");
    assert.equal(isAllowlistedSender("Jakub@Anderwald.info", list), true);
    assert.equal(isAllowlistedSender("stranger@example.com", list), false);
  });

  it("accepts a raw env string (not pre-parsed)", () => {
    assert.equal(
      isAllowlistedSender("jakub@anderwald.info", "jakub@anderwald.info,joanna@anderwald.info"),
      true,
    );
  });
});
