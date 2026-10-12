import { Q, type Database } from "@nozbe/watermelondb";

const SYNCED_TABLES = ["notebooks", "notes", "attachments"] as const;

/**
 * Counts the local changes that have not reached the server yet:
 * - created, updated and deleted rows across the synced tables. Deletions count too:
 *   WatermelonDB queries hide deleted records, but sign-out wipes the database and loses a
 *   pending deletion just like a pending edit;
 * - attachments whose file is still waiting to upload (or failed to), although their row
 *   already synced. Sign-out deletes the local files, and for these that is the only copy.
 *
 * Read straight from the database rather than from the sync provider's state, so a caller that
 * has just awaited a sync sees the result of that sync.
 */
export async function countUnsyncedChanges(database: Database): Promise<number> {
  let count = 0;
  for (const table of SYNCED_TABLES) {
    const [changed, deletedIds] = await Promise.all([
      database
        .get(table)
        .query(Q.where("_status", Q.oneOf(["created", "updated"])))
        .fetchCount(),
      database.adapter.getDeletedRecords(table),
    ]);
    count += changed + deletedIds.length;
  }
  // Only synced rows here: a created or updated row with a pending upload is counted above.
  count += await database
    .get("attachments")
    .query(Q.where("upload_status", Q.oneOf(["pending", "failed"])), Q.where("_status", "synced"))
    .fetchCount();
  return count;
}
