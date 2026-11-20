import React from "react";
import * as ReactNative from "react-native";
import { AppState, Platform, Pressable, Text, type AppStateStatus } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as NavigationBar from "expo-navigation-bar";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import {
  MIN_NAVIGATION_BAR_STYLE_API_LEVEL,
  SystemBars,
  canStyleNavigationBar,
  statusBarContentStyleFor,
  systemBarContentStyleFor,
} from "@/components/system-bars";
import { OfflineScreenLayout } from "@/components/navigation/offline-screen-layout";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { OfflineBannerProvider } from "@/providers/offline-banner-provider";
import { useTheme, type ThemePreference } from "@/providers/theme-provider";

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: jest.fn(() => ({ isConnected: true, isInternetReachable: true })),
}));

const mockStatusBar = jest.fn();
jest.mock("expo-status-bar", () => ({
  StatusBar: (props: { style: string }) => {
    mockStatusBar(props);
    return null;
  },
}));

// Mocked in jest.setup.js. It takes the *button* (content) colour: "light" buttons on a dark bar.
const setButtonStyle = NavigationBar.setButtonStyleAsync as jest.Mock;
const getItemAsync = SecureStore.getItemAsync as jest.Mock;

type AppStateListener = (state: AppStateStatus) => void;

/** Captures the AppState listener SystemBars registers, so a test can fire it. */
function spyOnAppState() {
  const listeners = new Set<AppStateListener>();
  const remove = jest.fn();
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    const appStateListener = listener as AppStateListener;
    listeners.add(appStateListener);
    return {
      remove: () => {
        remove();
        listeners.delete(appStateListener);
      },
    };
  });
  return {
    remove,
    emit: (state: AppStateStatus) => listeners.forEach((listener) => listener(state)),
  };
}

/** Platform.Version is a getter (undefined under jest); on Android it is the API level. */
function mockApiLevel(level: number | string | undefined) {
  return jest.spyOn(Platform, "Version", "get").mockReturnValue(level as number);
}

function mockOsScheme(scheme: "light" | "dark") {
  return jest.spyOn(ReactNative, "useColorScheme").mockReturnValue(scheme);
}

/** Stands in for the Settings theme picker: one button per preference. */
function ThemeSwitcher() {
  const { setTheme } = useTheme();
  const options: ThemePreference[] = ["system", "light", "dark"];
  return (
    <>
      {options.map((option) => (
        <Pressable key={option} testID={`switch-${option}`} onPress={() => setTheme(option)}>
          <Text>{option}</Text>
        </Pressable>
      ))}
    </>
  );
}

/** The last button style set: "light" means a dark bar, "dark" a light one. */
function lastButtonStyle() {
  return setButtonStyle.mock.calls[setButtonStyle.mock.calls.length - 1]?.[0];
}

describe("systemBarContentStyleFor", () => {
  it("gives light content on a dark theme and dark content on a light one", () => {
    expect(systemBarContentStyleFor(true)).toBe("light");
    expect(systemBarContentStyleFor(false)).toBe("dark");
  });
});

describe("canStyleNavigationBar", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("allows Android API 29 and later", () => {
    jest.replaceProperty(Platform, "OS", "android");
    expect(MIN_NAVIGATION_BAR_STYLE_API_LEVEL).toBe(29);
    for (const level of [29, 30, 34, 35]) {
      mockApiLevel(level);
      expect(canStyleNavigationBar()).toBe(true);
    }
  });

  it("refuses Android below API 29, where the bar has a fixed OS-themed colour", () => {
    jest.replaceProperty(Platform, "OS", "android");
    for (const level of [24, 26, 28]) {
      mockApiLevel(level);
      expect(canStyleNavigationBar()).toBe(false);
    }
  });

  it("refuses an API level it cannot read", () => {
    jest.replaceProperty(Platform, "OS", "android");
    mockApiLevel(undefined);
    expect(canStyleNavigationBar()).toBe(false);
  });

  it("refuses iOS, whatever its version", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    mockApiLevel("18.0");
    expect(canStyleNavigationBar()).toBe(false);
  });
});

describe("statusBarContentStyleFor", () => {
  it("follows the theme while no banner covers the status bar", () => {
    expect(statusBarContentStyleFor(true, false)).toBe("light");
    expect(statusBarContentStyleFor(false, false)).toBe("dark");
  });

  it("is light over the banner at the top of a headerless screen, in either theme", () => {
    expect(statusBarContentStyleFor(true, true)).toBe("light");
    expect(statusBarContentStyleFor(false, true)).toBe("light");
  });
});

describe("SystemBars", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getItemAsync.mockResolvedValue(null);
    setButtonStyle.mockImplementation(() => Promise.resolve());
    jest.replaceProperty(Platform, "OS", "android");
    mockApiLevel(34);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("makes the navigation bar dark when the app is Dark and the OS is Light", async () => {
    getItemAsync.mockResolvedValue("dark");
    mockOsScheme("light");
    spyOnAppState();

    render(<SystemBars />);

    // Light buttons, so Android paints the dark contrast scrim.
    await waitFor(() => expect(lastButtonStyle()).toBe("light"));
    expect(mockStatusBar).toHaveBeenLastCalledWith({ style: "light" });
  });

  it("makes the navigation bar light when the app is Light and the OS is Dark", async () => {
    getItemAsync.mockResolvedValue("light");
    mockOsScheme("dark");
    spyOnAppState();

    render(<SystemBars />);

    await waitFor(() => expect(lastButtonStyle()).toBe("dark"));
    expect(mockStatusBar).toHaveBeenLastCalledWith({ style: "dark" });
  });

  it("follows the OS when the preference is System", async () => {
    getItemAsync.mockResolvedValue("system");
    const scheme = mockOsScheme("light");
    spyOnAppState();

    const { rerender } = render(<SystemBars />);
    await waitFor(() => expect(getItemAsync).toHaveBeenCalled());
    expect(lastButtonStyle()).toBe("dark");

    scheme.mockReturnValue("dark");
    rerender(<SystemBars />);
    expect(lastButtonStyle()).toBe("light");

    scheme.mockReturnValue("light");
    rerender(<SystemBars />);
    expect(lastButtonStyle()).toBe("dark");
  });

  it("restyles the bar as soon as the user switches theme in the app", async () => {
    mockOsScheme("light");
    spyOnAppState();

    const { getByTestId } = render(
      <>
        <ThemeSwitcher />
        <SystemBars />
      </>,
    );
    await waitFor(() => expect(getItemAsync).toHaveBeenCalled());
    expect(lastButtonStyle()).toBe("dark");

    fireEvent.press(getByTestId("switch-dark"));
    expect(lastButtonStyle()).toBe("light");

    fireEvent.press(getByTestId("switch-light"));
    expect(lastButtonStyle()).toBe("dark");
  });

  it("re-applies the style when the app returns to the foreground", async () => {
    getItemAsync.mockResolvedValue("dark");
    mockOsScheme("light");
    const appState = spyOnAppState();

    render(<SystemBars />);
    await waitFor(() => expect(lastButtonStyle()).toBe("light"));

    setButtonStyle.mockClear();
    act(() => appState.emit("background"));
    expect(setButtonStyle).not.toHaveBeenCalled();

    act(() => appState.emit("active"));
    expect(setButtonStyle).toHaveBeenCalledTimes(1);
    expect(setButtonStyle).toHaveBeenCalledWith("light");
  });

  it("subscribes to AppState once and re-applies the latest theme on resume", async () => {
    mockOsScheme("light");
    const appState = spyOnAppState();
    const addEventListener = AppState.addEventListener as jest.Mock;

    const { getByTestId } = render(
      <>
        <ThemeSwitcher />
        <SystemBars />
      </>,
    );
    await waitFor(() => expect(getItemAsync).toHaveBeenCalled());

    fireEvent.press(getByTestId("switch-dark"));
    fireEvent.press(getByTestId("switch-light"));
    fireEvent.press(getByTestId("switch-dark"));

    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(appState.remove).not.toHaveBeenCalled();

    setButtonStyle.mockClear();
    act(() => appState.emit("active"));
    expect(setButtonStyle).toHaveBeenCalledTimes(1);
    expect(setButtonStyle).toHaveBeenCalledWith("light");
  });

  it("catches a rejected native call instead of leaving an unhandled rejection", async () => {
    const failure = new Error("Current activity is no longer available");
    setButtonStyle.mockImplementation(() => Promise.reject(failure));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockOsScheme("light");
    const appState = spyOnAppState();

    render(<SystemBars />);
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    act(() => appState.emit("active"));
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalledWith("[SystemBars] Could not style the navigation bar:", failure);
  });

  it("catches a native call that throws synchronously", async () => {
    const failure = new Error("Cannot find native module 'ExpoNavigationBar'");
    setButtonStyle.mockImplementation(() => {
      throw failure;
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockOsScheme("light");
    spyOnAppState();

    expect(() => render(<SystemBars />)).not.toThrow();
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "[SystemBars] Could not style the navigation bar:",
        failure,
      ),
    );
  });

  it("drops its AppState listener on unmount", () => {
    mockOsScheme("light");
    const appState = spyOnAppState();

    const { unmount } = render(<SystemBars />);
    unmount();

    expect(appState.remove).toHaveBeenCalled();
  });

  it("never touches the navigation bar on iOS, which has none", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    getItemAsync.mockResolvedValue("dark");
    mockOsScheme("light");
    const addEventListener = jest.spyOn(AppState, "addEventListener");

    render(<SystemBars />);
    await waitFor(() => expect(mockStatusBar).toHaveBeenLastCalledWith({ style: "light" }));

    expect(setButtonStyle).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("leaves the navigation bar alone below Android API 29 but still styles the status bar", async () => {
    mockApiLevel(28);
    getItemAsync.mockResolvedValue("dark");
    mockOsScheme("light");
    const addEventListener = jest.spyOn(AppState, "addEventListener");

    render(<SystemBars />);
    await waitFor(() => expect(mockStatusBar).toHaveBeenLastCalledWith({ style: "light" }));

    expect(setButtonStyle).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("styles the navigation bar from Android API 29", async () => {
    mockApiLevel(29);
    getItemAsync.mockResolvedValue("dark");
    mockOsScheme("light");
    spyOnAppState();

    render(<SystemBars />);

    await waitFor(() => expect(lastButtonStyle()).toBe("light"));
  });

  it("only ever passes an explicit light or dark style, never one that reads the OS", async () => {
    const scheme = mockOsScheme("dark");
    const appState = spyOnAppState();

    const { getByTestId, rerender } = render(
      <>
        <ThemeSwitcher />
        <SystemBars />
      </>,
    );
    await waitFor(() => expect(getItemAsync).toHaveBeenCalled());
    fireEvent.press(getByTestId("switch-light"));
    fireEvent.press(getByTestId("switch-dark"));
    fireEvent.press(getByTestId("switch-system"));
    scheme.mockReturnValue("light");
    rerender(
      <>
        <ThemeSwitcher />
        <SystemBars />
      </>,
    );
    act(() => appState.emit("active"));

    expect(setButtonStyle.mock.calls.length).toBeGreaterThan(0);
    for (const [style] of setButtonStyle.mock.calls) {
      expect(["light", "dark"]).toContain(style);
    }
  });
});

describe("SystemBars with the offline banner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getItemAsync.mockResolvedValue("light");
    setButtonStyle.mockImplementation(() => Promise.resolve());
    jest.replaceProperty(Platform, "OS", "android");
    mockApiLevel(34);
    jest
      .mocked(useNetworkStatus)
      .mockReturnValue({ isConnected: false, isInternetReachable: false });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.mocked(useNetworkStatus).mockReturnValue({ isConnected: true, isInternetReachable: true });
  });

  function renderWithScreen(headerless: boolean) {
    mockOsScheme("light");
    spyOnAppState();
    return render(
      <OfflineBannerProvider>
        <SystemBars />
        <OfflineScreenLayout screenKey="screen-1" headerless={headerless}>
          <Text>screen</Text>
        </OfflineScreenLayout>
      </OfflineBannerProvider>,
    );
  }

  it("gives the status bar light content over a headerless screen's banner, but not the navigation bar", async () => {
    renderWithScreen(true);

    await waitFor(() => expect(lastButtonStyle()).toBe("dark"));
    expect(mockStatusBar).toHaveBeenLastCalledWith({ style: "light" });
  });

  it("keeps the theme's style when the banner hangs below a header", async () => {
    renderWithScreen(false);

    await waitFor(() => expect(lastButtonStyle()).toBe("dark"));
    expect(mockStatusBar).toHaveBeenLastCalledWith({ style: "dark" });
  });
});
