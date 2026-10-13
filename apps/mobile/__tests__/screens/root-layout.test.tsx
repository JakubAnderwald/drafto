import React from "react";
import { Platform } from "react-native";

import { render } from "../helpers/test-utils";

// The header options registered for each route in app/_layout.tsx.

type ScreenOptions =
  | Record<string, unknown>
  | ((props: { route: { name: string; params?: object } }) => Record<string, unknown>);
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
import { noteFromSearchHref } from "@/lib/note-from-search";

/** A screen's options, resolved for a route with these params if they are a function. */
function optionsFor(name: string, params?: object): Record<string, unknown> | undefined {
  const options = mockScreens.find((screen) => screen.name === name)?.options;
  return typeof options === "function" ? options({ route: { name, params } }) : options;
}

/** The params expo-router gives a note opened through `noteFromSearchHref`. */
function paramsOf(href: string): Record<string, string> {
  const [path, query] = href.split("?");
  return { id: path.split("/").pop() ?? "", ...Object.fromEntries(new URLSearchParams(query)) };
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
    expect(optionsFor("notes/[id]", { id: "n1" })).toEqual(expect.objectContaining({ title: "" }));
  });

  it("keeps the editor's back label 'Notes', not the notebook's name", () => {
    expect(optionsFor("notes/[id]", { id: "n1" })).toEqual(
      expect.objectContaining({ headerBackTitle: "Notes" }),
    );
  });

  it("leaves the notebook screen's title to the screen, which shows the notebook's name", () => {
    expect(optionsFor("notebooks/[id]")).toEqual(expect.objectContaining({ title: "" }));
  });

  it("gives the search sheet a close button on iOS", () => {
    const options = optionsFor("search");

    expect(options).toEqual(expect.objectContaining({ title: "Search", presentation: "modal" }));
    expect(headerLeftOf(options)?.getByTestId("search-close")).toBeTruthy();
  });

  it("gives a note opened from Search a close button on iOS, where it is a sheet of its own", () => {
    const options = optionsFor("notes/[id]", paramsOf(noteFromSearchHref("n1")));

    expect(headerLeftOf(options)?.getByLabelText("Close")).toBeTruthy();
    expect(options).toEqual(expect.objectContaining({ title: "", headerBackTitle: "Notes" }));
  });

  it("keeps the back button on a note opened from a notebook", () => {
    expect(optionsFor("notes/[id]", { id: "n1" })?.headerLeft).toBeUndefined();
  });

  it("adds no close buttons on Android, where these screens have a back arrow", () => {
    jest.replaceProperty(Platform, "OS", "android");

    expect(optionsFor("search")?.headerLeft).toBeUndefined();
    expect(
      optionsFor("notes/[id]", paramsOf(noteFromSearchHref("n1")))?.headerLeft,
    ).toBeUndefined();
  });
});
