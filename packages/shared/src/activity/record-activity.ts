import { RECORD_ACTIVITY_MAX_DAYS } from "../constants";
import type { DraftoClientTag } from "../constants";
import { normalizeActivityQueue } from "./activity-days";

/** What a supabase-js `rpc()` call resolves to; only `error` is read. */
export interface ActivityRpcResponse {
  error: { message: string } | null;
}

/**
 * Anything with supabase-js's `rpc()`, such as a `SupabaseClient<Database>`.
 * The arguments are typed `never` because the shared `Database` declares no
 * `Functions` (the same reason `search_notes` is called with `as never`).
 */
export interface ActivityRpcClient {
  rpc: (...args: never[]) => PromiseLike<ActivityRpcResponse>;
}

/** `sent`: the days the server accepted. `error`: why nothing was recorded. */
export type RecordActivityOutcome = { ok: true; sent: string[] } | { ok: false; error: string };

/**
 * Records that the signed-in user opened Drafto on <days> (UTC `YYYY-MM-DD`)
 * from <client>, through `public.record_activity` (ADR 0080). The server
 * writes rows only for the caller, ignores days in the future or more than 30
 * days back, and treats a day it already has as done.
 *
 * Best-effort by design: it never throws. A failure, including a network
 * error, comes back as `{ ok: false }` so the caller can keep the days and try
 * again later. Invalid and duplicate days are dropped, and at most the newest
 * RECORD_ACTIVITY_MAX_DAYS are sent; with nothing left to send it makes no
 * call.
 */
export async function recordActivity(
  client: ActivityRpcClient,
  days: readonly string[],
  clientTag: DraftoClientTag,
): Promise<RecordActivityOutcome> {
  const sent = normalizeActivityQueue(days, RECORD_ACTIVITY_MAX_DAYS);
  if (sent.length === 0) return { ok: true, sent };
  try {
    const { error } = await client.rpc(
      "record_activity" as never,
      { p_days: sent, p_client: clientTag } as never,
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true, sent };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
