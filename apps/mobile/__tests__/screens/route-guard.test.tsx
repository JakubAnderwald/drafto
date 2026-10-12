import React from "react";
import { Text } from "react-native";

import { render } from "../helpers/test-utils";

const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
const mockUseSegments = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({
    replace: mockReplace,
    dismissTo: mockDismissTo,
    push: jest.fn(),
    back: jest.fn(),
  }),
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

  it("sends an unauthenticated visitor on a protected screen back to login", () => {
    mockUseSegments.mockReturnValue(["(tabs)"]);

    renderGuard();

    // dismissTo, not replace: replacing the waiting screen above a login already in the
    // stack left [login, login] and a "‹ Log In" back button (App Review recording, 0:38).
    expect(mockDismissTo).toHaveBeenCalledWith("/(auth)/login");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("pops a signed-out user off the waiting screen back to login", () => {
    mockUseSegments.mockReturnValue(["(auth)", "waiting-for-approval"]);

    renderGuard();

    expect(mockDismissTo).toHaveBeenCalledWith("/(auth)/login");
  });

  it.each([["login"], ["signup"], ["forgot-password"], ["reset-password"]])(
    "leaves an unauthenticated visitor on the public %s screen",
    (screen) => {
      mockUseSegments.mockReturnValue(["(auth)", screen]);

      renderGuard();

      expect(mockReplace).not.toHaveBeenCalled();
      expect(mockDismissTo).not.toHaveBeenCalled();
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

  it("shows a themed spinner only while auth state is loading", () => {
    mockUseAuth.mockReturnValue(authState({ isLoading: true }));

    const { getByTestId } = renderGuard();

    expect(getByTestId("route-guard-loading")).toBeTruthy();
  });

  it("keeps its children mounted while an approval check is in flight", () => {
    // "Check approval status" on the waiting screen used to swap the whole stack for a blank
    // spinner page (App Review recording, 1:12), unmounting the screen and its result message.
    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: false, isCheckingApproval: true }),
    );
    mockUseSegments.mockReturnValue(["(auth)", "waiting-for-approval"]);

    const { getByText, queryByTestId } = renderGuard();

    expect(getByText("APP")).toBeTruthy();
    expect(queryByTestId("route-guard-loading")).toBeNull();
  });

  it("holds routing while an approval check is in flight", () => {
    // On sign-in the login screen stays put during the check, so an approved user never sees
    // the waiting screen flash on the way to the app.
    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: false, isCheckingApproval: true }),
    );
    mockUseSegments.mockReturnValue(["(auth)", "login"]);

    renderGuard();

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockDismissTo).not.toHaveBeenCalled();
  });

  it("routes once the approval check settles", () => {
    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: false, isCheckingApproval: true }),
    );
    mockUseSegments.mockReturnValue(["(auth)", "login"]);

    const { rerender } = renderGuard();
    expect(mockReplace).not.toHaveBeenCalled();

    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: true }));
    rerender(
      <RouteGuard>
        <Text>APP</Text>
      </RouteGuard>,
    );

    expect(mockReplace).toHaveBeenCalledWith("/(tabs)");
  });

  it("never holds a signed-out user in the app behind a check still in flight", () => {
    mockUseAuth.mockReturnValue(authState({ user: null, isCheckingApproval: true }));
    mockUseSegments.mockReturnValue(["(tabs)"]);

    renderGuard();

    expect(mockDismissTo).toHaveBeenCalledWith("/(auth)/login");
  });

  it("sends a recovering user to the reset screen without waiting for the approval check", () => {
    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isRecovering: true, isCheckingApproval: true }),
    );
    mockUseSegments.mockReturnValue(["(tabs)"]);

    renderGuard();

    expect(mockReplace).toHaveBeenCalledWith("/(auth)/reset-password");
  });

  it("renders its children once the gate is settled", () => {
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: true }));
    mockUseSegments.mockReturnValue(["(tabs)"]);

    const { getByText } = renderGuard();

    expect(getByText("APP")).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
