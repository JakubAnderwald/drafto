import { useEffect, useReducer } from "react";
import {
  RECONNECTED_HOLD_MS,
  initialOfflineBannerVariant,
  nextOfflineBannerVariant,
  type OfflineBannerVariant,
} from "@drafto/shared";

import { useNetworkStatus } from "@/hooks/use-network-status";

/**
 * Which offline banner to show, or null for none.
 *
 * A thin wrapper: the states and transitions live in @drafto/shared
 * (`nextOfflineBannerVariant`, shared with the other native app). This hook
 * feeds them this app's network status and runs the "Back online" hold timer.
 * Drawing the banner is the component's job.
 */
export function useOfflineBannerState(): OfflineBannerVariant | null {
  const { isConnected } = useNetworkStatus();
  const [variant, dispatch] = useReducer(
    nextOfflineBannerVariant,
    isConnected,
    initialOfflineBannerVariant,
  );

  useEffect(() => {
    dispatch({ type: "connection", isConnected });
  }, [isConnected]);

  useEffect(() => {
    if (variant !== "reconnected") return;
    const timer = setTimeout(() => dispatch({ type: "holdElapsed" }), RECONNECTED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [variant]);

  return variant;
}
