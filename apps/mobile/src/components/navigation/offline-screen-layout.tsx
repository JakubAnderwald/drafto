import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { OfflineBanner } from "@/components/offline-banner";
import { OfflineBannerHeightContext } from "@/hooks/use-offline-banner-height";
import { useOfflineBanner } from "@/providers/offline-banner-provider";

interface OfflineScreenLayoutProps {
  children: ReactNode;
  /**
   * The screen has no header. The banner is then the topmost thing on screen:
   * it fills the status-bar area itself, and the screen below it sees a top
   * safe-area inset of 0, so it doesn't pad for the status bar a second time.
   */
  headerless?: boolean;
}

/**
 * One screen's offline banner, in the layout flow above the screen's content.
 *
 * Used as a navigator's `screenLayout` (see `offlineScreenLayout`), so on a
 * screen with a header the banner hangs below the header instead of covering
 * it: the header keeps its own status-bar padding and its Back button stays
 * tappable (PrimeTestLab report 10668, M-03). The tree has the same shape
 * whether the banner shows or not, so a connection change never remounts the
 * screen (the note editor's WebView keeps its state).
 */
export function OfflineScreenLayout({ children, headerless = false }: OfflineScreenLayoutProps) {
  const { variant, reportBelowHeaderHeight } = useOfflineBanner();
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measured = event.nativeEvent.layout.height;
      setHeight(measured);
      if (!headerless) reportBelowHeaderHeight(measured);
    },
    [headerless, reportBelowHeaderHeight],
  );

  const coversStatusBar = headerless && variant !== null;
  const childInsets = useMemo(
    () => (coversStatusBar ? { ...insets, top: 0 } : insets),
    [coversStatusBar, insets],
  );

  return (
    <View style={styles.fill}>
      {variant ? (
        <OfflineBanner
          variant={variant}
          topInset={headerless ? insets.top : 0}
          onLayout={handleLayout}
        />
      ) : null}
      <OfflineBannerHeightContext.Provider value={variant ? height : 0}>
        <SafeAreaInsetsContext.Provider value={childInsets}>
          <View style={styles.fill}>{children}</View>
        </SafeAreaInsetsContext.Provider>
      </OfflineBannerHeightContext.Provider>
    </View>
  );
}

/**
 * Routes that hold a navigator of their own. That navigator draws the banner
 * under its own headers, so wrapping the route too would show it twice.
 */
const NESTED_NAVIGATOR_ROUTES: ReadonlySet<string> = new Set(["(tabs)"]);

interface ScreenLayoutProps {
  route: { name: string };
  options: { headerShown?: boolean };
  children: ReactElement;
}

/**
 * A react-navigation `screenLayout` that gives every screen its offline
 * banner: below the header, or at the very top on a screen without one (the
 * auth screens), so the user still learns they are offline there.
 */
export function offlineScreenLayout({ route, options, children }: ScreenLayoutProps): ReactElement {
  if (NESTED_NAVIGATOR_ROUTES.has(route.name)) return children;
  return (
    <OfflineScreenLayout headerless={options.headerShown === false}>{children}</OfflineScreenLayout>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
