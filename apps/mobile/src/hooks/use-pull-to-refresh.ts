import { useCallback, useState } from "react";

/**
 * Pull-to-refresh state for a list. `refreshing` is true only while a refresh
 * the user pulled for is running.
 *
 * Lists used to bind `refreshing` to the provider's `isSyncing`. Background
 * syncs (autosave, the periodic timer, app foreground) then made the spinner
 * appear on its own and pushed the rows down and back up, moving the row, or
 * the inline rename field, under the user's finger.
 */
export function usePullToRefresh(refresh: () => Promise<unknown>): {
  refreshing: boolean;
  onRefresh: () => Promise<void>;
} {
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } catch (err) {
      // The sync reports its own failures; the spinner just has to stop.
      console.warn("Pull to refresh failed:", err);
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  return { refreshing, onRefresh };
}
