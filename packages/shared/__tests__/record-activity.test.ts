import { describe, expect, it } from "vitest";

import { DRAFTO_CLIENT_TAGS, RECORD_ACTIVITY_MAX_DAYS, recordActivity } from "../src";
import type { ActivityRpcClient, ActivityRpcResponse } from "../src";

const DAY_MS = 86_400_000;

/** <count> consecutive UTC days starting at <start>, oldest first. */
function consecutiveDays(start: string, count: number): string[] {
  const first = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(first + i * DAY_MS).toISOString().slice(0, 10),
  );
}

interface RecordedCall {
  fn: string;
  args: unknown;
}

/**
 * A class-based stand-in for a SupabaseClient. Its `rpc` reads `this`, as
 * supabase-js's does, so a call that loses the receiver throws instead of
 * being recorded.
 */
class FakeRpcClient {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly respond: () => PromiseLike<ActivityRpcResponse> = () =>
      Promise.resolve({ error: null }),
  ) {}

  rpc(fn: string, args: unknown): PromiseLike<ActivityRpcResponse> {
    this.calls.push({ fn, args });
    return this.respond();
  }
}

/**
 * A thenable that isn't a Promise, like supabase-js's lazy PostgrestBuilder:
 * the request only runs once something calls `then`.
 */
class LazyResponse implements PromiseLike<ActivityRpcResponse> {
  thenCalled = false;

  constructor(private readonly value: ActivityRpcResponse) {}

  then<TResult1 = ActivityRpcResponse, TResult2 = never>(
    onfulfilled?: ((value: ActivityRpcResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.thenCalled = true;
    return Promise.resolve(this.value).then(onfulfilled, onrejected);
  }
}

describe("recordActivity", () => {
  it("calls record_activity with the days and the client tag", async () => {
    const client = new FakeRpcClient();

    const result = await recordActivity(client, ["2026-11-13"], "web");

    expect(client.calls).toEqual([
      { fn: "record_activity", args: { p_days: ["2026-11-13"], p_client: "web" } },
    ]);
    expect(result).toEqual({ ok: true, sent: ["2026-11-13"] });
  });

  it.each(DRAFTO_CLIENT_TAGS)("passes the tag %s through as p_client", async (tag) => {
    const client = new FakeRpcClient();

    await recordActivity(client, ["2026-11-13"], tag);

    expect(client.calls[0]?.args).toEqual({ p_days: ["2026-11-13"], p_client: tag });
  });

  // supabase-js's rpc() reads this.rest; a detached call would throw.
  it("calls rpc as a method of the client, keeping `this`", async () => {
    const client = new FakeRpcClient();

    await expect(recordActivity(client, ["2026-11-13"], "desktop-macos")).resolves.toEqual({
      ok: true,
      sent: ["2026-11-13"],
    });
    expect(client.calls).toHaveLength(1);
  });

  it("drops invalid and duplicate days and sends the rest oldest first", async () => {
    const client = new FakeRpcClient();

    const result = await recordActivity(
      client,
      ["2026-11-13", "bogus", "2026-11-01", "2026-11-13", "2026-02-30", ""],
      "mobile-ios",
    );

    expect(client.calls[0]?.args).toEqual({
      p_days: ["2026-11-01", "2026-11-13"],
      p_client: "mobile-ios",
    });
    expect(result).toEqual({ ok: true, sent: ["2026-11-01", "2026-11-13"] });
  });

  // record_activity rejects a call with more than 31 days outright.
  it(`sends at most the newest ${RECORD_ACTIVITY_MAX_DAYS} days`, async () => {
    const client = new FakeRpcClient();
    const days = consecutiveDays("2026-09-01", RECORD_ACTIVITY_MAX_DAYS + 9);

    const result = await recordActivity(client, days, "mobile-android");

    const newest = days.slice(-RECORD_ACTIVITY_MAX_DAYS);
    expect(client.calls[0]?.args).toEqual({ p_days: newest, p_client: "mobile-android" });
    expect(result).toEqual({ ok: true, sent: newest });
  });

  it(`sends all ${RECORD_ACTIVITY_MAX_DAYS} days when given exactly that many`, async () => {
    const client = new FakeRpcClient();
    const days = consecutiveDays("2026-10-14", RECORD_ACTIVITY_MAX_DAYS);

    await expect(recordActivity(client, days, "web")).resolves.toEqual({ ok: true, sent: days });
  });

  it.each([[[]], [["nope"]], [["2026-02-30", ""]]])(
    "makes no call and reports nothing sent for %j",
    async (days) => {
      const client = new FakeRpcClient();

      await expect(recordActivity(client, days, "web")).resolves.toEqual({ ok: true, sent: [] });
      expect(client.calls).toHaveLength(0);
    },
  );

  it("leaves the caller's days untouched", async () => {
    const client = new FakeRpcClient();
    const days = Object.freeze(["2026-11-13", "2026-11-12", "2026-11-13"]);

    await recordActivity(client, days, "web");

    expect(days).toEqual(["2026-11-13", "2026-11-12", "2026-11-13"]);
  });

  it("awaits a thenable response that isn't a Promise", async () => {
    const response = new LazyResponse({ error: null });
    const client = new FakeRpcClient(() => response);

    await expect(recordActivity(client, ["2026-11-13"], "web")).resolves.toEqual({
      ok: true,
      sent: ["2026-11-13"],
    });
    expect(response.thenCalled).toBe(true);
  });

  it("reports an error result as not ok, with its message", async () => {
    const client = new FakeRpcClient(() =>
      Promise.resolve({ error: { message: "unknown client tag: mobile" } }),
    );

    await expect(recordActivity(client, ["2026-11-13"], "web")).resolves.toEqual({
      ok: false,
      error: "unknown client tag: mobile",
    });
  });

  it("reports an error from a thenable response as not ok", async () => {
    const client = new FakeRpcClient(
      () => new LazyResponse({ error: { message: "permission denied" } }),
    );

    await expect(recordActivity(client, ["2026-11-13"], "web")).resolves.toEqual({
      ok: false,
      error: "permission denied",
    });
  });

  it("turns a rejected call into not ok instead of rejecting", async () => {
    const client = new FakeRpcClient(() => Promise.reject(new TypeError("Failed to fetch")));

    await expect(recordActivity(client, ["2026-11-13"], "web")).resolves.toEqual({
      ok: false,
      error: "Failed to fetch",
    });
  });

  it("turns a synchronous throw into not ok instead of throwing", async () => {
    const client: ActivityRpcClient = {
      rpc: () => {
        throw new Error("client torn down");
      },
    };

    await expect(recordActivity(client, ["2026-11-13"], "web")).resolves.toEqual({
      ok: false,
      error: "client torn down",
    });
  });

  it.each([
    ["a string", "offline", "offline"],
    ["a number", 503, "503"],
    ["undefined", undefined, "undefined"],
  ])("stringifies a non-Error rejection (%s)", async (_label, reason, expected) => {
    const client = new FakeRpcClient(() => Promise.reject(reason));

    await expect(recordActivity(client, ["2026-11-13"], "web")).resolves.toEqual({
      ok: false,
      error: expected,
    });
  });

  it("stringifies a non-Error synchronous throw", async () => {
    const client: ActivityRpcClient = {
      rpc: () => {
        throw "socket closed";
      },
    };

    await expect(recordActivity(client, ["2026-11-13"], "web")).resolves.toEqual({
      ok: false,
      error: "socket closed",
    });
  });

  // A malformed response (nothing to destructure `{ error }` from) still can't escape.
  it("turns an undefined response into not ok instead of throwing", async () => {
    const client = new FakeRpcClient(
      () => Promise.resolve(undefined) as unknown as PromiseLike<ActivityRpcResponse>,
    );

    const result = await recordActivity(client, ["2026-11-13"], "web");

    expect(result.ok).toBe(false);
  });
});

describe("recordActivity: a day the server's date hasn't reached", () => {
  /**
   * A client whose record_activity adds <added> rows and whose get_server_time
   * answers <serverTime>.
   */
  function serverClient(added: number, serverTime: () => PromiseLike<ActivityRpcResponse>) {
    const calls: string[] = [];
    const client: ActivityRpcClient = {
      rpc: ((fn: string) => {
        calls.push(fn);
        return fn === "get_server_time"
          ? serverTime()
          : Promise.resolve({ data: added, error: null });
      }) as ActivityRpcClient["rpc"],
    };
    return { client, calls };
  }

  it("leaves out a day after the server's date, sent while the device clock ran ahead", async () => {
    // The device reads Nov 14, 00:01 UTC; the server is still at Nov 13, 23:58.
    const { client, calls } = serverClient(1, () =>
      Promise.resolve({ data: "2026-11-13T23:58:00.123456+00:00", error: null }),
    );

    const result = await recordActivity(client, ["2026-11-13", "2026-11-14"], "mobile-ios");

    expect(calls).toEqual(["record_activity", "get_server_time"]);
    expect(result).toEqual({ ok: true, sent: ["2026-11-13"] });
  });

  it("keeps every day when the server's date has reached them (already recorded)", async () => {
    const { client, calls } = serverClient(0, () =>
      Promise.resolve({ data: "2026-11-14T00:03:00+00:00", error: null }),
    );

    await expect(recordActivity(client, ["2026-11-14"], "web")).resolves.toEqual({
      ok: true,
      sent: ["2026-11-14"],
    });
    expect(calls).toEqual(["record_activity", "get_server_time"]);
  });

  it("doesn't ask the server's date when every day sent was added", async () => {
    const { client, calls } = serverClient(2, () => Promise.reject(new Error("not called")));

    await expect(
      recordActivity(client, ["2026-11-13", "2026-11-14"], "desktop-macos"),
    ).resolves.toEqual({ ok: true, sent: ["2026-11-13", "2026-11-14"] });
    expect(calls).toEqual(["record_activity"]);
  });

  it.each<[string, () => PromiseLike<ActivityRpcResponse>]>([
    ["an error", () => Promise.resolve({ error: { message: "permission denied" } })],
    ["no data", () => Promise.resolve({ data: null, error: null })],
    ["not a date", () => Promise.resolve({ data: "soon", error: null })],
    ["a rejection", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("counts every day as sent when the server's date comes back as %s", async (_label, answer) => {
    const { client } = serverClient(0, answer);

    await expect(recordActivity(client, ["2026-11-14"], "web")).resolves.toEqual({
      ok: true,
      sent: ["2026-11-14"],
    });
  });
});
