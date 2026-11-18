import { useEffect, useRef, useState } from "react";

import { useNetworkStatus } from "@/hooks/use-network-status";

/** What the offline banner says: no connection, or the connection just came back. */
export type OfflineBannerVariant = "offline" | "reconnected";

/** How long "Back online — syncing..." stays up once the connection returns. */
export const RECONNECTED_HOLD_MS = 2000;

/**
 * Which offline banner to show, or null for none.
 *
 * - "offline" while there is no connection.
 * - "reconnected" for RECONNECTED_HOLD_MS after the connection returns, so the
 *   user sees that the app is syncing again.
 * - null otherwise, including at launch when the app starts online.
 *
 * Only the state lives here; drawing the banner is the component's job.
 */
export function useOfflineBannerState(): OfflineBannerVariant | null {
  const { isConnected } = useNetworkStatus();
  const wasOfflineRef = useRef(false);
  const [showReconnected, setShowReconnected] = useState(false);

  useEffect(() => {
    if (!isConnected) {
      wasOfflineRef.current = true;
      setShowReconnected(false);
      return;
    }
    if (!wasOfflineRef.current) return;

    wasOfflineRef.current = false;
    setShowReconnected(true);
    const timer = setTimeout(() => setShowReconnected(false), RECONNECTED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [isConnected]);

  if (!isConnected) return "offline";
  return showReconnected ? "reconnected" : null;
}
