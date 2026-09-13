import React from "react";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import ForgotPasswordScreen from "../../app/(auth)/forgot-password";

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
    const { getByText } = render(<ForgotPasswordScreen />);

    fireEvent.press(getByText("Send reset link"));

    expect(getByText("Please enter your email address.")).toBeTruthy();
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
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
      expect(getByText("Rate limit exceeded")).toBeTruthy();
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
});
