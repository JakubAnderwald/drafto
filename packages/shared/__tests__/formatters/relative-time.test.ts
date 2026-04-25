import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "../../src/formatters/relative-time";

describe("formatRelativeTime", () => {
  const now = new Date("2026-04-24T12:00:00.000Z");

  it('returns "just now" for the same instant', () => {
    expect(formatRelativeTime(now, { now })).toBe("just now");
  });

  it('returns "just now" for times less than a minute ago', () => {
    const date = new Date(now.getTime() - 30_000);
    expect(formatRelativeTime(date, { now })).toBe("just now");
  });

  it("returns minutes ago for times less than an hour ago", () => {
    const date = new Date(now.getTime() - 5 * 60_000);
    expect(formatRelativeTime(date, { now })).toBe("5m ago");
  });

  it("rounds minute boundaries down", () => {
    const date = new Date(now.getTime() - 59_999);
    expect(formatRelativeTime(date, { now })).toBe("just now");
  });

  it("returns hours ago for times less than a day ago", () => {
    const date = new Date(now.getTime() - 3 * 3_600_000);
    expect(formatRelativeTime(date, { now })).toBe("3h ago");
  });

  it("returns days ago for times less than 30 days ago", () => {
    const date = new Date(now.getTime() - 7 * 86_400_000);
    expect(formatRelativeTime(date, { now })).toBe("7d ago");
  });

  it("returns a locale date string for times more than 30 days ago", () => {
    const date = new Date(now.getTime() - 45 * 86_400_000);
    const result = formatRelativeTime(date, { now });
    expect(result).not.toContain("ago");
    expect(result).not.toBe("just now");
  });

  it("accepts ISO strings", () => {
    const date = new Date(now.getTime() - 2 * 3_600_000);
    expect(formatRelativeTime(date.toISOString(), { now })).toBe("2h ago");
  });

  it("accepts epoch milliseconds", () => {
    const date = new Date(now.getTime() - 10 * 60_000);
    expect(formatRelativeTime(date.getTime(), { now })).toBe("10m ago");
  });

  it("uses the current wall clock when no now is provided", () => {
    const result = formatRelativeTime(new Date());
    expect(result).toBe("just now");
  });
});
