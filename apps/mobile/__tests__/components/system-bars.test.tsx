import React from "react";
import * as ReactNative from "react-native";
import { AppState, Platform, Pressable, Text, type AppStateStatus } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as NavigationBar from "expo-navigation-bar";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import { SystemBars, navigationBarStyleFor } from "@/components/system-bars";
import { useTheme, type ThemePreference } from "@/providers/theme-provider";

// The native module is not linked under jest; only the style calls matter here.
jest.mock("expo-navigation-bar", () => ({ setStyle: jest.fn() }));

const mockStatusBar = jest.fn();
jest.mock("expo-status-bar", () => ({
  StatusBar: (props: { style: string }) => {
    mockStatusBar(props);
    return null;
  },
}));

const setStyle = NavigationBar.setStyle as jest.Mock;
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

function lastStyle() {
  return setStyle.mock.calls[setStyle.mock.calls.length - 1]?.[0];
}

describe("navigationBarStyleFor", () => {
  it("maps the resolved theme to an explicit style", () => {
    expect(navigationBarStyleFor(true)).toBe("dark");
    expect(navigationBarStyleFor(false)).toBe("light");
  });
});

describe("SystemBars", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getItemAsync.mockResolvedValue(null);
    jest.replaceProperty(Platform, "OS", "android");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("makes the navigation bar dark when the app is Dark and the OS is Light", async () => {
    getItemAsync.mockResolvedValue("dark");
    mockOsScheme("light");
    spyOnAppState();

    render(<SystemBars />);

    await waitFor(() => expect(lastStyle()).toBe("dark"));
    expect(mockStatusBar).toHaveBeenLastCalledWith({ style: "light" });
  });

  it("makes the navigation bar light when the app is Light and the OS is Dark", async () => {
    getItemAsync.mockResolvedValue("light");
    mockOsScheme("dark");
    spyOnAppState();

    render(<SystemBars />);

    await waitFor(() => expect(lastStyle()).toBe("light"));
    expect(mockStatusBar).toHaveBeenLastCalledWith({ style: "dark" });
  });

  it("follows the OS when the preference is System", async () => {
    getItemAsync.mockResolvedValue("system");
    const scheme = mockOsScheme("light");
    spyOnAppState();

    const { rerender } = render(<SystemBars />);
    await waitFor(() => expect(getItemAsync).toHaveBeenCalled());
    expect(lastStyle()).toBe("light");

    scheme.mockReturnValue("dark");
    rerender(<SystemBars />);
    expect(lastStyle()).toBe("dark");

    scheme.mockReturnValue("light");
    rerender(<SystemBars />);
    expect(lastStyle()).toBe("light");
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
    expect(lastStyle()).toBe("light");

    fireEvent.press(getByTestId("switch-dark"));
    expect(lastStyle()).toBe("dark");

    fireEvent.press(getByTestId("switch-light"));
    expect(lastStyle()).toBe("light");
  });

  it("re-applies the style when the app returns to the foreground", async () => {
    getItemAsync.mockResolvedValue("dark");
    mockOsScheme("light");
    const appState = spyOnAppState();

    render(<SystemBars />);
    await waitFor(() => expect(lastStyle()).toBe("dark"));

    setStyle.mockClear();
    act(() => appState.emit("background"));
    expect(setStyle).not.toHaveBeenCalled();

    act(() => appState.emit("active"));
    expect(setStyle).toHaveBeenCalledTimes(1);
    expect(setStyle).toHaveBeenCalledWith("dark");
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

    expect(setStyle).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
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

    expect(setStyle.mock.calls.length).toBeGreaterThan(0);
    for (const [style] of setStyle.mock.calls) {
      expect(["light", "dark"]).toContain(style);
    }
  });
});
