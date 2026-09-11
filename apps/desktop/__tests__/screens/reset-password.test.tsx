import React from "react";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import { ResetPasswordScreen } from "../../src/screens/reset-password";

const mockUpdateUser = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      updateUser: (...args: unknown[]) => mockUpdateUser(...args),
    },
  },
}));

const mockUseNetworkStatus = jest.fn();
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => mockUseNetworkStatus(),
}));

const mockUseAuth = jest.fn();
jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => mockUseAuth(),
}));

const mockEndRecovery = jest.fn();
const mockSignOut = jest.fn();

const RECOVERY_SESSION = { user: { id: "user-123" } };

function authState(overrides: Record<string, unknown> = {}) {
  return {
    session: RECOVERY_SESSION,
    isRecovering: true,
    recoveryError: null,
    endRecovery: mockEndRecovery,
    signOut: mockSignOut,
    ...overrides,
  };
}

describe("ResetPasswordScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateUser.mockResolvedValue({ error: null });
    mockSignOut.mockResolvedValue(undefined);
    mockUseNetworkStatus.mockReturnValue({ isConnected: true, isInternetReachable: true });
    mockUseAuth.mockReturnValue(authState());
  });

  it("renders both password fields for a recovery session", () => {
    const { getByText, getByTestId } = render(<ResetPasswordScreen />);

    expect(getByText("Reset Password")).toBeTruthy();
    expect(getByTestId("new-password-input")).toBeTruthy();
    expect(getByTestId("confirm-password-input")).toBeTruthy();
  });

  it("rejects mismatched passwords before calling Supabase", () => {
    const { getByText, getByTestId } = render(<ResetPasswordScreen />);

    fireEvent.changeText(getByTestId("new-password-input"), "newpassword123");
    fireEvent.changeText(getByTestId("confirm-password-input"), "different123");
    fireEvent.press(getByTestId("reset-password-submit"));

    expect(getByText("Passwords do not match.")).toBeTruthy();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("enforces the same 6-character minimum as web", () => {
    const { getByText, getByTestId } = render(<ResetPasswordScreen />);

    fireEvent.changeText(getByTestId("new-password-input"), "short");
    fireEvent.changeText(getByTestId("confirm-password-input"), "short");
    fireEvent.press(getByTestId("reset-password-submit"));

    expect(getByText("Password must be at least 6 characters.")).toBeTruthy();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("updates the password and leaves recovery mode on success", async () => {
    const { getByTestId } = render(<ResetPasswordScreen />);

    fireEvent.changeText(getByTestId("new-password-input"), "newpassword123");
    fireEvent.changeText(getByTestId("confirm-password-input"), "newpassword123");
    fireEvent.press(getByTestId("reset-password-submit"));

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledWith({ password: "newpassword123" });
    });
    // The session is kept — RootNavigator takes the user onward, matching web.
    expect(mockEndRecovery).toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("keeps the user on the screen when Supabase rejects the new password", async () => {
    mockUpdateUser.mockResolvedValue({ error: { message: "New password should be different" } });

    const { getByText, getByTestId } = render(<ResetPasswordScreen />);

    fireEvent.changeText(getByTestId("new-password-input"), "newpassword123");
    fireEvent.changeText(getByTestId("confirm-password-input"), "newpassword123");
    fireEvent.press(getByTestId("reset-password-submit"));

    await waitFor(() => {
      expect(getByText("New password should be different")).toBeTruthy();
    });
    expect(mockEndRecovery).not.toHaveBeenCalled();
  });

  it("offers a retry rather than a hard failure when offline", async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false, isInternetReachable: false });

    const { getByText, getByTestId } = render(<ResetPasswordScreen />);

    fireEvent.changeText(getByTestId("new-password-input"), "newpassword123");
    fireEvent.changeText(getByTestId("confirm-password-input"), "newpassword123");
    fireEvent.press(getByTestId("reset-password-submit"));

    await waitFor(() => {
      expect(getByText("Try again")).toBeTruthy();
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("shows the friendly message for an invalid or expired link", () => {
    mockUseAuth.mockReturnValue(
      authState({ session: null, recoveryError: "Email link is invalid or has expired" }),
    );

    const { getByText, queryByTestId } = render(<ResetPasswordScreen />);

    expect(getByText("Reset Link Problem")).toBeTruthy();
    expect(getByText("Email link is invalid or has expired")).toBeTruthy();
    expect(queryByTestId("new-password-input")).toBeNull();
  });

  it("sends a signed-out visitor back to login after a failed link", () => {
    mockUseAuth.mockReturnValue(
      authState({ session: null, recoveryError: "Email link is invalid or has expired" }),
    );
    const onNavigateToLogin = jest.fn();

    const { getByText, getByTestId } = render(
      <ResetPasswordScreen onNavigateToLogin={onNavigateToLogin} />,
    );

    expect(getByText("Back to login")).toBeTruthy();
    fireEvent.press(getByTestId("reset-password-dismiss"));

    expect(mockEndRecovery).toHaveBeenCalled();
    expect(onNavigateToLogin).toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("does not sign out an already-logged-in user who opened a stale link", () => {
    // The failed link never replaced the session, so there is nothing orphaned
    // to clean up — dismissing must leave the working session intact.
    mockUseAuth.mockReturnValue(
      authState({ recoveryError: "Email link is invalid or has expired" }),
    );
    const onNavigateToLogin = jest.fn();

    const { getByText, getByTestId } = render(
      <ResetPasswordScreen onNavigateToLogin={onNavigateToLogin} />,
    );

    expect(getByText("Continue")).toBeTruthy();
    fireEvent.press(getByTestId("reset-password-dismiss"));

    expect(mockEndRecovery).toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(onNavigateToLogin).not.toHaveBeenCalled();
  });

  it("waits while the recovery session is still being established", () => {
    mockUseAuth.mockReturnValue(authState({ session: null }));

    const { getByText, queryByTestId } = render(<ResetPasswordScreen />);

    expect(getByText("Verifying your reset link…")).toBeTruthy();
    expect(queryByTestId("new-password-input")).toBeNull();
  });

  it("signs out when backing out, so no orphaned recovery session is left behind", async () => {
    const onNavigateToLogin = jest.fn();
    const { getByTestId } = render(<ResetPasswordScreen onNavigateToLogin={onNavigateToLogin} />);

    fireEvent.press(getByTestId("reset-password-cancel"));

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalled();
    });
    expect(mockEndRecovery).toHaveBeenCalled();
    expect(onNavigateToLogin).toHaveBeenCalled();
  });
});
