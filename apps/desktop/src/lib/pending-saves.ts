/**
 * Debounced saves that have not reached the local database yet.
 *
 * `useAutoSave` registers its `flush` while it is mounted. Sign-out flushes them all before it
 * counts unsynced changes: it wipes the database right afterwards, so an edit still inside the
 * debounce window would otherwise be lost without ever being counted or synced.
 *
 * `useAutoSave` also reports how each write ended. A write that failed left its edit outside
 * the database, where no count sees it, so sign-out must not promise that nothing is lost; and
 * every write that succeeded bumps a counter, so sign-out can tell that a note changed after it
 * counted even when the number of unsynced rows stayed the same.
 */

type Flush = () => Promise<void>;

const flushes = new Set<Flush>();
// Auto-saves whose last write failed. Kept after the editor unmounts: the edit is still lost.
const failedSaves = new Set<object>();
let savesWritten = 0;

/** Registers a pending-save flush; returns the unregister function. */
export function registerPendingSave(flush: Flush): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/** Records that `owner` (one auto-save) wrote to the local database. */
export function recordSaveWritten(owner: object): void {
  failedSaves.delete(owner);
  savesWritten += 1;
}

/** Records that a write by `owner` failed, so its edit is not in the local database. */
export function recordSaveFailed(owner: object): void {
  failedSaves.add(owner);
}

/** How many auto-save writes have succeeded so far. Only its changes matter. */
export function countSavesWritten(): number {
  return savesWritten;
}

/** Forgets failed saves once sign-out has wiped the database they were meant for. */
export function forgetFailedSaves(): void {
  failedSaves.clear();
}

/**
 * Writes every pending save now and waits for the writes. Never rejects. Resolves false when an
 * edit is still not in the local database: a flush failed, or an auto-save's last write did.
 */
export async function flushPendingSaves(): Promise<boolean> {
  const results = await Promise.allSettled(Array.from(flushes, (flush) => flush()));
  return results.every((result) => result.status === "fulfilled") && failedSaves.size === 0;
}
