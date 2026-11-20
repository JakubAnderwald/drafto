import { RECORD_ACTIVITY_MAX_DAYS } from "../constants";
import type { DraftoClientTag } from "../constants";
import { normalizeActivityQueue, utcDay } from "./activity-days";

/** What a supabase-js `rpc()` call resolves to: `data` (when there is one) and `error`. */
export interface ActivityRpcResponse {
  data?: unknown;
  error: { message: string } | null;
}

/**
 * Anything with supabase-js's `rpc()`, such as a `SupabaseClient<Database>`.
 * The arguments are typed `never` so that this structural interface accepts
 * supabase-js's generic, overloaded `rpc`, which concrete parameter types
 * would not match; the calls below cast their arguments to fit. Both RPCs,
 * `record_activity` and `get_server_time`, are typed in the shared
 * `Database`'s `Functions`.
 */
export interface ActivityRpcClient {
  rpc: (...args: never[]) => PromiseLike<ActivityRpcResponse>;
}

/** `sent`: the days the server took. `error`: why nothing was recorded. */
export type RecordActivityOutcome = { ok: true; sent: string[] } | { ok: false; error: string };

/**
 * Records that the signed-in user opened Drafto on <days> (UTC `YYYY-MM-DD`)
 * from <client>, through `public.record_activity` (ADR 0088). The server
 * writes rows only for the caller, ignores days in the future or more than 30
 * days back, and treats a day it already has as done.
 *
 * Best-effort by design: it never throws. A failure, including a network
 * error, comes back as `{ ok: false }` so the caller can keep the days and try
 * again later. Invalid and duplicate days are dropped, and at most the newest
 * RECORD_ACTIVITY_MAX_DAYS are sent; with nothing left to send it makes no
 * call. `sent` leaves out a day the server's own date hadn't reached yet (see
 * daysUpToServerToday), so the caller keeps it and sends it again.
 */
export async function recordActivity(
  client: ActivityRpcClient,
  days: readonly string[],
  clientTag: DraftoClientTag,
): Promise<RecordActivityOutcome> {
  const sent = normalizeActivityQueue(days, RECORD_ACTIVITY_MAX_DAYS);
  if (sent.length === 0) return { ok: true, sent };
  try {
    const { data, error } = await client.rpc(
      "record_activity" as never,
      { p_days: sent, p_client: clientTag } as never,
    );
    if (error) return { ok: false, error: error.message };
    // record_activity returns how many rows it added. As many as were sent
    // means every day was new, so none was dropped as a future day.
    if (typeof data !== "number" || data >= sent.length) return { ok: true, sent };
    return { ok: true, sent: await daysUpToServerToday(client, sent) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The days of <sent> on or before the server's UTC date. Called when
 * record_activity added fewer rows than it was sent. Usually the rest were
 * done for good: a day already recorded, one more than 30 days back, or a user
 * awaiting approval. But the server also drops a day after its own today, which
 * a device whose clock runs ahead sends just after its midnight. That day was
 * never recorded, and a caller that took it as sent would never send it again,
 * so the server's date (`get_server_time`, which sync already calls) decides.
 * When that can't be read, every day counts as sent, as it would without this
 * check.
 */
async function daysUpToServerToday(client: ActivityRpcClient, sent: string[]): Promise<string[]> {
  try {
    const { data, error } = await client.rpc("get_server_time" as never);
    if (error || typeof data !== "string") return sent;
    const serverNow = new Date(data);
    if (Number.isNaN(serverNow.getTime())) return sent;
    const serverToday = utcDay(serverNow);
    return sent.filter((day) => day <= serverToday);
  } catch {
    return sent;
  }
}
