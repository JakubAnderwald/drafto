import { describe, expect, it } from "vitest";
import { compareNewestFirst, type NotebookOrderFields } from "@/lib/notebooks/order";

interface Row extends NotebookOrderFields {
  id: string;
}

function row(id: string, updated_at: string): Row {
  return { id, updated_at };
}

function sortedIds(rows: Row[]): string[] {
  return [...rows].sort(compareNewestFirst).map((r) => r.id);
}

describe("compareNewestFirst", () => {
  it("sorts the newest updated_at first", () => {
    const rows = [
      row("oldest", "2026-11-20T08:00:00.000Z"),
      row("newest", "2026-11-24T08:00:00.000Z"),
      row("middle", "2026-11-22T08:00:00.000Z"),
    ];

    expect(sortedIds(rows)).toEqual(["newest", "middle", "oldest"]);
  });

  it("returns a negative number when the first row is newer and a positive one when older", () => {
    const newer = row("newer", "2026-11-24T10:00:00Z");
    const older = row("older", "2026-11-24T09:00:00Z");

    expect(compareNewestFirst(newer, older)).toBeLessThan(0);
    expect(compareNewestFirst(older, newer)).toBeGreaterThan(0);
  });

  it("keeps the input order for rows with the same timestamp", () => {
    const rows = [
      row("first", "2026-11-24T10:00:00.000Z"),
      row("newer", "2026-11-24T11:00:00.000Z"),
      row("second", "2026-11-24T10:00:00.000Z"),
      row("third", "2026-11-24T10:00:00.000Z"),
    ];

    expect(sortedIds(rows)).toEqual(["newer", "first", "second", "third"]);
  });

  it("treats the same instant in PostgREST and ISO form as a tie", () => {
    const postgrest = row("postgrest", "2026-11-24T10:00:00.000000+00:00");
    const iso = row("iso", "2026-11-24T10:00:00.000Z");

    expect(compareNewestFirst(postgrest, iso)).toBe(0);
    expect(compareNewestFirst(iso, postgrest)).toBe(0);
    expect(sortedIds([postgrest, iso])).toEqual(["postgrest", "iso"]);
    expect(sortedIds([iso, postgrest])).toEqual(["iso", "postgrest"]);
  });

  it("orders PostgREST microsecond timestamps against each other", () => {
    const rows = [
      row("earlier", "2026-11-24T10:00:00.123456+00:00"),
      row("later", "2026-11-24T10:00:00.654321+00:00"),
    ];

    expect(sortedIds(rows)).toEqual(["later", "earlier"]);
  });

  it("orders a PostgREST microsecond timestamp against a Z ISO string", () => {
    const postgrest = row("postgrest", "2026-11-24T10:00:00.123456+00:00");
    const iso = row("iso", "2026-11-24T10:00:00.5Z");

    expect(sortedIds([postgrest, iso])).toEqual(["iso", "postgrest"]);
    expect(sortedIds([iso, postgrest])).toEqual(["iso", "postgrest"]);
  });

  it("compares offsets as instants, not as strings", () => {
    // 10:30+01:00 is 09:30Z, half an hour before 10:00Z, though it sorts after it as a string.
    const offset = row("offset", "2026-11-24T10:30:00.000000+01:00");
    const utc = row("utc", "2026-11-24T10:00:00.000Z");
    expect(offset.updated_at > utc.updated_at).toBe(true);

    expect(sortedIds([offset, utc])).toEqual(["utc", "offset"]);
    expect(compareNewestFirst(offset, utc)).toBeGreaterThan(0);
  });

  it("compares two different offsets as instants", () => {
    // 10:30+01:00 is 09:30Z; 09:45+00:00 is fifteen minutes later.
    const plusOne = row("plus-one", "2026-11-24T10:30:00.000000+01:00");
    const utc = row("utc", "2026-11-24T09:45:00.000000+00:00");

    expect(sortedIds([plusOne, utc])).toEqual(["utc", "plus-one"]);
  });

  it("sorts unparseable timestamps last", () => {
    const rows = [
      row("garbage", "not a date"),
      row("older", "2026-11-20T08:00:00.000Z"),
      row("empty", ""),
      row("newer", "2026-11-24T08:00:00.000000+00:00"),
    ];

    const ids = sortedIds(rows);
    expect(ids.slice(0, 2)).toEqual(["newer", "older"]);
    expect(ids.slice(2)).toEqual(["garbage", "empty"]);
  });

  it("puts a parseable timestamp before an unparseable one in either argument order", () => {
    const valid = row("valid", "1970-01-01T00:00:00.000Z");
    const invalid = row("invalid", "not a date");

    expect(compareNewestFirst(valid, invalid)).toBeLessThan(0);
    expect(compareNewestFirst(invalid, valid)).toBeGreaterThan(0);
  });

  it("ties two unparseable timestamps instead of returning NaN", () => {
    const a = row("a", "not a date");
    const b = row("b", "");

    expect(compareNewestFirst(a, b)).toBe(0);
    expect(compareNewestFirst(b, a)).toBe(0);
    expect(sortedIds([a, b])).toEqual(["a", "b"]);
    expect(sortedIds([b, a])).toEqual(["b", "a"]);
  });
});
