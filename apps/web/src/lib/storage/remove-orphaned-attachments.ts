import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUCKET_NAME } from "@drafto/shared";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { REMOVE_BATCH_SIZE } from "@/lib/storage/remove-user-attachments";

/** Bounds one sweep (and so one request's run time); the next sweep picks up the rest. */
export const MAX_ORPHAN_BATCHES = 10;

/**
 * Removes attachment objects whose note no longer exists, and returns how many
 * it removed. Never throws: errors go to Sentry and stop the sweep, and the next
 * sweep tries again.
 *
 * Deleting a note cascades its attachment rows but leaves its files in the
 * bucket, and once the note is gone the bucket's policies stop the user's own
 * client from removing them. `orphaned_attachment_objects()` lists those files
 * (see supabase/migrations/20261113000002_attachment_orphan_sweep.sql), and this
 * removes them through the Storage API, one batch of at most REMOVE_BATCH_SIZE
 * per listing. `client` must be a service-role client.
 *
 * With `userId`, only that user's folder is swept: call it after a delete the
 * user made. Without it, every user's: the daily cron.
 */
export async function removeOrphanedAttachments(
  client: SupabaseClient<Database>,
  userId?: string,
): Promise<number> {
  const bucket = client.storage.from(BUCKET_NAME);
  let removed = 0;
  // The names of a remove that deleted none of them. Another sweep running at
  // the same time (two quick deletes by one user, or a user's sweep during the
  // daily one) may have removed them first, so they are listed once more, and
  // only reported if they are still there.
  let undeleted: ReadonlySet<string> | null = null;

  for (let batch = 0; batch < MAX_ORPHAN_BATCHES; batch++) {
    try {
      const { data, error } = await client.rpc("orphaned_attachment_objects", {
        max_rows: REMOVE_BATCH_SIZE,
        only_user: userId ?? null,
      });
      if (error) throw error;
      const paths = data ?? [];
      if (paths.length === 0) return removed;

      // Still listed after a remove that deleted nothing: Storage refused them,
      // and every further round would list the same names again.
      const refused = undeleted;
      if (refused && paths.some((path) => refused.has(path))) {
        throw new Error(`Storage removed none of ${refused.size} orphaned attachment objects`);
      }

      const { data: deleted, error: removeError } = await bucket.remove(paths);
      if (removeError) throw removeError;
      const deletedCount = deleted?.length ?? 0;
      removed += deletedCount;

      undeleted = deletedCount === 0 ? new Set(paths) : null;
      if (deletedCount > 0 && paths.length < REMOVE_BATCH_SIZE) return removed;
    } catch (err) {
      Sentry.captureException(err, {
        extra: { where: "remove-orphaned-attachments", userId: userId ?? "all", removed },
      });
      return removed;
    }
  }
  return removed;
}

/**
 * Sweeps one user's orphaned attachment files after a delete they made (a note
 * deleted forever, or a notebook whose trashed notes went with it). Best-effort:
 * the delete already happened, so a failure here, including a missing
 * service-role key, only goes to Sentry. Leftovers are swept by the daily cron.
 * Callers run it in `after()`, so the user's response doesn't wait for it.
 *
 * The caller must have authenticated `userId`.
 */
export async function removeUserOrphanedAttachments(
  userId: string,
  clientTag: string,
): Promise<void> {
  try {
    await removeOrphanedAttachments(createAdminClient(clientTag), userId);
  } catch (err) {
    // createAdminClient throws when the service-role key isn't configured.
    Sentry.captureException(err, {
      extra: { where: "remove-user-orphaned-attachments", userId, clientTag },
    });
  }
}
