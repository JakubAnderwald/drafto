import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUCKET_NAME } from "@drafto/shared";
import type { Database } from "@/lib/supabase/database.types";

type StorageBucket = ReturnType<SupabaseClient<Database>["storage"]["from"]>;
type StorageEntry = NonNullable<Awaited<ReturnType<StorageBucket["list"]>>["data"]>[number];

// `list()` defaults to 100 entries per page, so page explicitly.
export const LIST_PAGE_SIZE = 1000;
// The Storage API rejects a single delete request of more than 1,000 paths.
export const REMOVE_BATCH_SIZE = 1000;

/**
 * Removes every object a user owns in the attachments bucket, or throws.
 *
 * Attachments live at `{userId}/{noteId}/{fileName}` and `list()` is not
 * recursive, so this walks the user's folder, collects every file path, then
 * removes them in batches. The first list or remove error is thrown, so a
 * caller can refuse to go further (e.g. keep the auth user) until storage is
 * clean. Removal is idempotent: a retry re-lists and finishes the job.
 *
 * `client` must be a service-role client — the bucket's RLS policies only let
 * approved users touch their own objects.
 */
export async function removeAllUserAttachments(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<void> {
  const bucket = client.storage.from(BUCKET_NAME);
  const paths = await collectFilePaths(bucket, userId);

  for (const batch of toBatches(paths)) {
    const { error } = await bucket.remove(batch);
    if (error) throw error;
  }
}

/**
 * Best-effort removal of every object a user owns in the attachments bucket.
 *
 * Same walk as `removeAllUserAttachments`, but for when the user is already
 * gone: a failure here just leaves orphaned objects behind, so errors are
 * reported to Sentry and never thrown, and a failed batch does not stop the
 * remaining ones.
 */
export async function removeUserAttachments(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<void> {
  const bucket = client.storage.from(BUCKET_NAME);

  let paths: string[];
  try {
    paths = await collectFilePaths(bucket, userId);
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "remove-user-attachments:list", userId } });
    return;
  }

  for (const batch of toBatches(paths)) {
    try {
      const { error } = await bucket.remove(batch);
      if (error) throw error;
    } catch (err) {
      Sentry.captureException(err, {
        extra: { where: "remove-user-attachments:remove", userId, batchSize: batch.length },
      });
    }
  }
}

function toBatches(paths: string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < paths.length; start += REMOVE_BATCH_SIZE) {
    batches.push(paths.slice(start, start + REMOVE_BATCH_SIZE));
  }
  return batches;
}

async function collectFilePaths(bucket: StorageBucket, prefix: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await listAllEntries(bucket, prefix)) {
    const path = `${prefix}/${entry.name}`;
    // Folders come back with a null id; files always carry one.
    if (entry.id === null) {
      paths.push(...(await collectFilePaths(bucket, path)));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

async function listAllEntries(bucket: StorageBucket, prefix: string): Promise<StorageEntry[]> {
  const entries: StorageEntry[] = [];
  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const { data, error } = await bucket.list(prefix, { limit: LIST_PAGE_SIZE, offset });
    if (error) throw error;
    entries.push(...data);
    if (data.length < LIST_PAGE_SIZE) return entries;
  }
}
