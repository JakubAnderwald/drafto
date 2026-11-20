import { selectPrefetchCandidates } from "./attachment-cache-policy";
import type { PrefetchCandidate, PrefetchLimits } from "./attachment-cache-policy";

// The native apps' image prefetch pass (ADR-0086), with the database, network
// and file calls passed in by each app, so mobile and desktop share one
// implementation of the throttle, the cancellation and the sign-out reset.

/**
 * A pass that ran this recently, and found nothing to download, is not
 * repeated. A pass that stopped on a failure doesn't count.
 */
export const PREFETCH_MIN_INTERVAL_MS = 60_000;

export interface PrefetchOptions {
  /** Checked before each download: true stops the pass (the session ended). */
  isCancelled?: () => boolean;
}

export interface PrefetchResult {
  downloaded: number;
}

/** The cache as a pass sees it when it starts. */
export interface PrefetchCacheState {
  isCached: (filePath: string) => boolean;
  totalBytes: number;
}

export interface AttachmentPrefetchDeps {
  /** Uploaded image attachments of notes not in the trash, newest first. */
  listCandidates: () => Promise<PrefetchCandidate[]>;
  cacheState: () => Promise<PrefetchCacheState>;
  /** The cache's cap: a pass never fills it past this. */
  maxCacheBytes: number;
  /** Per-pass limits; the free room in the cache is worked out per pass. */
  limits: Omit<PrefetchLimits, "availableBytes">;
  getSignedUrl: (filePath: string) => Promise<string>;
  /** Download into the cache; null when the cache was wiped meanwhile. */
  download: (filePath: string, url: string) => Promise<string | null>;
  evict: () => Promise<void>;
  now?: () => number;
}

export interface AttachmentPrefetcher {
  /**
   * Run a pass, or join the one running unless its caller's session ended. A
   * pass that found nothing to do isn't repeated for
   * `PREFETCH_MIN_INTERVAL_MS`. Never throws.
   */
  prefetch: (options?: PrefetchOptions) => Promise<PrefetchResult>;
  /**
   * Forget the throttle and drop the running pass (sign-out, tests). The
   * dropped pass stops before its next download, and nothing it does later
   * touches the next pass or the throttle.
   */
  reset: () => void;
}

/** A pass's outcome; `failed` when it stopped on an error, with work left. */
interface PassOutcome extends PrefetchResult {
  failed: boolean;
}

export function createAttachmentPrefetcher(deps: AttachmentPrefetchDeps): AttachmentPrefetcher {
  const now = deps.now ?? (() => Date.now());
  let running: Promise<PrefetchResult> | null = null;
  // The running pass's own cancellation: once it is true, that pass is
  // stopping, so a new call starts a pass of its own instead of joining it.
  let runningCancelled: () => boolean = () => false;
  let lastIdlePassAt = 0;
  // Bumped by reset(), so a pass from before it knows it was dropped.
  let epoch = 0;

  async function runPass(isCancelled: () => boolean): Promise<PassOutcome> {
    const candidates = await deps.listCandidates();
    if (candidates.length === 0 || isCancelled()) return { downloaded: 0, failed: false };

    const cache = await deps.cacheState();
    const chosen = selectPrefetchCandidates(candidates, cache.isCached, {
      ...deps.limits,
      availableBytes: deps.maxCacheBytes - cache.totalBytes,
    });

    let downloaded = 0;
    let failed = false;
    for (const candidate of chosen) {
      if (isCancelled()) break;
      try {
        const signedUrl = await deps.getSignedUrl(candidate.filePath);
        if (isCancelled()) break;
        if (await deps.download(candidate.filePath, signedUrl)) downloaded += 1;
      } catch (error) {
        // Most likely the network went away: the next pass picks up from here.
        console.warn("Attachment prefetch stopped:", error);
        failed = true;
        break;
      }
    }
    if (downloaded > 0 && !isCancelled()) await deps.evict();
    return { downloaded, failed };
  }

  function prefetch(options: PrefetchOptions = {}): Promise<PrefetchResult> {
    if (running) {
      if (!runningCancelled()) return running;
      // The running pass belongs to a session that ended (approval revoked and
      // restored, say): drop it, as reset() does, so this session gets a pass.
      epoch += 1;
      running = null;
    }
    if (now() - lastIdlePassAt < PREFETCH_MIN_INTERVAL_MS) {
      return Promise.resolve({ downloaded: 0 });
    }
    const startedIn = epoch;
    const callerCancelled = options.isCancelled ?? (() => false);
    const isCancelled = () => epoch !== startedIn || callerCancelled();
    const pass: Promise<PrefetchResult> = runPass(isCancelled)
      .catch((error: unknown): PassOutcome => {
        console.warn("Attachment prefetch failed:", error);
        return { downloaded: 0, failed: true };
      })
      .then(({ downloaded, failed }) => {
        // Only a pass that found nothing to do starts the throttle. After a
        // failure, or a pass its session's end cut short, the next call (a
        // reconnect's sync, the next session's) picks up the rest.
        if (epoch === startedIn) {
          lastIdlePassAt = downloaded === 0 && !failed && !isCancelled() ? now() : 0;
        }
        return { downloaded };
      })
      .finally(() => {
        if (running === pass) running = null;
      });
    running = pass;
    runningCancelled = isCancelled;
    return pass;
  }

  function reset(): void {
    epoch += 1;
    running = null;
    lastIdlePassAt = 0;
  }

  return { prefetch, reset };
}
