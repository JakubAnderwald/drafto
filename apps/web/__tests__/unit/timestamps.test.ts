import { describe, expect, it } from "vitest";

import { maxTimestamp, toEpochMs } from "@/lib/timestamps";

/**
 * The whole reason this module exists is that the same instant reaches the browser
 * in two spellings — PostgREST's ISO-8601 and Realtime's raw Postgres text — so the
 * cases that matter most are the cross-format ones.
 */
describe("toEpochMs", () => {
  const INSTANT = Date.UTC(2026, 8, 6, 12, 34, 56, 789);

  it("parses the ISO-8601 form PostgREST returns", () => {
    expect(toEpochMs("2026-09-06T12:34:56.789012+00:00")).toBe(INSTANT);
  });

  it("parses the raw Postgres text form Realtime forwards", () => {
    expect(toEpochMs("2026-09-06 12:34:56.789012+00")).toBe(INSTANT);
  });

  it("treats both wire formats of the same instant as equal", () => {
    expect(toEpochMs("2026-09-06 12:34:56.789012+00")).toBe(
      toEpochMs("2026-09-06T12:34:56.789012+00:00"),
    );
  });

  it("parses a Z-suffixed timestamp", () => {
    expect(toEpochMs("2026-09-06T12:34:56.789Z")).toBe(INSTANT);
  });

  it("expands a four-digit offset", () => {
    expect(toEpochMs("2026-09-06T12:34:56.789+0000")).toBe(INSTANT);
  });

  it("honours a non-UTC offset rather than assuming UTC", () => {
    // 14:34:56+02:00 is the same instant as 12:34:56Z.
    expect(toEpochMs("2026-09-06 14:34:56.789012+02")).toBe(INSTANT);
  });

  it("truncates sub-millisecond precision instead of failing to parse", () => {
    expect(toEpochMs("2026-09-06T12:34:56.789999+00:00")).toBe(INSTANT);
  });

  it("handles a timestamp with no fractional seconds", () => {
    expect(toEpochMs("2026-09-06 12:34:56+00")).toBe(Date.UTC(2026, 8, 6, 12, 34, 56));
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["an unparseable string", "not-a-timestamp"],
  ])("returns -Infinity for %s so it always compares as oldest", (_label, input) => {
    expect(toEpochMs(input)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("orders timestamps correctly across the two wire formats", () => {
    const older = toEpochMs("2026-09-06T12:34:56.000+00:00");
    const newer = toEpochMs("2026-09-06 12:34:57.000000+00");
    expect(newer).toBeGreaterThan(older);
  });
});

describe("maxTimestamp", () => {
  it("returns the later of two timestamps", () => {
    expect(maxTimestamp("2026-09-06T10:00:00Z", "2026-09-06T11:00:00Z")).toBe(
      "2026-09-06T11:00:00Z",
    );
  });

  it("compares by instant, not lexically, across wire formats", () => {
    // Lexically "2026-09-06 12:00:00+00" sorts before the ISO form because a space
    // precedes "T"; by instant it is the later of the two.
    expect(maxTimestamp("2026-09-06T11:00:00.000+00:00", "2026-09-06 12:00:00+00")).toBe(
      "2026-09-06 12:00:00+00",
    );
  });

  it("preserves the server's own formatting of the winner", () => {
    expect(maxTimestamp("2026-09-06 09:00:00+00", "2026-09-06T08:00:00.000+00:00")).toBe(
      "2026-09-06 09:00:00+00",
    );
  });

  it("returns the other side when one is null", () => {
    expect(maxTimestamp(null, "2026-09-06T10:00:00Z")).toBe("2026-09-06T10:00:00Z");
    expect(maxTimestamp("2026-09-06T10:00:00Z", null)).toBe("2026-09-06T10:00:00Z");
  });

  it("returns null when both are null", () => {
    expect(maxTimestamp(null, null)).toBeNull();
  });

  it("prefers the first argument on an exact tie", () => {
    expect(maxTimestamp("2026-09-06T10:00:00Z", "2026-09-06T10:00:00.000Z")).toBe(
      "2026-09-06T10:00:00Z",
    );
  });
});
