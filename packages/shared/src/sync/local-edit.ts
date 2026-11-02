/**
 * The parts of a WatermelonDB collection change (`{ record, type }`, as
 * `database.withChangesForTables()` emits them) that `hasLocalEdit` reads.
 * Structural, so this package needs no WatermelonDB dependency.
 */
export interface LocalChangeEntry {
  type: string;
  record: { table: string; syncStatus: string };
}

/**
 * True when a batch of local database changes holds an edit that still has to
 * be pushed, i.e. one that should schedule a sync.
 *
 * A sync's own writes never qualify, which is what keeps change-triggered
 * syncing from feeding itself: pulled records and records marked as synced
 * after a push are `synced`. Attachment *updates* never qualify either. They
 * are the upload queue moving `upload_status` / `local_uri`, which never reach
 * the server (attachments are immutable, and the push ignores updates), and
 * a failing upload rewrites them on every pass.
 */
export function hasLocalEdit(changes: readonly LocalChangeEntry[]): boolean {
  return changes.some(
    ({ type, record }) =>
      record.syncStatus !== "synced" && !(record.table === "attachments" && type === "updated"),
  );
}
