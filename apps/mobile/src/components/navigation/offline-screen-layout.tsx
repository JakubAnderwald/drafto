import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { OfflineBanner } from "@/components/offline-banner";
import { OfflineBannerHeightContext } from "@/hooks/use-offline-banner-height";
import { useNavigationFocus, type FocusNavigation } from "@/hooks/use-navigation-focus";
import { useOfflineBanner } from "@/providers/offline-banner-provider";

interface OfflineScreenLayoutProps {
  children: ReactNode;
  /**
   * Identifies the screen to the OfflineBannerProvider: the route key inside a
   * navigator, a fixed key outside one.
   */
  screenKey: string;
  /**
   * The screen has no header. The banner is then the topmost thing on screen:
   * it fills the status-bar area itself, and the screen below it sees a top
   * safe-area inset of 0, so it doesn't pad for the status bar a second time.
   */
  headerless?: boolean;
  /**
   * Whether the user is looking at this screen. Only the focused screen tells
   * the provider where its banner is, which places the toasts and picks the
   * status bar's style. Defaults to true, for a screen outside a navigator.
   */
  focused?: boolean;
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
export function OfflineScreenLayout({
  children,
  screenKey,
  headerless = false,
  focused = true,
}: OfflineScreenLayoutProps) {
  const { variant, reportFocusedScreen, releaseFocusedScreen } = useOfflineBanner();
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);
  const bannerHeight = variant ? height : 0;

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setHeight(event.nativeEvent.layout.height);
  }, []);

  // Report while focused, and again whenever the banner's geometry changes.
  useEffect(() => {
    if (!focused) return;
    reportFocusedScreen({ key: screenKey, headerless, bannerHeight });
  }, [focused, screenKey, headerless, bannerHeight, reportFocusedScreen]);

  // Give the slot up on blur and on unmount, so a stale height never outlives the screen.
  useEffect(() => {
    if (!focused) return;
    return () => releaseFocusedScreen(screenKey);
  }, [focused, screenKey, releaseFocusedScreen]);

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
      <OfflineBannerHeightContext.Provider value={bannerHeight}>
        <SafeAreaInsetsContext.Provider value={childInsets}>
          <View style={styles.fill}>{children}</View>
        </SafeAreaInsetsContext.Provider>
      </OfflineBannerHeightContext.Provider>
    </View>
  );
}

interface NavigatorScreenLayoutProps {
  routeKey: string;
  navigation: FocusNavigation;
  headerless: boolean;
  children: ReactElement;
}

/** OfflineScreenLayout for a navigator's screen, focused while its route is. */
function NavigatorScreenLayout({
  routeKey,
  navigation,
  headerless,
  children,
}: NavigatorScreenLayoutProps) {
  const focused = useNavigationFocus(navigation);
  return (
    <OfflineScreenLayout screenKey={routeKey} headerless={headerless} focused={focused}>
      {children}
    </OfflineScreenLayout>
  );
}

/**
 * Routes that hold a navigator of their own. That navigator draws the banner
 * under its own headers, so wrapping the route too would show it twice.
 */
const NESTED_NAVIGATOR_ROUTES: ReadonlySet<string> = new Set(["(tabs)"]);

interface ScreenLayoutProps {
  route: { key: string; name: string };
  navigation: FocusNavigation;
  options: { headerShown?: boolean };
  children: ReactElement;
}

/**
 * A react-navigation `screenLayout` that gives every screen its offline
 * banner: below the header, or at the very top on a screen without one (the
 * auth screens), so the user still learns they are offline there.
 */
export function offlineScreenLayout({
  route,
  navigation,
  options,
  children,
}: ScreenLayoutProps): ReactElement {
  if (NESTED_NAVIGATOR_ROUTES.has(route.name)) return children;
  return (
    <NavigatorScreenLayout
      routeKey={route.key}
      navigation={navigation}
      headerless={options.headerShown === false}
    >
      {children}
    </NavigatorScreenLayout>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
