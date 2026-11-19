import { createContext, useContext } from "react";

/**
 * The height of the offline banner drawn above the current screen's content,
 * or 0 when there is none. OfflineScreenLayout provides it to each screen.
 */
export const OfflineBannerHeightContext = createContext(0);

/**
 * How far the offline banner pushes this screen's content down.
 *
 * A KeyboardAvoidingView needs its distance from the top of the window as its
 * `keyboardVerticalOffset`. While offline the banner sits between the header
 * (or, on a headerless screen, the top of the window) and the content, so the
 * offset has to include it.
 */
export function useOfflineBannerHeight(): number {
  return useContext(OfflineBannerHeightContext);
}
