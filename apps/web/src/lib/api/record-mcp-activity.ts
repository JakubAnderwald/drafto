import * as Sentry from "@sentry/nextjs";
import { utcDay } from "@drafto/shared";
import type { DraftoClientTag } from "@drafto/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const MCP_CLIENT_TAG: DraftoClientTag = "web-mcp";

/**
 * Records that <userId> used Drafto through the MCP server on the UTC day of <now>, as a
 * `web-mcp` activity day (ADR 0077). Only the day is recorded: never the tool or the note.
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
