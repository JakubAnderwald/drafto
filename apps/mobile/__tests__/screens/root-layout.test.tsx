import React from "react";
import { Platform } from "react-native";

import { render } from "../helpers/test-utils";

// The header options registered for each route in app/_layout.tsx.

type ScreenOptions =
  | Record<string, unknown>
  | ((props: {
      route: { key: string; name: string };
      navigation: { getState: () => { routes: { key: string; name: string }[] } };
    }) => Record<string, unknown>);
type ScreenProps = { name: string; options?: ScreenOptions };

const mockScreens: ScreenProps[] = [];
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn(), dismissTo: jest.fn() }),
  useSegments: () => ["(tabs)"],
  Stack: Object.assign(({ children }: { children: React.ReactNode }) => children, {
    Screen: (props: ScreenProps) => {
      mockScreens.push(props);
      return null;
    },
  }),
}));

jest.mock("@/providers/auth-provider", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    user: { id: "user-1" },
    isApproved: true,
    isLoading: false,
    isCheckingApproval: false,
    isRecovering: false,
  }),
}));
jest.mock("@/providers/database-provider", () => ({
  DatabaseProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@/components/offline-banner", () => ({ OfflineBanner: () => null }));
jest.mock("@/components/toast", () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@/lib/oauth", () => ({ configureGoogleSignIn: jest.fn() }));
jest.mock("@/lib/performance", () => ({
  markStartupBegin: jest.fn(),
  markStartupEnd: jest.fn(),
}));

import RootLayout from "../../app/_layout";

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
