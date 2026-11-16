import { useCallback, useEffect, useRef, useState } from "react";
import type { StorageUsage } from "@drafto/shared";

import { fetchStorageUsage } from "@/lib/data/storage-usage";

export interface UseStorageUsageResult {
  /** The latest reading, or null before the first one and while it can't be read. */
  usage: StorageUsage | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * The signed-in user's attachment storage usage and quota (issue #794). Read on
 * mount and again whenever `refreshKey` changes (e.g. after a sync uploaded
 * attachments). A refresh keeps the previous reading on screen until the new one
 * arrives, and a reading that can't be fetched (offline) clears it.
 */
export function useStorageUsage(refreshKey?: unknown): UseStorageUsageResult {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  // Only the most recently started read reports, so a slow older one can't
  // overwrite a newer reading.
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    requestRef.current += 1;
    const request = requestRef.current;
    setLoading(true);
    const next = await fetchStorageUsage();
    if (!mountedRef.current || request !== requestRef.current) return;
    setUsage(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  return { usage, loading, refresh };
}
