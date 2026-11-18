import React from "react";
import { Text } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { render, fireEvent, act } from "../helpers/test-utils";
import {
  OfflineScreenLayout,
  offlineScreenLayout,
} from "@/components/navigation/offline-screen-layout";
import { useOfflineBannerHeight } from "@/hooks/use-offline-banner-height";
import { useNetworkStatus } from "@/hooks/use-network-status";
import {
  OfflineBannerProvider,
  useOfflineBannerHeaderOffset,
} from "@/providers/offline-banner-provider";
import { RECONNECTED_HOLD_MS } from "@/hooks/use-offline-banner-state";
import { spacing } from "@/theme/tokens";

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));

const mockUseNetworkStatus = jest.mocked(useNetworkStatus);

/** The device's insets: a 24 dp status bar and a 48 dp 3-button navigation bar. */
const DEVICE_INSETS = { top: 24, bottom: 48, left: 0, right: 0 };

function setConnected(isConnected: boolean) {
  mockUseNetworkStatus.mockReturnValue({ isConnected, isInternetReachable: isConnected });
}

/** Stands in for a screen: shows the insets and banner height it is given. */
function Probe() {
  const insets = useSafeAreaInsets();
  const bannerHeight = useOfflineBannerHeight();
  const headerOffset = useOfflineBannerHeaderOffset();
  return (
    <Text testID="probe">
      {JSON.stringify({ top: insets.top, bottom: insets.bottom, bannerHeight, headerOffset })}
    </Text>
  );
}

function probe(getByTestId: (id: string) => { props: { children: unknown } }) {
  return JSON.parse(String(getByTestId("probe").props.children)) as {
    top: number;
    bottom: number;
    bannerHeight: number;
    headerOffset: number;
  };
}

function renderLayout(headerless = false) {
  return render(
    <SafeAreaInsetsContext.Provider value={DEVICE_INSETS}>
      <OfflineBannerProvider>
        <OfflineScreenLayout headerless={headerless}>
          <Probe />
        </OfflineScreenLayout>
      </OfflineBannerProvider>
    </SafeAreaInsetsContext.Provider>,
  );
}

function layOutBanner(getByTestId: (id: string) => unknown, height: number) {
  fireEvent(getByTestId("offline-banner") as never, "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width: 390, height } },
  });
}

/** The testIDs in render order, so a test can tell a sibling in the flow from an overlay. */
function testIdsInOrder(tree: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const { props, children } = node as { props?: { testID?: string }; children?: unknown };
    if (props?.testID) ids.push(props.testID);
    walk(children);
  };
  walk(tree);
  return ids;
}

describe("OfflineScreenLayout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("online: no banner, and the screen keeps the device's insets", () => {
    setConnected(true);

    const { getByTestId, queryByTestId } = renderLayout();

    expect(queryByTestId("offline-banner")).toBeNull();
    expect(probe(getByTestId)).toEqual({ top: 24, bottom: 48, bannerHeight: 0, headerOffset: 0 });
  });

  it("offline below a header: the banner comes before the screen, which keeps its insets", () => {
    setConnected(false);

    const { getByTestId, toJSON } = renderLayout();

    expect(testIdsInOrder(toJSON())).toEqual(["offline-banner", "probe"]);
    // The header above already pads for the status bar; the banner doesn't again.
    expect(getByTestId("offline-banner").props.style).toEqual(
      expect.arrayContaining([{ paddingTop: spacing.xs }]),
    );
    expect(probe(getByTestId)).toEqual(expect.objectContaining({ top: 24, bottom: 48 }));
  });

  it("gives the screen and the toasts the banner's measured height", () => {
    setConnected(false);

    const { getByTestId } = renderLayout();
    layOutBanner(getByTestId, 28);

    expect(probe(getByTestId)).toEqual(
      expect.objectContaining({ bannerHeight: 28, headerOffset: 28 }),
    );
  });

  it("headerless: the banner takes the status-bar area and the screen sees a top inset of 0", () => {
    setConnected(false);

    const { getByTestId } = renderLayout(true);
    layOutBanner(getByTestId, 52);

    expect(getByTestId("offline-banner").props.style).toEqual(
      expect.arrayContaining([{ paddingTop: 24 + spacing.xs }]),
    );
    // Bottom insets are untouched, so the 3-button navigation bar is still cleared.
    expect(probe(getByTestId)).toEqual({ top: 0, bottom: 48, bannerHeight: 52, headerOffset: 0 });
  });

  it("headerless and online: the screen pads for the status bar itself, as before", () => {
    setConnected(true);

    const { getByTestId } = renderLayout(true);

    expect(probe(getByTestId)).toEqual(expect.objectContaining({ top: 24, bannerHeight: 0 }));
  });

  it("hides the banner, and gives the height back, once 'Back online' has been shown", () => {
    jest.useFakeTimers();
    try {
      setConnected(false);
      const view = renderLayout();
      layOutBanner(view.getByTestId, 28);

      setConnected(true);
      view.rerender(
        <SafeAreaInsetsContext.Provider value={DEVICE_INSETS}>
          <OfflineBannerProvider>
            <OfflineScreenLayout>
              <Probe />
            </OfflineScreenLayout>
          </OfflineBannerProvider>
        </SafeAreaInsetsContext.Provider>,
      );
      expect(view.getByText("Back online — syncing...")).toBeTruthy();

      act(() => {
        jest.advanceTimersByTime(RECONNECTED_HOLD_MS);
      });

      expect(view.queryByTestId("offline-banner")).toBeNull();
      expect(probe(view.getByTestId)).toEqual(
        expect.objectContaining({ bannerHeight: 0, headerOffset: 0 }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps the screen mounted when the connection changes", () => {
    setConnected(true);
    const mounts = jest.fn();
    function Screen() {
      React.useEffect(() => {
        mounts();
      }, []);
      return null;
    }
    // A new element each time, so the provider re-renders and reads the network again.
    const tree = () => (
      <OfflineBannerProvider>
        <OfflineScreenLayout>
          <Screen />
        </OfflineScreenLayout>
      </OfflineBannerProvider>
    );
    const { rerender, getByTestId } = render(tree());

    setConnected(false);
    rerender(tree());

    expect(getByTestId("offline-banner")).toBeTruthy();
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it("shows no banner outside an OfflineBannerProvider", () => {
    setConnected(false);

    const { queryByTestId } = render(
      <OfflineScreenLayout>
        <Text>screen</Text>
      </OfflineScreenLayout>,
    );

    expect(queryByTestId("offline-banner")).toBeNull();
  });
});

describe("offlineScreenLayout (a navigator's screenLayout)", () => {
  const screen = <Text testID="screen">screen</Text>;

  beforeEach(() => {
    setConnected(false);
  });

  function renderScreenLayout(name: string, headerShown?: boolean) {
    return render(
      <SafeAreaInsetsContext.Provider value={DEVICE_INSETS}>
        <OfflineBannerProvider>
          {offlineScreenLayout({ route: { name }, options: { headerShown }, children: screen })}
        </OfflineBannerProvider>
      </SafeAreaInsetsContext.Provider>,
    );
  }

  it("puts the banner below the header of a screen that has one", () => {
    const { getByTestId } = renderScreenLayout("notes/[id]");

    expect(getByTestId("offline-banner").props.style).toEqual(
      expect.arrayContaining([{ paddingTop: spacing.xs }]),
    );
    expect(getByTestId("screen")).toBeTruthy();
  });

  it("puts the banner at the very top of a headerless screen (login)", () => {
    const { getByTestId } = renderScreenLayout("(auth)/login", false);

    expect(getByTestId("offline-banner").props.style).toEqual(
      expect.arrayContaining([{ paddingTop: DEVICE_INSETS.top + spacing.xs }]),
    );
  });

  it("leaves (tabs) alone, whose own navigator draws the banner under each tab's header", () => {
    const { queryByTestId, getByTestId } = renderScreenLayout("(tabs)", false);

    expect(queryByTestId("offline-banner")).toBeNull();
    expect(getByTestId("screen")).toBeTruthy();
  });
});
