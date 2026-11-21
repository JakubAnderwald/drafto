import React from "react";
import { Text } from "react-native";
import * as ReactNative from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { render, act, waitFor } from "@testing-library/react-native";

import { applyAppAppearance } from "@/lib/native/app-appearance";
import { ThemeProvider, useTheme, type ThemePreference } from "@/providers/theme-provider";

// jest.setup.js mocks the theme provider for every other suite; this one tests the real thing.
jest.unmock("@/providers/theme-provider");

jest.mock("@/lib/native/app-appearance", () => ({
  applyAppAppearance: jest.fn(),
}));

let setThemeFromTest: (theme: ThemePreference) => void = () => {
  throw new Error("ThemeProvider not mounted");
};

function Probe() {
  const { theme, isDark, setTheme } = useTheme();
  setThemeFromTest = setTheme;
  return <Text testID="probe">{`${theme}:${isDark ? "dark" : "light"}`}</Text>;
}

function renderProvider() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

// Lets the AsyncStorage promise settle, so a test sees whatever the stored value did.
async function flushStorage() {
  await act(async () => {});
}

describe("ThemeProvider native appearance", () => {
  let useColorScheme: jest.SpyInstance;

  beforeEach(() => {
    jest.mocked(applyAppAppearance).mockClear();
    jest.mocked(AsyncStorage.getItem).mockReset();
    jest.mocked(AsyncStorage.setItem).mockReset();
    jest.mocked(AsyncStorage.setItem).mockResolvedValue(undefined);
    useColorScheme = jest.spyOn(ReactNative, "useColorScheme").mockReturnValue("light");
  });

  afterEach(() => {
    useColorScheme.mockRestore();
  });

  function appliedThemes(): ThemePreference[] {
    return jest.mocked(applyAppAppearance).mock.calls.map(([theme]) => theme);
  }

  it("hands the appearance to the OS on mount when nothing is stored", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    const { getByTestId } = renderProvider();
    await flushStorage();

    expect(appliedThemes()).toEqual(["system"]);
    expect(getByTestId("probe").props.children).toBe("system:light");
  });

  it("applies the stored preference once it loads", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue("dark");
    const { getByTestId } = renderProvider();

    await waitFor(() => expect(getByTestId("probe").props.children).toBe("dark:dark"));
    expect(appliedThemes()).toEqual(["system", "dark"]);
  });

  it("applies every theme change and goes back to the OS for System", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    const { getByTestId } = renderProvider();
    await flushStorage();

    act(() => setThemeFromTest("dark"));
    expect(getByTestId("probe").props.children).toBe("dark:dark");
    act(() => setThemeFromTest("light"));
    act(() => setThemeFromTest("system"));

    expect(appliedThemes()).toEqual(["system", "dark", "light", "system"]);
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith("drafto_theme_preference", "system");
  });

  it("follows the OS scheme while System is selected", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    useColorScheme.mockReturnValue("dark");
    const { getByTestId } = renderProvider();
    await flushStorage();

    expect(getByTestId("probe").props.children).toBe("system:dark");
  });

  it("keeps a theme picked before the stored preference loads", async () => {
    let resolveStored: (value: string | null) => void = () => {};
    jest.mocked(AsyncStorage.getItem).mockReturnValue(
      new Promise((resolve) => {
        resolveStored = resolve;
      }),
    );
    const { getByTestId } = renderProvider();

    act(() => setThemeFromTest("dark"));
    await act(async () => resolveStored("light"));

    expect(getByTestId("probe").props.children).toBe("dark:dark");
    expect(appliedThemes()).toEqual(["system", "dark"]);
  });
});
