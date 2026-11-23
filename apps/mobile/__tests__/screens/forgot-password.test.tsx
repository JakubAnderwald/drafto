import React from "react";
import { KeyboardAvoidingView } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import { AUTH_RATE_LIMITED_MESSAGE, INVALID_EMAIL_MESSAGE } from "@drafto/shared";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import ForgotPasswordScreen from "../../app/(auth)/forgot-password";
import { OfflineBannerHeightContext } from "@/hooks/use-offline-banner-height";

const mockResetPasswordForEmail = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: (...args: unknown[]) => mockResetPasswordForEmail(...args),
    },
  },
}));

const mockUseNetworkStatus = jest.fn();
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => mockUseNetworkStatus(),
}));

describe("ForgotPasswordScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResetPasswordForEmail.mockResolvedValue({ error: null });
    mockUseNetworkStatus.mockReturnValue({ isConnected: true, isInternetReachable: true });
  });

  it("renders the request form", () => {
    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    expect(getByText("Forgot Password")).toBeTruthy();
    expect(getByTestId("forgot-password-email-input")).toBeTruthy();
    expect(getByText("Send reset link")).toBeTruthy();
    expect(getByText("Back to login")).toBeTruthy();
  });

  it("requires an email address before calling Supabase", () => {
    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    fireEvent.press(getByText("Send reset link"));

    // Flow 06 asserts this exact text.
    expect(getByTestId("forgot-password-email-input-error")).toHaveTextContent(
      "Please enter your email address.",
    );
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("PrimeTestLab 11035 M-02: refuses a malformed email under the field, before going online", () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false, isInternetReachable: false });
    const { getByText, getByTestId, queryByTestId } = render(<ForgotPasswordScreen />);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "planner.com");
    fireEvent.press(getByText("Send reset link"));

    expect(getByTestId("forgot-password-email-input-error")).toHaveTextContent(
      INVALID_EMAIL_MESSAGE,
    );
    expect(queryByTestId("forgot-password-error")).toBeNull();
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "planner@example.com");
    expect(queryByTestId("forgot-password-email-input-error")).toBeNull();
  });

  it("PrimeTestLab 11035 M-02: puts Supabase's format error under the field", async () => {
    mockResetPasswordForEmail.mockResolvedValue({
      error: { message: "Unable to validate email address: invalid format" },
    });
    const { getByText, getByTestId, queryByText } = render(<ForgotPasswordScreen />);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "name@example.com");
    fireEvent.press(getByText("Send reset link"));

    await waitFor(() => {
      expect(getByTestId("forgot-password-email-input-error")).toHaveTextContent(
        INVALID_EMAIL_MESSAGE,
      );
    });
    expect(queryByText(/Unable to validate/)).toBeNull();
  });

  it("sends the reset link to the deep-link redirect and confirms", async () => {
    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "  test@example.com  ");
    fireEvent.press(getByText("Send reset link"));

    await waitFor(() => {
      expect(mockResetPasswordForEmail).toHaveBeenCalledWith("test@example.com", {
        redirectTo: "drafto://reset-password",
      });
    });

    await waitFor(() => {
      expect(getByText("Check Your Email")).toBeTruthy();
    });
    expect(getByText("test@example.com")).toBeTruthy();
    expect(getByText("Back to login")).toBeTruthy();
  });

  it("surfaces a Supabase error instead of confirming", async () => {
    mockResetPasswordForEmail.mockResolvedValue({ error: { message: "Rate limit exceeded" } });

    const { getByText, getByTestId, queryByText } = render(<ForgotPasswordScreen />);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "test@example.com");
    fireEvent.press(getByText("Send reset link"));

    await waitFor(() => {
      expect(getByText(AUTH_RATE_LIMITED_MESSAGE)).toBeTruthy();
    });
    expect(queryByText("Check Your Email")).toBeNull();
  });

  it("offers a retry rather than a hard failure when offline", async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false, isInternetReachable: false });

    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "test@example.com");
    fireEvent.press(getByText("Send reset link"));

    await waitFor(() => {
      expect(getByText("You're offline. Reconnect to the internet and try again.")).toBeTruthy();
    });
    expect(getByText("Try again")).toBeTruthy();
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("turns a thrown transport failure into a retry", async () => {
    mockResetPasswordForEmail.mockRejectedValue(new Error("Network request failed"));

    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "test@example.com");
    fireEvent.press(getByText("Send reset link"));

    await waitFor(() => {
      expect(getByText("Try again")).toBeTruthy();
    });
    expect(getByText("You're offline. Reconnect to the internet and try again.")).toBeTruthy();
  });

  it("dismisses back to the login screen below instead of pushing another one", async () => {
    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    // On the form...
    expect(getByText("Back to login").props.dismissTo).toBe(true);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "test@example.com");
    fireEvent.press(getByText("Send reset link"));

    // ...and on the confirmation.
    await waitFor(() => {
      expect(getByText("Check Your Email")).toBeTruthy();
    });
    expect(getByText("Back to login").props.dismissTo).toBe(true);
  });

  it("offsets its keyboard avoidance by the header above it and, offline, the banner below that", () => {
    // The jest.setup.js mock; the header that keeps the Back button.
    jest.mocked(useHeaderHeight).mockReturnValue(91);
    try {
      const online = render(<ForgotPasswordScreen />);
      expect(online.UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(91);
      online.unmount();

      const { UNSAFE_getByType } = render(
        <OfflineBannerHeightContext.Provider value={28}>
          <ForgotPasswordScreen />
        </OfflineBannerHeightContext.Provider>,
      );

      expect(UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(91 + 28);
    } finally {
      jest.mocked(useHeaderHeight).mockReturnValue(0);
    }
  });
});
