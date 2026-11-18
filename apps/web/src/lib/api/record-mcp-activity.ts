import * as Sentry from "@sentry/nextjs";
import { utcDay } from "@drafto/shared";
import type { DraftoClientTag } from "@drafto/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const MCP_CLIENT_TAG: DraftoClientTag = "web-mcp";

/**
 * Whether a JSON-RPC message, or any message in a batch, is a `tools/call` request.
 *
 * Only a tool call counts as an MCP activity day (ADR 0086). An assistant with the Drafto
 * connector enabled runs the handshake (`initialize`, `notifications/initialized`) and
 * `tools/list` whenever a session starts, before the user has asked it for anything in
 * Drafto, so counting those would mark a user active for opening their assistant.
 */
export function isMcpToolCall(message: unknown): boolean {
  const messages: unknown[] = Array.isArray(message) ? message : [message];
  return messages.some(
    (m) => typeof m === "object" && m !== null && "method" in m && m.method === "tools/call",
  );
}

/**
 * Whether <request> carries a `tools/call`. It reads a clone of the body, so the MCP
 * transport can still read the request itself. A body that isn't JSON counts as no tool
 * call: the transport answers it with a parse error.
 */
export async function isMcpToolCallRequest(request: Request): Promise<boolean> {
  try {
    return isMcpToolCall(await request.clone().json());
  } catch {
    return false;
  }
}

/**
 * Records that <userId> used Drafto through the MCP server on the UTC day of <now>, as a
 * `web-mcp` activity day (ADR 0086). Only the day is recorded: never the tool or the note.
 *
 * The MCP route can't call `record_activity`: it authenticates by API key and queries as
 * `service_role`, so `auth.uid()` is null there. It writes the row itself instead, and a
 * day that's already recorded is left as it is (`on conflict do nothing`), so the nightly
 * rollup's `content_changes` count is never reset.
 *
 * Best-effort: it never throws. A failure goes to Sentry and the MCP call is unaffected.
 */
export async function recordMcpActivity(
  supabase: SupabaseClient<Database>,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const { error } = await supabase
      .from("usage_daily")
      .upsert(
        { user_id: userId, day: utcDay(now), client: MCP_CLIENT_TAG },
        { onConflict: "user_id,day,client", ignoreDuplicates: true },
      );
    if (error) {
      Sentry.captureException(error, {
        tags: { feature: "activity-ping", client: MCP_CLIENT_TAG },
        extra: { where: "record-mcp-activity" },
      });
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { feature: "activity-ping", client: MCP_CLIENT_TAG },
      extra: { where: "record-mcp-activity" },
    });
  }
}
