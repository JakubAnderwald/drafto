/**
 * A registry of "save what you have now" callbacks, so code that is about to end the session
 * (logout) can wait for unsaved editor edits to reach the server first.
 *
 * `supabase.auth.signOut()` deletes the session cookie before the caller navigates away, so
 * the autosave hook's own page-hide flush would be answered with a 401. Logout therefore
 * awaits `flushPendingSaves()` before it signs out.
 */
export type PendingSaveFlusher = () => Promise<void> | void;

const flushers = new Set<PendingSaveFlusher>();

/** Register a flusher. Returns the function that unregisters it. */
export function registerPendingSaveFlusher(flusher: PendingSaveFlusher): () => void {
  flushers.add(flusher);
  return () => {
    flushers.delete(flusher);
  };
}

interface FlushPendingSavesOptions {
  /** Stop waiting after this long, so logout never hangs on a dead network. */
  timeoutMs?: number;
}

/**
 * Run every registered flusher and wait for them to settle, or for the timeout. Never throws:
 * a flusher's failure is its own to report.
 */
export async function flushPendingSaves({
  timeoutMs = 3000,
}: FlushPendingSavesOptions = {}): Promise<void> {
  if (flushers.size === 0) return;

  const settled = Promise.allSettled(
    [...flushers].map((flusher) => new Promise<void>((resolve) => resolve(flusher()))),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  try {
    await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
