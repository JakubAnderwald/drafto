// Mirror of apps/mobile/__tests__/db/activity-days.test.ts; only TAG differs.
import { utcDay } from "@drafto/shared";
import type { ActivityRpcClient, ActivityRpcResponse } from "@drafto/shared";

import { flushActivityDays, markAppOpened } from "@/db/activity-days";

const TAG = "desktop-macos";
const KEY = "drafto_activity_days";

/** Noon UTC, <offset> days after 2026-11-13. */
function at(offset: number): Date {
  return new Date(Date.UTC(2026, 10, 13 + offset, 12));
}

function day(offset: number): string {
  return utcDay(at(offset));
}

/**
 * A database whose localStorage keeps JSON strings in memory, as WatermelonDB's
 * does, so a value that wouldn't survive a JSON round trip shows up here too.
 */
function makeDb(initial?: unknown) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(KEY, JSON.stringify(initial));
  const localStorage = {
    get: jest.fn(async (key: string): Promise<unknown> => {
      const json = store.get(key);
      return json === undefined ? undefined : JSON.parse(json);
    }),
    set: jest.fn(async (key: string, value: unknown): Promise<void> => {
      store.set(key, JSON.stringify(value));
    }),
  };
  const stored = (): unknown => {
    const json = store.get(KEY);
    return json === undefined ? undefined : JSON.parse(json);
  };
  return { db: { localStorage }, localStorage, stored };
}

function makeClient() {
  const rpc = jest
    .fn<Promise<ActivityRpcResponse>, [string, Record<string, unknown>]>()
    .mockResolvedValue({ error: null });
  const client: ActivityRpcClient = { rpc };
  return { client, rpc };
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("markAppOpened", () => {
  it("queues the UTC day, not the device's local one", async () => {
    const { db, stored } = makeDb();

    // 23:30 in New York on the 13th is already the 14th in UTC.
    await markAppOpened(db, new Date("2026-11-13T23:30:00-05:00"));

    expect(stored()).toEqual({ days: ["2026-11-14"], lastSent: null });
  });

  it("keeps one entry when the same day is marked twice", async () => {
    const { db, localStorage, stored } = makeDb();

    await markAppOpened(db, new Date("2026-11-13T01:00:00Z"));
    await markAppOpened(db, new Date("2026-11-13T22:00:00Z"));

    expect(stored()).toEqual({ days: ["2026-11-13"], lastSent: null });
    expect(localStorage.set).toHaveBeenCalledTimes(1);
  });

  it("keeps only the newest 30 days", async () => {
    const { db, stored } = makeDb();

    for (let offset = 0; offset < 35; offset += 1) await markAppOpened(db, at(offset));

    const expected = Array.from({ length: 30 }, (_, i) => day(i + 5));
    expect(stored()).toEqual({ days: expected, lastSent: null });
  });

  it.each([
    ["a string", "garbage"],
    ["a number", 42],
    ["null", null],
    ["an array", [day(-1)]],
    ["days that aren't an array", { days: day(-1), lastSent: "yesterday" }],
  ])("reads %s as an empty queue", async (_label, value) => {
    const { db, stored } = makeDb(value);

    await markAppOpened(db, at(0));

    expect(stored()).toEqual({ days: [day(0)], lastSent: null });
  });

  it("forgets a lastSent after today, which a clock running ahead sent", async () => {
    const { db, stored } = makeDb({ days: [day(0)], lastSent: day(2) });

    await markAppOpened(db, at(0));

    expect(stored()).toEqual({ days: [day(0)], lastSent: null });
  });

  it("drops invalid entries from a stored queue and keeps the valid ones", async () => {
    const { db, stored } = makeDb({ days: ["not-a-day", 7, day(-1), "2026-02-30"], lastSent: 5 });

    await markAppOpened(db, at(0));

    expect(stored()).toEqual({ days: [day(-1), day(0)], lastSent: null });
  });

  it("does nothing on a database without localStorage", async () => {
    await expect(markAppOpened({}, at(0))).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("never rejects when storage fails", async () => {
    const { db, localStorage } = makeDb();
    localStorage.get.mockRejectedValueOnce(new Error("disk I/O error"));

    await expect(markAppOpened(db, at(0))).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not queue"),
      expect.any(Error),
    );
  });

  it("never rejects on an invalid date", async () => {
    const { db, stored } = makeDb();

    await expect(markAppOpened(db, new Date(Number.NaN))).resolves.toBeUndefined();
    expect(stored()).toBeUndefined();
  });
});

describe("flushActivityDays", () => {
  it("sends every day opened while offline in one call, then empties the queue", async () => {
    const { db, stored } = makeDb();
    const { client, rpc } = makeClient();
    await markAppOpened(db, at(0));
    await markAppOpened(db, at(1));
    await markAppOpened(db, at(2));

    await flushActivityDays(db, client, TAG);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_activity", {
      p_days: [day(0), day(1), day(2)],
      p_client: TAG,
    });
    expect(stored()).toEqual({ days: [], lastSent: day(2) });
  });

  it("pings once a day: after today is sent, marking it again queues nothing", async () => {
    const { db, stored } = makeDb();
    const { client, rpc } = makeClient();
    await markAppOpened(db, at(0));
    await flushActivityDays(db, client, TAG);

    await markAppOpened(db, at(0));
    await flushActivityDays(db, client, TAG);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual({ days: [], lastSent: day(0) });
  });

  it("queues and sends the next UTC day again", async () => {
    const { db, stored } = makeDb();
    const { client, rpc } = makeClient();
    await markAppOpened(db, at(0));
    await flushActivityDays(db, client, TAG);

    await markAppOpened(db, at(1));
    await flushActivityDays(db, client, TAG);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith("record_activity", { p_days: [day(1)], p_client: TAG });
    expect(stored()).toEqual({ days: [], lastSent: day(1) });
  });

  it("sends the newest 30 days after a long offline stretch", async () => {
    const { db } = makeDb();
    const { client, rpc } = makeClient();
    for (let offset = 0; offset < 35; offset += 1) await markAppOpened(db, at(offset));

    await flushActivityDays(db, client, TAG);

    const expected = Array.from({ length: 30 }, (_, i) => day(i + 5));
    expect(rpc).toHaveBeenCalledWith("record_activity", { p_days: expected, p_client: TAG });
  });

  it.each([
    [
      "returns an error",
      (rpc: jest.Mock) => rpc.mockResolvedValueOnce({ error: { message: "no" } }),
    ],
    ["rejects", (rpc: jest.Mock) => rpc.mockRejectedValueOnce(new Error("Network request failed"))],
  ])("keeps the queue for the next flush when the call %s", async (_label, fail) => {
    const { db, stored } = makeDb();
    const { client, rpc } = makeClient();
    await markAppOpened(db, at(0));
    fail(rpc);

    await expect(flushActivityDays(db, client, TAG)).resolves.toBeUndefined();

    expect(stored()).toEqual({ days: [day(0)], lastSent: null });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Activity ping failed"),
      expect.any(String),
    );

    await flushActivityDays(db, client, TAG);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith("record_activity", { p_days: [day(0)], p_client: TAG });
    expect(stored()).toEqual({ days: [], lastSent: day(0) });
  });

  it("keeps a day marked while the call is in flight", async () => {
    const { db, stored } = makeDb();
    const { client, rpc } = makeClient();
    let release!: (response: ActivityRpcResponse) => void;
    let called!: () => void;
    const rpcCalled = new Promise<void>((resolve) => (called = resolve));
    rpc.mockImplementationOnce(() => {
      called();
      return new Promise<ActivityRpcResponse>((resolve) => (release = resolve));
    });
    await markAppOpened(db, at(0));

    const flushing = flushActivityDays(db, client, TAG);
    await rpcCalled;
    await markAppOpened(db, at(1));
    release({ error: null });
    await flushing;

    expect(stored()).toEqual({ days: [day(1)], lastSent: day(0) });
  });

  it("records a day sent while the clock ran ahead once that day really comes", async () => {
    const { db, stored } = makeDb();
    const { client, rpc } = makeClient();
    // The clock reads tomorrow. The server drops that day: it's after its own today.
    await markAppOpened(db, at(1));
    await flushActivityDays(db, client, TAG);

    // Once the clock is put right, tomorrow is no longer held back.
    await markAppOpened(db, at(0));
    expect(stored()).toEqual({ days: [day(0)], lastSent: null });
    await flushActivityDays(db, client, TAG);
    await markAppOpened(db, at(1));
    await flushActivityDays(db, client, TAG);

    expect(rpc.mock.calls.map(([, args]) => args.p_days)).toEqual([[day(1)], [day(0)], [day(1)]]);
    expect(stored()).toEqual({ days: [], lastSent: day(1) });
  });

  it("keeps the newest lastSent when an older day is sent", async () => {
    // The device clock went back a few days after today was recorded.
    const { db, stored } = makeDb({ days: [day(-3)], lastSent: day(0) });
    const { client } = makeClient();

    await flushActivityDays(db, client, TAG);

    expect(stored()).toEqual({ days: [], lastSent: day(0) });
  });

  it("makes no call for a tag usage_daily doesn't accept, and keeps the queue", async () => {
    const { db, stored } = makeDb();
    const { client, rpc } = makeClient();
    await markAppOpened(db, at(0));

    // Mobile's fallback tag on a platform other than iOS or Android.
    await flushActivityDays(db, client, "mobile");

    expect(rpc).not.toHaveBeenCalled();
    expect(stored()).toEqual({ days: [day(0)], lastSent: null });
  });

  it("makes no call when nothing is queued", async () => {
    const { db } = makeDb();
    const { client, rpc } = makeClient();

    await flushActivityDays(db, client, TAG);

    expect(rpc).not.toHaveBeenCalled();
  });

  it("does nothing on a database without localStorage", async () => {
    const { client, rpc } = makeClient();

    await expect(flushActivityDays({}, client, TAG)).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("never rejects when storage fails", async () => {
    const { db, localStorage } = makeDb({ days: [day(0)], lastSent: null });
    const { client, rpc } = makeClient();
    localStorage.set.mockRejectedValueOnce(new Error("disk full"));

    await expect(flushActivityDays(db, client, TAG)).resolves.toBeUndefined();

    // The server has the day; writing that down failed, so it is sent again
    // next time, which record_activity treats as already done.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not send"),
      expect.any(Error),
    );
  });
});
