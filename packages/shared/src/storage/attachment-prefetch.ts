import { selectPrefetchCandidates } from "./attachment-cache-policy";
import type { PrefetchCandidate, PrefetchLimits } from "./attachment-cache-policy";

// The native apps' image prefetch pass (ADR-0086), with the database, network
// and file calls passed in by each app, so mobile and desktop share one
// implementation of the throttle, the cancellation and the sign-out reset.

/** A pass that ran this recently, and downloaded nothing, is not repeated. */
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
   * Run a pass, or join the one running. A pass that found nothing to do isn't
   * repeated for `PREFETCH_MIN_INTERVAL_MS`. Never throws.
   */
  prefetch: (options?: PrefetchOptions) => Promise<PrefetchResult>;
  /**
   * Forget the throttle and drop the running pass (sign-out, tests). The
   * dropped pass stops before its next download, and nothing it does later
   * touches the next pass or the throttle.
   */
  reset: () => void;
}

export function createAttachmentPrefetcher(deps: AttachmentPrefetchDeps): AttachmentPrefetcher {
  const now = deps.now ?? (() => Date.now());
  let running: Promise<PrefetchResult> | null = null;
  let lastIdlePassAt = 0;
  // Bumped by reset(), so a pass from before it knows it was dropped.
  let epoch = 0;

  async function runPass(isCancelled: () => boolean): Promise<PrefetchResult> {
    const candidates = await deps.listCandidates();
    if (candidates.length === 0 || isCancelled()) return { downloaded: 0 };

    const cache = await deps.cacheState();
    const chosen = selectPrefetchCandidates(candidates, cache.isCached, {
      ...deps.limits,
      availableBytes: deps.maxCacheBytes - cache.totalBytes,
    });

    let downloaded = 0;
    for (const candidate of chosen) {
      if (isCancelled()) break;
      try {
        const signedUrl = await deps.getSignedUrl(candidate.filePath);
        if (isCancelled()) break;
        if (await deps.download(candidate.filePath, signedUrl)) downloaded += 1;
      } catch (error) {
        // Most likely the network went away: the next pass picks up from here.
        console.warn("Attachment prefetch stopped:", error);
        break;
      }
    }
    if (downloaded > 0 && !isCancelled()) await deps.evict();
    return { downloaded };
  }

  function prefetch(options: PrefetchOptions = {}): Promise<PrefetchResult> {
    if (running) return running;
    if (now() - lastIdlePassAt < PREFETCH_MIN_INTERVAL_MS) {
      return Promise.resolve({ downloaded: 0 });
    }
    const startedIn = epoch;
    const callerCancelled = options.isCancelled ?? (() => false);
    const isCancelled = () => epoch !== startedIn || callerCancelled();
    const pass: Promise<PrefetchResult> = runPass(isCancelled)
      .catch((error: unknown) => {
        console.warn("Attachment prefetch failed:", error);
        return { downloaded: 0 };
      })
      .then((result) => {
        if (epoch === startedIn) lastIdlePassAt = result.downloaded === 0 ? now() : 0;
        return result;
      })
      .finally(() => {
        if (running === pass) running = null;
      });
    running = pass;
    return pass;
  }

  function reset(): void {
    epoch += 1;
    running = null;
    lastIdlePassAt = 0;
  }

  return { prefetch, reset };
}
