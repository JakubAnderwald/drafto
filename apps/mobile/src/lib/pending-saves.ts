/**
 * Debounced saves that have not reached the local database yet.
 *
 * `useAutoSave` registers its `flush` while it is mounted. Sign-out flushes them all before it
 * counts unsynced changes: it wipes the database right afterwards, so an edit still inside the
 * debounce window would otherwise be lost without ever being counted or synced.
 */

type Flush = () => Promise<void>;

const flushes = new Set<Flush>();

/** Registers a pending-save flush; returns the unregister function. */
export function registerPendingSave(flush: Flush): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/** Writes every pending save now and waits for the writes. Never rejects. */
export async function flushPendingSaves(): Promise<void> {
  await Promise.allSettled(Array.from(flushes, (flush) => flush()));
}
