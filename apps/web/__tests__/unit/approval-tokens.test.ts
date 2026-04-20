import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({
  env: {
    APPROVAL_LINK_SECRET: "test-secret-must-be-at-least-32-chars-long!",
  },
}));

const { signApprovalToken, verifyApprovalToken } = await import("@/lib/approval-tokens");

describe("approval-tokens", () => {
  const now = new Date("2026-04-20T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs and verifies a token round-trip", () => {
    const token = signApprovalToken("user-123");
    const verified = verifyApprovalToken(token);
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe("user-123");
    expect(verified?.expiresAt).toBeGreaterThan(now.getTime());
  });

  it("rejects an expired token", () => {
    const token = signApprovalToken("user-123");
    vi.setSystemTime(new Date(now.getTime() + 73 * 60 * 60 * 1000));
    expect(verifyApprovalToken(token)).toBeNull();
  });

  it("rejects a token with a tampered userId", () => {
    const token = signApprovalToken("user-123");
    const parts = token.split(".");
    parts[1] = "attacker";
    const tampered = parts.join(".");
    expect(verifyApprovalToken(tampered)).toBeNull();
  });

  it("rejects a token with a tampered signature", () => {
    const token = signApprovalToken("user-123");
    const parts = token.split(".");
    parts[3] = "a".repeat(parts[3].length);
    const tampered = parts.join(".");
    expect(verifyApprovalToken(tampered)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyApprovalToken("not-a-token")).toBeNull();
    expect(verifyApprovalToken("a.b.c")).toBeNull();
    expect(verifyApprovalToken("")).toBeNull();
  });

  it("rejects a token with wrong version prefix", () => {
    const token = signApprovalToken("user-123");
    const parts = token.split(".");
    parts[0] = "v0";
    expect(verifyApprovalToken(parts.join("."))).toBeNull();
  });
});
