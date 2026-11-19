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
 * counted even when the number of unsynced rows stayed the same. Writes still running are
 * tracked too, including one an editor started as it unmounted, so a flush waits for them.
 */

type Flush = () => Promise<void>;

const flushes = new Set<Flush>();
// Auto-saves whose last write failed. Kept after the editor unmounts: the edit is still lost.
const failedSaves = new Set<object>();
// Auto-save writes still running, whether or not their editor is still mounted.
const savesInFlight = new Set<Promise<void>>();
let savesWritten = 0;

/** Registers a pending-save flush; returns the unregister function. */
export function registerPendingSave(flush: Flush): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/** Tracks an auto-save write until it settles, so a flush waits for it. */
export function trackSaveInFlight(write: Promise<void>): void {
  savesInFlight.add(write);
  const settle = () => {
    savesInFlight.delete(write);
  };
  void write.then(settle, settle);
}

/**
 * Records that `owner` (one auto-save) wrote to the local database. `latest` is false when a
 * newer write by the same auto-save has started since: only that newer write's outcome says
 * whether the auto-save's last edit is stored, so this one must not clear a failure it recorded.
 */
export function recordSaveWritten(owner: object, latest = true): void {
  if (latest) failedSaves.delete(owner);
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
  // Also writes that are not their auto-save's latest, or whose editor has unmounted since,
  // and any write that started while this one waited: keep draining until none is left.
  while (savesInFlight.size > 0) {
    await Promise.allSettled(Array.from(savesInFlight));
  }
  return results.every((result) => result.status === "fulfilled") && failedSaves.size === 0;
}
