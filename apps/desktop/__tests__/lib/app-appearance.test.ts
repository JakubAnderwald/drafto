import { Appearance } from "react-native";

import { applyAppAppearance, colorSchemeForTheme } from "@/lib/native/app-appearance";

describe("colorSchemeForTheme", () => {
  it.each([
    ["light", "light"],
    ["dark", "dark"],
    ["system", "unspecified"],
  ] as const)("maps %s to %s", (theme, expected) => {
    expect(colorSchemeForTheme(theme)).toBe(expected);
  });
});

describe("applyAppAppearance", () => {
  let setColorScheme: jest.SpyInstance;

  beforeEach(() => {
    setColorScheme = jest.spyOn(Appearance, "setColorScheme").mockImplementation(() => {});
  });

  afterEach(() => {
    setColorScheme.mockRestore();
  });

  it.each([
    ["light", "light"],
    ["dark", "dark"],
    ["system", "unspecified"],
  ] as const)("sets the native colour scheme for %s to %s", (theme, expected) => {
    applyAppAppearance(theme);
    expect(setColorScheme).toHaveBeenCalledTimes(1);
    expect(setColorScheme).toHaveBeenCalledWith(expected);
  });
});
