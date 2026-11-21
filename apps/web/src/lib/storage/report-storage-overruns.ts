import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export interface StorageOverrun {
  userId: string;
  objectBytes: number;
  quotaBytes: number;
}

function toOverrun(row: unknown): StorageOverrun | null {
  if (row === null || typeof row !== "object") return null;
  const { user_id, object_bytes, quota_bytes } = row as Record<string, unknown>;
  const objectBytes = Number(object_bytes);
  const quotaBytes = Number(quota_bytes);
  if (
    typeof user_id !== "string" ||
    !Number.isFinite(objectBytes) ||
    !Number.isFinite(quotaBytes)
  ) {
    return null;
  }
  return { userId: user_id, objectBytes, quotaBytes };
}

/**
 * Reports users whose stored attachment objects exceed their storage quota plus one
 * maximum-size file, which only signed upload URLs created ahead of use can cause
 * (ADR 0072's accepted gap). Sends one Sentry warning listing them (ids and byte
 * counts, no emails) so an admin can suspend the account, and returns how many there
 * were. Never throws: a failed read goes to Sentry and counts as none. `client` must
 * be a service-role client (`storage_quota_overruns()` isn't granted to the API roles).
 */
export async function reportStorageOverruns(client: SupabaseClient<Database>): Promise<number> {
  let data: unknown;
  try {
    const result = await client.rpc("storage_quota_overruns");
    if (result.error) {
      Sentry.captureException(result.error, { extra: { where: "storage-overruns:rpc" } });
      return 0;
    }
    data = result.data;
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "storage-overruns:rpc" } });
    return 0;
  }

  const overruns = (Array.isArray(data) ? data : []).flatMap((row) => {
    const overrun = toOverrun(row);
    return overrun ? [overrun] : [];
  });
  if (overruns.length === 0) return 0;

  Sentry.captureMessage(
    `${overruns.length} user(s) store more attachment bytes than their quota allows`,
    { level: "warning", extra: { overruns } },
  );
  return overruns.length;
}
