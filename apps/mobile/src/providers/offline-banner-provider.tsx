import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { OfflineBannerVariant } from "@drafto/shared";

import { useOfflineBannerState } from "@/hooks/use-offline-banner-state";

/** Where the focused screen draws the banner, as that screen reports it. */
export interface FocusedOfflineScreen {
  /** The screen's route key (or a fixed key outside a navigator). */
  key: string;
  /** No header: the banner is the topmost thing on screen, over the status bar. */
  headerless: boolean;
  /** The banner's measured height on that screen, or 0 while hidden or not laid out yet. */
  bannerHeight: number;
}

/** The banner on the focused screen, for overlays drawn outside the screens. */
export interface FocusedOfflineBanner {
  headerless: boolean;
  height: number;
}

interface OfflineBannerContextValue {
  /** The banner to show on every screen, or null for none. */
  variant: OfflineBannerVariant | null;
  /** The screen the user is looking at, or null before one has reported itself. */
  focusedScreen: FocusedOfflineScreen | null;
  /** Called by a screen when it gains focus, and again when its banner geometry changes. */
  reportFocusedScreen: (screen: FocusedOfflineScreen) => void;
  /** Called by a screen when it loses focus or unmounts. A no-op unless it is the focused one. */
  releaseFocusedScreen: (key: string) => void;
}

const noop = () => undefined;

const OfflineBannerContext = createContext<OfflineBannerContextValue>({
  variant: null,
  focusedScreen: null,
  reportFocusedScreen: noop,
  releaseFocusedScreen: noop,
});

function sameScreen(a: FocusedOfflineScreen | null, b: FocusedOfflineScreen): boolean {
  return (
    a !== null &&
    a.key === b.key &&
    a.headerless === b.headerless &&
    a.bannerHeight === b.bannerHeight
  );
}

/**
 * Runs the offline banner's state once for the whole app.
 *
 * Every screen draws its own banner (OfflineScreenLayout), so the state is
 * shared here: one network listener, one "Back online" timer, and the same
 * banner on a screen pushed while another one shows it.
 *
 * It also tracks the focused screen, keyed by its route key, for the things
 * drawn outside the screens: the status bar (SystemBars) and toasts. Several
 * screens are mounted at once in a stack, so only the focused one counts, and
 * a screen that blurs or unmounts gives the slot up only if it still holds it
 * (the next screen may already have reported itself).
 */
export function OfflineBannerProvider({ children }: { children: ReactNode }) {
  const variant = useOfflineBannerState();
  const [focusedScreen, setFocusedScreen] = useState<FocusedOfflineScreen | null>(null);

  const reportFocusedScreen = useCallback((screen: FocusedOfflineScreen) => {
    setFocusedScreen((current) => (sameScreen(current, screen) ? current : screen));
  }, []);

  const releaseFocusedScreen = useCallback((key: string) => {
    setFocusedScreen((current) => (current?.key === key ? null : current));
  }, []);

  const value = useMemo(
    () => ({ variant, focusedScreen, reportFocusedScreen, releaseFocusedScreen }),
    [variant, focusedScreen, reportFocusedScreen, releaseFocusedScreen],
  );

  return <OfflineBannerContext.Provider value={value}>{children}</OfflineBannerContext.Provider>;
}

/** The shared banner state. Outside an OfflineBannerProvider, no banner is shown. */
export function useOfflineBanner(): OfflineBannerContextValue {
  return useContext(OfflineBannerContext);
}

/**
 * The banner as drawn on the focused screen, or null while none shows there.
 * For overlays placed from outside the navigator (toasts), which can't read the
 * screen's own layout.
 */
export function useFocusedOfflineBanner(): FocusedOfflineBanner | null {
  const { variant, focusedScreen } = useOfflineBanner();
  if (!variant || !focusedScreen) return null;
  return { headerless: focusedScreen.headerless, height: focusedScreen.bannerHeight };
}

/**
 * True while the banner sits at the very top of the focused screen (a screen
 * without a header), under the status bar. SystemBars then gives the status bar
 * light content, which reads on the red or green strip in either theme.
 */
export function useOfflineBannerCoversStatusBar(): boolean {
  const { variant, focusedScreen } = useOfflineBanner();
  return variant !== null && focusedScreen?.headerless === true;
}
