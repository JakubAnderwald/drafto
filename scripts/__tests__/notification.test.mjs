import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldFireAdminNotification,
  bumpNotification,
  ADMIN_NOTIFY_COOLDOWN_MS,
} from "../lib/policy.mjs";
import { emptyState } from "../lib/state.mjs";

const ALLOWLIST = "jakub@anderwald.info,joanna@anderwald.info";
const NOW = "2026-04-26T12:00:00.000Z";

describe("shouldFireAdminNotification", () => {
  it("fires for a fresh escalation from a public sender", () => {
    const r = shouldFireAdminNotification(emptyState(), "T1", {
      sender: "stranger@example.com",
      allowlist: ALLOWLIST,
      humanIntervened: false,
      nowIso: NOW,
    });
    assert.equal(r.ok, true);
  });

  it("suppresses when sender is in the allowlist", () => {
    const r = shouldFireAdminNotification(emptyState(), "T1", {
      sender: "Jakub@anderwald.info",
      allowlist: ALLOWLIST,
      humanIntervened: false,
      nowIso: NOW,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "allowlisted-sender");
  });

  it("suppresses when humanIntervened is true", () => {
    const r = shouldFireAdminNotification(emptyState(), "T1", {
      sender: "stranger@example.com",
      allowlist: ALLOWLIST,
      humanIntervened: true,
      nowIso: NOW,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "humanIntervened");
  });

  it("respects the 24h cooldown per thread", () => {
    const state = emptyState();
    bumpNotification(state, "T1", NOW);
    const within = new Date(Date.parse(NOW) + ADMIN_NOTIFY_COOLDOWN_MS - 60_000).toISOString();
    const r = shouldFireAdminNotification(state, "T1", {
      sender: "stranger@example.com",
      allowlist: ALLOWLIST,
      humanIntervened: false,
      nowIso: within,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "cooldown");
  });

  it("fires again after the cooldown has elapsed", () => {
    const state = emptyState();
    bumpNotification(state, "T1", NOW);
    const after = new Date(Date.parse(NOW) + ADMIN_NOTIFY_COOLDOWN_MS + 60_000).toISOString();
    const r = shouldFireAdminNotification(state, "T1", {
      sender: "stranger@example.com",
      allowlist: ALLOWLIST,
      humanIntervened: false,
      nowIso: after,
    });
    assert.equal(r.ok, true);
  });

  it("each thread has its own cooldown", () => {
    const state = emptyState();
    bumpNotification(state, "T1", NOW);
    const r = shouldFireAdminNotification(state, "T2", {
      sender: "stranger@example.com",
      allowlist: ALLOWLIST,
      humanIntervened: false,
      nowIso: NOW,
    });
    assert.equal(r.ok, true);
  });

  it("a re-escalation on the same thread within the cooldown is suppressed", () => {
    const state = emptyState();
    const r1 = shouldFireAdminNotification(state, "T1", {
      sender: "stranger@example.com",
      allowlist: ALLOWLIST,
      humanIntervened: false,
      nowIso: NOW,
    });
    assert.equal(r1.ok, true);
    bumpNotification(state, "T1", NOW);

    // Customer replies an hour later, agent re-escalates.
    const oneHourLater = new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString();
    const r2 = shouldFireAdminNotification(state, "T1", {
      sender: "stranger@example.com",
      allowlist: ALLOWLIST,
      humanIntervened: false,
      nowIso: oneHourLater,
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, "cooldown");
  });
});
