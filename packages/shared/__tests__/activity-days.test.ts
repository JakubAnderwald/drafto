import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_QUEUE_MAX_DAYS,
  DRAFTO_CLIENT_TAGS,
  addDay,
  isDraftoClientTag,
  isUtcDay,
  normalizeActivityQueue,
  utcDay,
  withoutSent,
} from "../src";

const DAY_MS = 86_400_000;

/** <count> consecutive UTC days starting at <start>, oldest first. */
function consecutiveDays(start: string, count: number): string[] {
  const first = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(first + i * DAY_MS).toISOString().slice(0, 10),
  );
}

describe("utcDay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats a date as YYYY-MM-DD", () => {
    expect(utcDay(new Date("2026-11-13T12:34:56.789Z"))).toBe("2026-11-13");
  });

  it("switches day exactly at midnight UTC", () => {
    expect(utcDay(new Date("2026-03-01T23:59:59.999Z"))).toBe("2026-03-01");
    expect(utcDay(new Date("2026-03-02T00:00:00.000Z"))).toBe("2026-03-02");
  });

  // The server compares days to (now() at time zone 'UTC')::date, so a device
  // has to name the UTC day, never the wall-clock day where the user is.
  it("uses the UTC date, not the wall-clock date of the zone the time was taken in", () => {
    // 20:00 in New York on 1 March is already 01:00 UTC on 2 March.
    expect(utcDay(new Date("2026-03-01T20:00:00-05:00"))).toBe("2026-03-02");
    // 08:30 in Tokyo on 2 March is still 23:30 UTC on 1 March.
    expect(utcDay(new Date("2026-03-02T08:30:00+09:00"))).toBe("2026-03-01");
  });

  it("handles year ends and leap days", () => {
    expect(utcDay(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12-31");
    expect(utcDay(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01-01");
    expect(utcDay(new Date("2028-02-29T12:00:00.000Z"))).toBe("2028-02-29");
  });

  it("defaults to now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T23:59:59.999Z"));
    expect(utcDay()).toBe("2026-11-13");

    vi.setSystemTime(new Date("2026-11-14T00:00:00.000Z"));
    expect(utcDay()).toBe("2026-11-14");
  });

  it("always returns a day isUtcDay accepts", () => {
    expect(isUtcDay(utcDay())).toBe(true);
    expect(isUtcDay(utcDay(new Date(0)))).toBe(true);
  });
});

describe("isUtcDay", () => {
  it.each(["2026-11-13", "2026-01-01", "2026-12-31", "2028-02-29", "2026-02-28"])(
    "accepts the real date %s",
    (value) => {
      expect(isUtcDay(value)).toBe(true);
    },
  );

  it.each([
    "2026-1-13",
    "2026-11-1",
    "26-11-13",
    "2026/11/13",
    "20261113",
    "13-11-2026",
    "2026-11-13T00:00:00.000Z",
    "2026-11-13 ",
    " 2026-11-13",
    "2026-11-13\n",
    "2026-11-1a",
    "+02026-11-13",
    "",
  ])("rejects the badly formatted %j", (value) => {
    expect(isUtcDay(value)).toBe(false);
  });

  // `new Date("2026-02-30T00:00:00Z")` quietly rolls over to 2 March, so these
  // only fail because isUtcDay checks the parsed date round-trips.
  it.each([
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-11-00",
    "2026-11-32",
  ])("rejects the impossible date %s", (value) => {
    expect(isUtcDay(value)).toBe(false);
  });

  // JS round-trips year 0, but Postgres's date type has no year 0, so one
  // such day would make record_activity reject the whole queue.
  it.each(["0000-01-01", "0000-12-31"])("rejects the year-0 date %s", (value) => {
    expect(isUtcDay(value)).toBe(false);
  });

  it("still accepts year 1, which Postgres's date type has", () => {
    expect(isUtcDay("0001-01-01")).toBe(true);
  });

  it.each([
    null,
    undefined,
    20261113,
    true,
    new Date("2026-11-13T00:00:00.000Z"),
    ["2026-11-13"],
    { day: "2026-11-13" },
  ])("rejects the non-string %j", (value) => {
    expect(isUtcDay(value)).toBe(false);
  });
});

describe("normalizeActivityQueue", () => {
  // A queue is read back from device storage, so it may be missing or corrupt.
  it.each([undefined, null, "2026-11-13", '["2026-11-13"]', 42, { days: ["2026-11-13"] }])(
    "reads the non-array %j as an empty queue",
    (value) => {
      expect(normalizeActivityQueue(value)).toEqual([]);
    },
  );

  it("reads an empty array as an empty queue", () => {
    expect(normalizeActivityQueue([])).toEqual([]);
  });

  it("drops entries that aren't valid days", () => {
    expect(
      normalizeActivityQueue(["2026-11-13", "nope", null, 5, "2026-02-30", {}, "2026-11-12"]),
    ).toEqual(["2026-11-12", "2026-11-13"]);
  });

  it("removes duplicates and sorts oldest first", () => {
    expect(
      normalizeActivityQueue(["2026-11-13", "2026-11-01", "2026-11-13", "2025-12-31"]),
    ).toEqual(["2025-12-31", "2026-11-01", "2026-11-13"]);
  });

  it(`keeps only the newest ${ACTIVITY_QUEUE_MAX_DAYS} days by default`, () => {
    const days = consecutiveDays("2026-10-01", ACTIVITY_QUEUE_MAX_DAYS + 10);
    const result = normalizeActivityQueue([...days].reverse());
    expect(result).toHaveLength(ACTIVITY_QUEUE_MAX_DAYS);
    expect(result).toEqual(days.slice(-ACTIVITY_QUEUE_MAX_DAYS));
  });

  it("removes duplicates before applying the cap, so a repeated day pushes nothing out", () => {
    const days = consecutiveDays("2026-10-01", ACTIVITY_QUEUE_MAX_DAYS);
    const withRepeats = [...days, days[0], days[0], days[ACTIVITY_QUEUE_MAX_DAYS - 1]];
    expect(normalizeActivityQueue(withRepeats)).toEqual(days);
  });

  it("takes a custom maximum", () => {
    const days = consecutiveDays("2026-11-01", 5);
    expect(normalizeActivityQueue(days, 3)).toEqual(days.slice(-3));
    expect(normalizeActivityQueue(days, 5)).toEqual(days);
    expect(normalizeActivityQueue(days, 10)).toEqual(days);
  });

  it.each([0, -1])("keeps nothing with a maximum of %d", (max) => {
    expect(normalizeActivityQueue(["2026-11-12", "2026-11-13"], max)).toEqual([]);
  });

  it("leaves the input untouched", () => {
    const input = Object.freeze(["2026-11-13", "2026-11-01", "2026-11-13"]);
    normalizeActivityQueue(input);
    expect(input).toEqual(["2026-11-13", "2026-11-01", "2026-11-13"]);
  });
});

describe("addDay", () => {
  it("adds a day to an empty queue", () => {
    expect(addDay([], "2026-11-13")).toEqual(["2026-11-13"]);
  });

  it("keeps the queue oldest first", () => {
    expect(addDay(["2026-11-10", "2026-11-12"], "2026-11-11")).toEqual([
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ]);
  });

  it("doesn't add a day that is already queued", () => {
    expect(addDay(["2026-11-12", "2026-11-13"], "2026-11-13")).toEqual([
      "2026-11-12",
      "2026-11-13",
    ]);
  });

  it(`caps the queue at ${ACTIVITY_QUEUE_MAX_DAYS} days, dropping the oldest`, () => {
    const full = consecutiveDays("2026-10-01", ACTIVITY_QUEUE_MAX_DAYS);
    const newest = consecutiveDays("2026-10-01", ACTIVITY_QUEUE_MAX_DAYS + 1)[
      ACTIVITY_QUEUE_MAX_DAYS
    ];

    const result = addDay(full, newest);

    expect(result).toHaveLength(ACTIVITY_QUEUE_MAX_DAYS);
    expect(result[0]).toBe(full[1]);
    expect(result[result.length - 1]).toBe(newest);
  });

  it("drops an older day when the queue is already full of newer ones", () => {
    const full = consecutiveDays("2026-10-01", ACTIVITY_QUEUE_MAX_DAYS);
    expect(addDay(full, "2026-09-30")).toEqual(full);
  });

  it("ignores a value that isn't a valid day", () => {
    expect(addDay(["2026-11-12"], "2026-02-30")).toEqual(["2026-11-12"]);
    expect(addDay(["2026-11-12"], "today")).toEqual(["2026-11-12"]);
  });

  it("takes a custom maximum", () => {
    expect(addDay(["2026-11-11", "2026-11-12"], "2026-11-13", 2)).toEqual([
      "2026-11-12",
      "2026-11-13",
    ]);
  });

  it("returns a new array and leaves the queue untouched", () => {
    const queue = Object.freeze(["2026-11-12"]);
    const result = addDay(queue, "2026-11-13");
    expect(result).not.toBe(queue);
    expect(queue).toEqual(["2026-11-12"]);
  });
});

describe("withoutSent", () => {
  it("removes the sent days and keeps the rest in order", () => {
    expect(
      withoutSent(["2026-11-10", "2026-11-11", "2026-11-12"], ["2026-11-10", "2026-11-12"]),
    ).toEqual(["2026-11-11"]);
  });

  // The native flush re-reads the queue after the call returns: a day queued
  // while the call was in flight has to survive.
  it("keeps a day queued after the sent batch was taken", () => {
    expect(
      withoutSent(["2026-11-11", "2026-11-12", "2026-11-13"], ["2026-11-11", "2026-11-12"]),
    ).toEqual(["2026-11-13"]);
  });

  it("ignores sent days that aren't queued", () => {
    expect(withoutSent(["2026-11-13"], ["2026-11-01", "2026-11-02"])).toEqual(["2026-11-13"]);
  });

  it("returns an empty queue when everything was sent", () => {
    expect(withoutSent(["2026-11-12", "2026-11-13"], ["2026-11-13", "2026-11-12"])).toEqual([]);
  });

  it("returns a copy, not the queue itself, when nothing was sent", () => {
    const queue = Object.freeze(["2026-11-12", "2026-11-13"]);
    const result = withoutSent(queue, []);
    expect(result).toEqual(["2026-11-12", "2026-11-13"]);
    expect(result).not.toBe(queue);
  });
});

describe("isDraftoClientTag", () => {
  // usage_daily's check constraint and record_activity mirror this exact list.
  it("lists the five x-drafto-client tags", () => {
    expect(DRAFTO_CLIENT_TAGS).toEqual([
      "web",
      "mobile-ios",
      "mobile-android",
      "desktop-macos",
      "web-mcp",
    ]);
  });

  it.each(DRAFTO_CLIENT_TAGS)("accepts %s", (tag) => {
    expect(isDraftoClientTag(tag)).toBe(true);
  });

  // "mobile" is mobile's fallback header when the platform is unknown, and
  // "web-cron" tags server-side writes: neither may reach record_activity.
  it.each([
    "mobile",
    "web-cron",
    "",
    "WEB",
    " web",
    "web ",
    "desktop",
    null,
    undefined,
    1,
    ["web"],
  ])("rejects %j", (value) => {
    expect(isDraftoClientTag(value)).toBe(false);
  });
});
