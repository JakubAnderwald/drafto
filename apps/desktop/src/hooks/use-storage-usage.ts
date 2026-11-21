import { useCallback, useEffect, useRef, useState } from "react";
import type { StorageUsage } from "@drafto/shared";

import { fetchContentUsage, fetchStorageUsage } from "@/lib/data";

export interface UseStorageUsageResult {
  /** The latest known usage, or null before the first reading (or when none could be made). */
  usage: StorageUsage | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * The signed-in user's attachment storage usage (issue #794). Reads it on mount and on
 * refresh(). A refresh that can't read it (offline) keeps the last known reading.
 */
export function useStorageUsage(): UseStorageUsageResult {
  return useUsageReading(fetchStorageUsage);
}

/** The signed-in user's note content usage (ADR 0090), read the same way as `useStorageUsage`. */
export function useContentUsage(): UseStorageUsageResult {
  return useUsageReading(fetchContentUsage);
}

function useUsageReading(read: () => Promise<StorageUsage | null>): UseStorageUsageResult {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  // Only the latest refresh reports, so an older, slower reading never overwrites it.
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    requestRef.current += 1;
    const request = requestRef.current;
    const next = await read();
    if (!mountedRef.current || request !== requestRef.current) return;
    if (next) setUsage(next);
    setLoading(false);
  }, [read]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { usage, loading, refresh };
}
