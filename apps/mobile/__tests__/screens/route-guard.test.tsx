import React from "react";
import { Text } from "react-native";

import { render } from "../helpers/test-utils";

const mockReplace = jest.fn();
const mockUseSegments = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
  useSegments: () => mockUseSegments(),
  Stack: Object.assign(() => null, { Screen: () => null }),
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

const mockUseAuth = jest.fn();
jest.mock("@/providers/auth-provider", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mockUseAuth(),
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

import { RouteGuard } from "../../app/_layout";

const APPROVED_USER = { id: "user-123" };

function authState(overrides: Record<string, unknown> = {}) {
  return {
    user: null,
    isApproved: false,
    isLoading: false,
    isCheckingApproval: false,
    isRecovering: false,
    ...overrides,
  };
}

function renderGuard() {
  return render(
    <RouteGuard>
      <Text>APP</Text>
    </RouteGuard>,
  );
}

describe("RouteGuard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue(authState());
    mockUseSegments.mockReturnValue(["(auth)", "login"]);
  });

  it("holds still while auth state is loading", () => {
    mockUseAuth.mockReturnValue(authState({ isLoading: true }));

    const { queryByText } = renderGuard();

    expect(mockReplace).not.toHaveBeenCalled();
    expect(queryByText("APP")).toBeNull();
  });

  it("sends an unauthenticated visitor on a protected screen to login", () => {
    mockUseSegments.mockReturnValue(["(tabs)"]);

    renderGuard();

    expect(mockReplace).toHaveBeenCalledWith("/(auth)/login");
  });

  it.each([["login"], ["signup"], ["forgot-password"], ["reset-password"]])(
    "leaves an unauthenticated visitor on the public %s screen",
    (screen) => {
      mockUseSegments.mockReturnValue(["(auth)", screen]);

      renderGuard();

      expect(mockReplace).not.toHaveBeenCalled();
    },
  );

  it("redirects an approved user out of the auth group", () => {
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: true }));

    renderGuard();

    expect(mockReplace).toHaveBeenCalledWith("/(tabs)");
  });

  it("sends an unapproved user to the waiting screen", () => {
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: false }));

    renderGuard();

    expect(mockReplace).toHaveBeenCalledWith("/(auth)/waiting-for-approval");
  });

  it("pulls a recovering user out of the app and onto the reset screen", () => {
    // The regression this branch exists to prevent: a recovery link produces a
    // real, approved session, so without the check the user is redirected into
    // the tabs and the reset screen is unreachable.
    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: true, isRecovering: true }),
    );
    mockUseSegments.mockReturnValue(["(tabs)"]);

    renderGuard();

    expect(mockReplace).toHaveBeenCalledWith("/(auth)/reset-password");
  });

  it("prefers the reset screen over the approval gate while recovering", () => {
    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: false, isRecovering: true }),
    );
    mockUseSegments.mockReturnValue(["(auth)", "login"]);

    renderGuard();

    expect(mockReplace).toHaveBeenCalledWith("/(auth)/reset-password");
    expect(mockReplace).not.toHaveBeenCalledWith("/(auth)/waiting-for-approval");
  });

  it("does not re-navigate when the recovering user is already on the reset screen", () => {
    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: true, isRecovering: true }),
    );
    mockUseSegments.mockReturnValue(["(auth)", "reset-password"]);

    renderGuard();

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("renders its children once the gate is settled", () => {
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: true }));
    mockUseSegments.mockReturnValue(["(tabs)"]);

    const { getByText } = renderGuard();

    expect(getByText("APP")).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
