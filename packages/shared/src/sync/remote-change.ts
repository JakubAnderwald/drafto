import { sameStoredContent } from "../editor/content-save-guard";

/** A WatermelonDB raw record, as `synchronize()` hands it to `conflictResolver`. */
export type SyncRawRecord = Readonly<Record<string, unknown>>;

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function storedContentOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * True when applying a pulled record changes something the user can see on
 * this device, judged by comparing the record `synchronize()` is about to
 * write (`resolved`) with the one already stored (`local`).
 *
 * WatermelonDB calls `conflictResolver` for every pulled record that differs
 * from its local copy in any column, not just for real conflicts. That includes
 * the echo of this device's own push: the server stamps a new `updated_at` by
 * trigger and hands `content` back as jsonb with its keys re-sorted. Counting
 * every call therefore told users "a note was updated from another device"
 * after their own edits (seen in the iOS 1.4.4 App Review recording). Only the
 * columns a user sees count:
 *
 * - notebooks: `name`
 * - notes: `title`, `content` (key-order-insensitive), `notebook_id`, `is_trashed`
 * - attachments: never — they are immutable once created, and a new one shows
 *   up as a create, which does not go through the resolver.
 *
 * WatermelonDB keeps the local value of every column the device changed since
 * its last push, so a column both sides edited resolves to the local value and
 * is not counted either: this flags remote edits that reached the screen, not
 * remote edits that the next push will overwrite.
 */
export function isVisibleRemoteChange(
  table: string,
  local: SyncRawRecord,
  resolved: SyncRawRecord,
): boolean {
  switch (table) {
    case "notebooks":
      return textOf(local.name) !== textOf(resolved.name);
    case "notes":
      return (
        textOf(local.title) !== textOf(resolved.title) ||
        textOf(local.notebook_id) !== textOf(resolved.notebook_id) ||
        Boolean(local.is_trashed) !== Boolean(resolved.is_trashed) ||
        !sameStoredContent(storedContentOf(local.content), storedContentOf(resolved.content))
      );
    default:
      return false;
  }
}
