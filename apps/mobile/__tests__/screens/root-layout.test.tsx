import React from "react";
import * as ReactNative from "react-native";
import { Platform } from "react-native";
import * as NavigationBar from "expo-navigation-bar";

import { render, act, fireEvent, waitFor } from "../helpers/test-utils";
import { fakeNavigation, type FakeNavigation } from "../helpers/fake-navigation";

// The header options registered for each route in app/_layout.tsx.

type ScreenOptions =
  | Record<string, unknown>
  | ((props: {
      route: { key: string; name: string };
      navigation: { getState: () => { routes: { key: string; name: string }[] } };
    }) => Record<string, unknown>);
type ScreenProps = { name: string; options?: ScreenOptions };

type ScreenLayout = (props: {
  route: { key: string; name: string };
  navigation: FakeNavigation;
  options: { headerShown?: boolean };
  children: React.ReactElement;
}) => React.ReactElement;

/** A route the mock Stack draws, the way native-stack keeps every pushed screen mounted. */
type MockRoute = { key: string; name: string; headerShown?: boolean; navigation: FakeNavigation };

const mockScreens: ScreenProps[] = [];
const mockStack: { screenLayout?: ScreenLayout; routes: MockRoute[] } = { routes: [] };
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn(), dismissTo: jest.fn() }),
  useSegments: () => ["(tabs)"],
  // Renders each mocked route through the navigator's screenLayout, the way
  // native-stack wraps each screen's content (below its header). With no routes
  // set, one stand-in note screen.
  Stack: Object.assign(
    ({ children, screenLayout }: { children: React.ReactNode; screenLayout?: ScreenLayout }) => {
      mockStack.screenLayout = screenLayout;
      const { Fragment: MockFragment } = jest.requireActual("react");
      const { Text: MockText } = jest.requireActual("react-native");
      const { fakeNavigation: makeNavigation } = jest.requireActual("../helpers/fake-navigation");
      const routes: MockRoute[] = mockStack.routes.length
        ? mockStack.routes
        : [{ key: "note-1", name: "notes/[id]", navigation: makeNavigation() }];
      return (
        <>
          {children}
          {routes.map(({ key, name, headerShown, navigation }) => {
            const screen = (
              <MockText testID={name === "notes/[id]" ? "note-screen-content" : `screen-${key}`}>
                {name}
              </MockText>
            );
            return (
              <MockFragment key={key}>
                {screenLayout
                  ? screenLayout({
                      route: { key, name },
                      navigation,
                      options: { headerShown },
                      children: screen,
                    })
                  : screen}
              </MockFragment>
            );
          })}
        </>
      );
    },
    {
      Screen: (props: ScreenProps) => {
        mockScreens.push(props);
        return null;
      },
    },
  ),
}));

// Drawn as a host view, so a test can count the mounted StatusBars and read their style.
jest.mock("expo-status-bar", () => ({
  StatusBar: ({ style }: { style: string }) => {
    const { View: MockView } = jest.requireActual("react-native");
    return <MockView testID="status-bar" accessibilityLabel={style} />;
  },
}));

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: jest.fn(() => ({ isConnected: true, isInternetReachable: true })),
}));

const mockAuth = { isLoading: false };
jest.mock("@/providers/auth-provider", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    user: { id: "user-1" },
    isApproved: true,
    isLoading: mockAuth.isLoading,
    isCheckingApproval: false,
    isRecovering: false,
  }),
}));
jest.mock("@/providers/database-provider", () => ({
  DatabaseProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@/components/toast", () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@/lib/oauth", () => ({ configureGoogleSignIn: jest.fn() }));
jest.mock("@/lib/performance", () => ({
  markStartupBegin: jest.fn(),
  markStartupEnd: jest.fn(),
}));

import RootLayout from "../../app/_layout";
import { offlineScreenLayout } from "@/components/navigation/offline-screen-layout";
import { useNetworkStatus } from "@/hooks/use-network-status";

type StackRoute = { key: string; name: string };

const TABS: StackRoute = { key: "tabs-1", name: "(tabs)" };
const NOTEBOOK: StackRoute = { key: "notebook-1", name: "notebooks/[id]" };
const SEARCH: StackRoute = { key: "search-1", name: "search" };
const NOTE: StackRoute = { key: "note-1", name: "notes/[id]" };

/**
 * A screen's options, resolved for the last route of `stack` if they are a
 * function, the way native-stack calls them.
 */
function optionsFor(name: string, stack: StackRoute[] = [TABS]) {
  const options = mockScreens.find((screen) => screen.name === name)?.options;
  if (typeof options !== "function") return options;
  const route = stack[stack.length - 1];
  return options({ route, navigation: { getState: () => ({ routes: stack }) } });
}

/** Renders a header's left button, if the options have one. */
function headerLeftOf(options: Record<string, unknown> | undefined) {
  const headerLeft = options?.headerLeft as (() => React.ReactElement) | undefined;
  return headerLeft ? render(headerLeft()) : null;
}

describe("RootLayout screen options", () => {
  beforeEach(() => {
    mockScreens.length = 0;
    jest.replaceProperty(Platform, "OS", "ios");
    render(<RootLayout />);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("gives the editor no header title, so 'Editor' never shows while a note loads", () => {
    expect(optionsFor("notes/[id]", [TABS, NOTEBOOK, NOTE])).toEqual(
      expect.objectContaining({ title: "" }),
    );
  });

  it("keeps the editor's back label 'Notes', not the notebook's name", () => {
    expect(optionsFor("notes/[id]", [TABS, NOTEBOOK, NOTE])).toEqual(
      expect.objectContaining({ headerBackTitle: "Notes" }),
    );
  });

  it("leaves the notebook screen's title to the screen, which shows the notebook's name", () => {
    expect(optionsFor("notebooks/[id]", [TABS, NOTEBOOK])).toEqual(
      expect.objectContaining({ title: "" }),
    );
  });

  it("gives the search sheet a close button on iOS", () => {
    const options = optionsFor("search", [TABS, SEARCH]);

    expect(options).toEqual(expect.objectContaining({ title: "Search", presentation: "modal" }));
    expect(headerLeftOf(options)?.getByTestId("search-close")).toBeTruthy();
  });

  it("gives a note opened from Search a close button on iOS, where it is a sheet of its own", () => {
    const options = optionsFor("notes/[id]", [TABS, SEARCH, NOTE]);

    expect(headerLeftOf(options)?.getByTestId("note-sheet-close")).toBeTruthy();
    expect(options).toEqual(expect.objectContaining({ title: "", headerBackTitle: "Notes" }));
  });

  it("gives a notebook that ends up above Search a close button too", () => {
    const options = optionsFor("notebooks/[id]", [TABS, SEARCH, NOTEBOOK]);

    expect(headerLeftOf(options)?.getByTestId("notebook-sheet-close")).toBeTruthy();
  });

  it("keeps the back button on a note opened from a notebook", () => {
    expect(optionsFor("notes/[id]", [TABS, NOTEBOOK, NOTE])?.headerLeft).toBeUndefined();
    expect(optionsFor("notebooks/[id]", [TABS, NOTEBOOK])?.headerLeft).toBeUndefined();
  });

  it("adds no close buttons on Android, where these screens have a back arrow", () => {
    jest.replaceProperty(Platform, "OS", "android");

    expect(optionsFor("search", [TABS, SEARCH])?.headerLeft).toBeUndefined();
    expect(optionsFor("notes/[id]", [TABS, SEARCH, NOTE])?.headerLeft).toBeUndefined();
  });
});

describe("RootLayout system bars", () => {
  // The jest.setup.js mock: SystemBars styles the Android navigation bar through it.
  const setButtonStyle = NavigationBar.setButtonStyleAsync as jest.Mock;

  beforeEach(() => {
    mockScreens.length = 0;
    setButtonStyle.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockAuth.isLoading = false;
  });

  /** Android on an API level SystemBars styles (29+); Platform.Version is undefined under jest. */
  function mockAndroid() {
    jest.replaceProperty(Platform, "OS", "android");
    jest.spyOn(Platform, "Version", "get").mockReturnValue(34);
  }

  it("mounts SystemBars, which styles the Android navigation bar from the app theme", () => {
    mockAndroid();

    render(<RootLayout />);

    expect(setButtonStyle).toHaveBeenCalled();
    for (const [style] of setButtonStyle.mock.calls) {
      expect(["light", "dark"]).toContain(style);
    }
  });

  it("styles the navigation bar on the launch loading screen, before auth finishes", () => {
    mockAndroid();
    mockAuth.isLoading = true;

    const { getByTestId } = render(<RootLayout />);

    expect(getByTestId("route-guard-loading")).toBeTruthy();
    expect(mockScreens).toHaveLength(0);
    expect(setButtonStyle).toHaveBeenCalled();
  });

  it("leaves the navigation bar alone on iOS", () => {
    jest.replaceProperty(Platform, "OS", "ios");

    render(<RootLayout />);

    expect(setButtonStyle).not.toHaveBeenCalled();
  });
});

describe("RootLayout offline banner", () => {
  const mockedNetwork = jest.mocked(useNetworkStatus);

  afterEach(() => {
    mockedNetwork.mockReturnValue({ isConnected: true, isInternetReachable: true });
  });

  it("gives every stack screen its own banner through screenLayout", () => {
    render(<RootLayout />);

    expect(mockStack.screenLayout).toBe(offlineScreenLayout);
  });

  it("draws the banner in the screen's layout, above its content, when offline", () => {
    mockedNetwork.mockReturnValue({ isConnected: false, isInternetReachable: false });

    const { getAllByTestId, getByText, toJSON } = render(<RootLayout />);

    // Exactly one banner: the screen's. Nothing is laid over the stack's headers.
    expect(getAllByTestId("offline-banner")).toHaveLength(1);
    expect(getByText("You are offline")).toBeTruthy();
    const json = JSON.stringify(toJSON());
    expect(json.indexOf('"offline-banner"')).toBeLessThan(json.indexOf('"note-screen-content"'));
  });

  it("shows no banner online", () => {
    const { queryByTestId, getByTestId } = render(<RootLayout />);

    expect(queryByTestId("offline-banner")).toBeNull();
    expect(getByTestId("note-screen-content")).toBeTruthy();
  });
});

describe("RootLayout status bar", () => {
  const mockedNetwork = jest.mocked(useNetworkStatus);
  const OFFLINE = { isConnected: false, isInternetReachable: false };

  /** The style of the one StatusBar in the tree: SystemBars' (the banner has none). */
  function statusBarStyle(view: ReturnType<typeof render>) {
    const bars = view.getAllByTestId("status-bar");
    expect(bars).toHaveLength(1);
    return bars[0].props.accessibilityLabel;
  }

  function layOutBanner(view: ReturnType<typeof render>, index: number, height: number) {
    act(() => {
      fireEvent(view.getAllByTestId("offline-banner")[index], "layout", {
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height } },
      });
    });
  }

  const login = (): MockRoute => ({
    key: "login-1",
    name: "(auth)/login",
    headerShown: false,
    navigation: fakeNavigation(),
  });

  beforeEach(() => {
    jest.replaceProperty(Platform, "OS", "ios");
    // A Light app, whose own status bar has dark content.
    jest.spyOn(ReactNative, "useColorScheme").mockReturnValue("light");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockedNetwork.mockReturnValue({ isConnected: true, isInternetReachable: true });
    mockStack.routes = [];
    mockAuth.isLoading = false;
  });

  it("offline on login: light content over the red banner at the top", async () => {
    mockedNetwork.mockReturnValue(OFFLINE);
    mockStack.routes = [login()];

    const view = render(<RootLayout />);

    await waitFor(() => expect(statusBarStyle(view)).toBe("light"));
  });

  it("pushing sign-up, which has a header, goes back to the theme's style", async () => {
    mockedNetwork.mockReturnValue(OFFLINE);
    const loginRoute = login();
    mockStack.routes = [loginRoute];
    const view = render(<RootLayout />);
    await waitFor(() => expect(statusBarStyle(view)).toBe("light"));

    // Login stays mounted under sign-up, banner and all, but is no longer focused.
    loginRoute.navigation.setFocused(false);
    mockStack.routes = [
      loginRoute,
      { key: "signup-1", name: "(auth)/signup", navigation: fakeNavigation() },
    ];
    view.rerender(<RootLayout />);
    layOutBanner(view, 1, 28);

    expect(view.getAllByTestId("offline-banner")).toHaveLength(2);
    expect(statusBarStyle(view)).toBe("dark");

    // Back to login: light again.
    mockStack.routes = [loginRoute];
    view.rerender(<RootLayout />);
    loginRoute.navigation.setFocused(true);

    expect(statusBarStyle(view)).toBe("light");
  });

  it("cold start offline: light over the loading screen's banner, then the theme under a header", async () => {
    mockedNetwork.mockReturnValue(OFFLINE);
    mockAuth.isLoading = true;

    const view = render(<RootLayout />);

    expect(view.getByTestId("route-guard-loading")).toBeTruthy();
    await waitFor(() => expect(statusBarStyle(view)).toBe("light"));

    // Auth finishes and the app opens on a note, which has a header.
    mockAuth.isLoading = false;
    view.rerender(<RootLayout />);

    expect(view.getByTestId("note-screen-content")).toBeTruthy();
    expect(statusBarStyle(view)).toBe("dark");
  });

  it("cold start offline straight onto login keeps light content", async () => {
    mockedNetwork.mockReturnValue(OFFLINE);
    mockAuth.isLoading = true;
    mockStack.routes = [login()];

    const view = render(<RootLayout />);
    await waitFor(() => expect(statusBarStyle(view)).toBe("light"));

    mockAuth.isLoading = false;
    view.rerender(<RootLayout />);

    expect(statusBarStyle(view)).toBe("light");
  });

  it("online, login keeps the theme's style", async () => {
    mockStack.routes = [login()];

    const view = render(<RootLayout />);

    await waitFor(() => expect(statusBarStyle(view)).toBe("dark"));
  });
});
