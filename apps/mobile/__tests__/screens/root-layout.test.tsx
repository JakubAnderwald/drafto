import React from "react";

import { render } from "../helpers/test-utils";

// The static header options registered for each route in app/_layout.tsx.

type ScreenProps = { name: string; options?: Record<string, unknown> };

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

function optionsFor(name: string): Record<string, unknown> | undefined {
  return mockScreens.find((screen) => screen.name === name)?.options;
}

describe("RootLayout screen options", () => {
  beforeEach(() => {
    mockScreens.length = 0;
    render(<RootLayout />);
  });

  it("gives the editor no header title, so 'Editor' never shows while a note loads", () => {
    expect(optionsFor("notes/[id]")).toEqual(expect.objectContaining({ title: "" }));
  });

  it("keeps the editor's back label 'Notes', not the notebook's name", () => {
    expect(optionsFor("notes/[id]")).toEqual(expect.objectContaining({ headerBackTitle: "Notes" }));
  });

  it("leaves the notebook screen's title to the screen, which shows the notebook's name", () => {
    expect(optionsFor("notebooks/[id]")).toEqual(expect.objectContaining({ title: "" }));
  });
});
