import React from "react";
import { Linking } from "react-native";
import { render, act } from "@testing-library/react-native";

import { setEnabledMenuActions, type MenuAction } from "@/lib/native/menu-manager";
import { MenuProvider, useMenuActions } from "@/providers/menu-provider";

let mockEmitMenuAction: (action: MenuAction) => void = () => {
  throw new Error("menu action listener not registered");
};

jest.mock("@/lib/native/menu-manager", () => ({
  setupMenus: jest.fn(),
  updateMenuState: jest.fn(),
  setEnabledMenuActions: jest.fn(),
  addMenuActionListener: jest.fn((callback: (action: MenuAction) => void) => {
    mockEmitMenuAction = callback;
    return jest.fn();
  }),
}));

const PROVIDER_ACTIONS = ["themeLight", "themeDark", "themeSystem", "openHelp"];

function lastEnabledActions(): MenuAction[] {
  const calls = jest.mocked(setEnabledMenuActions).mock.calls;
  return [...(calls[calls.length - 1]?.[0] ?? [])];
}

const mockSetTheme = jest.fn();
jest.mock("@/providers/theme-provider", () => ({
  useTheme: () => ({ theme: "system", setTheme: mockSetTheme }),
}));

function ScreenWithHandlers({ onNewNote }: { onNewNote: (() => void) | undefined }) {
  useMenuActions({ newNote: onNewNote });
  return null;
}

describe("MenuProvider", () => {
  let openURL: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  });

  afterEach(() => {
    openURL.mockRestore();
  });

  it("opens the support page for Help → Drafto Help with no screen handlers registered", () => {
    render(
      <MenuProvider>
        <></>
      </MenuProvider>,
    );

    act(() => mockEmitMenuAction("openHelp"));

    expect(openURL).toHaveBeenCalledWith("https://drafto.eu/support");
  });

  it("handles Help in the provider even when a screen has registered its own handlers", () => {
    const onNewNote = jest.fn();
    render(
      <MenuProvider>
        <ScreenWithHandlers onNewNote={onNewNote} />
      </MenuProvider>,
    );

    act(() => mockEmitMenuAction("openHelp"));

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(onNewNote).not.toHaveBeenCalled();
  });

  it("delegates screen actions to the registered handlers", () => {
    const onNewNote = jest.fn();
    render(
      <MenuProvider>
        <ScreenWithHandlers onNewNote={onNewNote} />
      </MenuProvider>,
    );

    act(() => mockEmitMenuAction("newNote"));

    expect(onNewNote).toHaveBeenCalledTimes(1);
    expect(openURL).not.toHaveBeenCalled();
  });

  it("runs the handler from the latest render, not the one registered on mount", () => {
    const firstRender = jest.fn();
    const latestRender = jest.fn();
    const { rerender } = render(
      <MenuProvider>
        <ScreenWithHandlers onNewNote={firstRender} />
      </MenuProvider>,
    );
    rerender(
      <MenuProvider>
        <ScreenWithHandlers onNewNote={latestRender} />
      </MenuProvider>,
    );

    act(() => mockEmitMenuAction("newNote"));

    expect(latestRender).toHaveBeenCalledTimes(1);
    expect(firstRender).not.toHaveBeenCalled();
  });

  it("does not re-report enabled actions when only a handler's identity changes", () => {
    const { rerender } = render(
      <MenuProvider>
        <ScreenWithHandlers onNewNote={jest.fn()} />
      </MenuProvider>,
    );
    const reports = jest.mocked(setEnabledMenuActions).mock.calls.length;

    rerender(
      <MenuProvider>
        <ScreenWithHandlers onNewNote={jest.fn()} />
      </MenuProvider>,
    );

    expect(jest.mocked(setEnabledMenuActions).mock.calls).toHaveLength(reports);
  });

  it("disables an action while its handler is undefined and enables it again once one is supplied", () => {
    const onNewNote = jest.fn();
    const screen = (handler: (() => void) | undefined) => (
      <MenuProvider>
        <ScreenWithHandlers onNewNote={handler} />
      </MenuProvider>
    );
    const { rerender } = render(screen(onNewNote));
    expect(lastEnabledActions()).toEqual([...PROVIDER_ACTIONS, "newNote"]);

    rerender(screen(undefined));

    expect(lastEnabledActions()).toEqual(PROVIDER_ACTIONS);
    act(() => mockEmitMenuAction("newNote"));
    expect(onNewNote).not.toHaveBeenCalled();

    rerender(screen(onNewNote));

    expect(lastEnabledActions()).toEqual([...PROVIDER_ACTIONS, "newNote"]);
    act(() => mockEmitMenuAction("newNote"));
    expect(onNewNote).toHaveBeenCalledTimes(1);
  });

  it("reports a changed action set in one update rather than clearing it first", () => {
    const screen = (handler: (() => void) | undefined) => (
      <MenuProvider>
        <ScreenWithHandlers onNewNote={handler} />
      </MenuProvider>
    );
    const { rerender } = render(screen(undefined));
    const reports = jest.mocked(setEnabledMenuActions).mock.calls.length;

    rerender(screen(jest.fn()));

    expect(jest.mocked(setEnabledMenuActions).mock.calls.slice(reports)).toEqual([
      [[...PROVIDER_ACTIONS, "newNote"]],
    ]);
  });

  it("logs instead of leaving an unhandled rejection when the support page can't open", async () => {
    const failure = new Error("no default browser");
    openURL.mockRejectedValueOnce(failure);
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    render(
      <MenuProvider>
        <></>
      </MenuProvider>,
    );

    await act(async () => mockEmitMenuAction("openHelp"));

    expect(consoleError).toHaveBeenCalledWith(
      "Help → Drafto Help could not open",
      "https://drafto.eu/support",
      failure,
    );
    consoleError.mockRestore();
  });

  it("enables only the provider's own actions while no screen has registered (login)", () => {
    render(
      <MenuProvider>
        <></>
      </MenuProvider>,
    );

    expect(lastEnabledActions()).toEqual(PROVIDER_ACTIONS);
  });

  it("enables a screen's actions while it is mounted and drops them when it unmounts", () => {
    const { rerender } = render(
      <MenuProvider>
        <ScreenWithHandlers onNewNote={jest.fn()} />
      </MenuProvider>,
    );

    expect(lastEnabledActions()).toEqual([...PROVIDER_ACTIONS, "newNote"]);

    rerender(
      <MenuProvider>
        <></>
      </MenuProvider>,
    );

    expect(lastEnabledActions()).toEqual(PROVIDER_ACTIONS);
  });

  it("applies theme actions directly", () => {
    render(
      <MenuProvider>
        <></>
      </MenuProvider>,
    );

    act(() => mockEmitMenuAction("themeDark"));

    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });
});
