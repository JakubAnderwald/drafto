import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { OfflineBannerVariant } from "@drafto/shared";

import { useOfflineBannerState } from "@/hooks/use-offline-banner-state";

interface OfflineBannerContextValue {
  /** The banner to show on every screen, or null for none. */
  variant: OfflineBannerVariant | null;
  /** The last measured height of a banner drawn below a header (0 until one is laid out). */
  belowHeaderHeight: number;
  reportBelowHeaderHeight: (height: number) => void;
}

const noop = () => undefined;

const OfflineBannerContext = createContext<OfflineBannerContextValue>({
  variant: null,
  belowHeaderHeight: 0,
  reportBelowHeaderHeight: noop,
});

/**
 * Runs the offline banner's state once for the whole app.
 *
 * Every screen draws its own banner (OfflineScreenLayout), so the state is
 * shared here: one network listener, one "Back online" timer, and the same
 * banner on a screen pushed while another one shows it. It also keeps the
 * banner's height for overlays that sit outside the screens, such as toasts.
 */
export function OfflineBannerProvider({ children }: { children: ReactNode }) {
  const variant = useOfflineBannerState();
  const [belowHeaderHeight, setBelowHeaderHeight] = useState(0);

  const value = useMemo(
    () => ({ variant, belowHeaderHeight, reportBelowHeaderHeight: setBelowHeaderHeight }),
    [variant, belowHeaderHeight],
  );

  return <OfflineBannerContext.Provider value={value}>{children}</OfflineBannerContext.Provider>;
}

/** The shared banner state. Outside an OfflineBannerProvider, no banner is shown. */
export function useOfflineBanner(): OfflineBannerContextValue {
  return useContext(OfflineBannerContext);
}

/**
 * How far the banner pushes a screen's content down below its header, or 0
 * while it is hidden. For overlays placed under the header from outside the
 * navigator (toasts), which can't read the screen's own layout.
 */
export function useOfflineBannerHeaderOffset(): number {
  const { variant, belowHeaderHeight } = useOfflineBanner();
  return variant ? belowHeaderHeight : 0;
}
