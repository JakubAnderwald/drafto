/** What the offline banner says: no connection, or the connection just came back. */
export type OfflineBannerVariant = "offline" | "reconnected";

/** How long "Back online — syncing..." stays up once the connection returns. */
export const RECONNECTED_HOLD_MS = 2000;

/**
 * What can move the offline banner on: a connection change, or the end of the
 * RECONNECTED_HOLD_MS hold. The app's hook dispatches these; the timer and the
 * network listener stay in the app, so this module needs no React or NetInfo.
 */
export type OfflineBannerEvent =
  { type: "connection"; isConnected: boolean } | { type: "holdElapsed" };

/**
 * The banner at launch: "offline" for an app that starts without a connection,
 * none for one that starts online (there is nothing to have come back from).
 */
export function initialOfflineBannerVariant(isConnected: boolean): OfflineBannerVariant | null {
  return isConnected ? null : "offline";
}

/**
 * The offline banner's state machine, shared by mobile and macOS.
 *
 * - No connection: "offline", whatever was showing (a drop during the hold
 *   cancels "Back online").
 * - The connection returns while "offline": "reconnected", which the app holds
 *   for RECONNECTED_HOLD_MS so the user sees it is syncing again.
 * - The hold ends: no banner. A stale hold (one that ends after the connection
 *   dropped again) changes nothing.
 * - Anything else leaves the banner as it is.
 */
export function nextOfflineBannerVariant(
  variant: OfflineBannerVariant | null,
  event: OfflineBannerEvent,
): OfflineBannerVariant | null {
  if (event.type === "holdElapsed") {
    return variant === "reconnected" ? null : variant;
  }
  if (!event.isConnected) return "offline";
  return variant === "offline" ? "reconnected" : variant;
}
