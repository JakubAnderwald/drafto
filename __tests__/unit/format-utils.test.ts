import { describe, expect, it, vi, afterEach } from "vitest";
import { formatRelativeTime } from "@/lib/format-utils";

describe("formatRelativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for times less than a minute ago', () => {
    const now = new Date();
    expect(formatRelativeTime(now.toISOString())).toBe("just now");
  });

  it("returns minutes ago for times less than an hour ago", () => {
    const date = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatRelativeTime(date.toISOString())).toBe("5m ago");
  });

  it("returns hours ago for times less than a day ago", () => {
    const date = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(formatRelativeTime(date.toISOString())).toBe("3h ago");
  });

  it("returns days ago for times less than 30 days ago", () => {
    const date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(date.toISOString())).toBe("7d ago");
  });

  it("returns a formatted date for times more than 30 days ago", () => {
    const date = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const result = formatRelativeTime(date.toISOString());
    // Should return a locale date string, not a relative format
    expect(result).not.toContain("ago");
  });
});
