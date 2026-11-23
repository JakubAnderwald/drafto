import React from "react";
import { AccessibilityInfo } from "react-native";
import { AUTH_RATE_LIMITED_MESSAGE, INVALID_EMAIL_MESSAGE } from "@drafto/shared";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import { ForgotPasswordScreen } from "@/screens/forgot-password";

const OFFLINE_MESSAGE = "You're offline. Reconnect to the internet and try again.";

const mockResetPasswordForEmail = jest.fn();
let mockCryptoReady: Promise<void> = Promise.resolve();
jest.mock("@/lib/supabase", () => ({
  get cryptoReady() {
    return mockCryptoReady;
  },
  supabase: {
    auth: {
      resetPasswordForEmail: (...args: unknown[]) => mockResetPasswordForEmail(...args),
    },
  },
}));

jest.mock("@/lib/config", () => ({
  apiUrl: "https://api.drafto.test",
}));

const mockUseNetworkStatus = jest.fn();
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => mockUseNetworkStatus(),
}));

describe("ForgotPasswordScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCryptoReady = Promise.resolve();
    mockResetPasswordForEmail.mockResolvedValue({ error: null });
    mockUseNetworkStatus.mockReturnValue({ isConnected: true, isInternetReachable: true });
  });

  it("renders the request form", () => {
    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    expect(getByText("Forgot Password")).toBeTruthy();
    expect(getByTestId("forgot-password-email-input")).toBeTruthy();
    expect(getByText("Send reset link")).toBeTruthy();
  });

  it("warns that the link only works on this Mac, because PKCE is same-device", () => {
    const { getByText } = render(<ForgotPasswordScreen />);

    expect(getByText("Open the link on this Mac — it won't work on another device.")).toBeTruthy();
  });

  it("requires an email address before calling Supabase", () => {
    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    fireEvent.press(getByText("Send reset link"));

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

  it("sends the reset link to the drafto.eu recovery hand-off page and confirms", async () => {
    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "  test@example.com  ");
    fireEvent.press(getByText("Send reset link"));

    await waitFor(() => {
      expect(mockResetPasswordForEmail).toHaveBeenCalledWith("test@example.com", {
        redirectTo: "https://api.drafto.test/auth/desktop/recovery",
      });
    });

    await waitFor(() => {
      expect(getByText("Check Your Email")).toBeTruthy();
    });
    expect(getByText("test@example.com")).toBeTruthy();
  });

  it("waits for the PKCE crypto before requesting the link, so its challenge is S256", async () => {
    let settle = () => {};
    mockCryptoReady = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "test@example.com");
    fireEvent.press(getByText("Send reset link"));
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();

    settle();
    await waitFor(() => {
      expect(getByText("Check Your Email")).toBeTruthy();
    });
    expect(mockResetPasswordForEmail).toHaveBeenCalledTimes(1);
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
  });

  it("calls onNavigateToLogin from the back link", () => {
    const onNavigateToLogin = jest.fn();
    const { getByText } = render(<ForgotPasswordScreen onNavigateToLogin={onNavigateToLogin} />);

    fireEvent.press(getByText("Back to login"));

    expect(onNavigateToLogin).toHaveBeenCalled();
  });
});

describe("ForgotPasswordScreen — VoiceOver announcements (PrimeTestLab 11035 review)", () => {
  let announce: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    announce = jest
      .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    announce.mockRestore();
  });

  /** How many times VoiceOver was asked to speak `message`. */
  const announced = (message: string) =>
    announce.mock.calls.filter(([spoken]) => spoken === message).length;

  it("PrimeTestLab 11035 review: announces the offline banner again on each retry", async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false, isInternetReachable: false });
    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "test@example.com");
    fireEvent.press(getByText("Send reset link"));
    await waitFor(() => {
      expect(announced(OFFLINE_MESSAGE)).toBe(1);
    });

    fireEvent.press(getByText("Try again"));
    await waitFor(() => {
      expect(announced(OFFLINE_MESSAGE)).toBe(2);
    });
    expect(getByTestId("forgot-password-error")).toHaveTextContent(OFFLINE_MESSAGE);
  });

  it("PrimeTestLab 11035 review: announces an unchanged email error again on each submit", () => {
    const { getByText } = render(<ForgotPasswordScreen />);

    fireEvent.press(getByText("Send reset link"));
    fireEvent.press(getByText("Send reset link"));

    expect(announced("Please enter your email address.")).toBe(2);
  });

  it("PrimeTestLab 11035 review: clears a server-sent field error when the retry starts, not when it ends", async () => {
    mockCryptoReady = Promise.resolve();
    mockUseNetworkStatus.mockReturnValue({ isConnected: true, isInternetReachable: true });
    let finishRetry: (result: { error: { message: string } }) => void = () => {};
    mockResetPasswordForEmail
      .mockResolvedValueOnce({
        error: { message: "Unable to validate email address: invalid format" },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRetry = resolve;
          }),
      );
    const { getByText, getByTestId, queryByTestId } = render(<ForgotPasswordScreen />);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "name@example.com");
    fireEvent.press(getByText("Send reset link"));
    await waitFor(() => {
      expect(announced(INVALID_EMAIL_MESSAGE)).toBe(1);
    });

    // The retry is in flight: the old field error is gone and is not spoken again.
    fireEvent.press(getByText("Send reset link"));
    await waitFor(() => {
      expect(mockResetPasswordForEmail).toHaveBeenCalledTimes(2);
    });
    expect(queryByTestId("forgot-password-email-input-error")).toBeNull();
    expect(announced(INVALID_EMAIL_MESSAGE)).toBe(1);

    // The retry ends differently: only the banner is spoken and shown.
    await act(async () => {
      finishRetry({ error: { message: "Rate limit exceeded" } });
    });
    expect(getByTestId("forgot-password-error")).toHaveTextContent(AUTH_RATE_LIMITED_MESSAGE);
    expect(announced(AUTH_RATE_LIMITED_MESSAGE)).toBe(1);
    expect(queryByTestId("forgot-password-email-input-error")).toBeNull();
    expect(announced(INVALID_EMAIL_MESSAGE)).toBe(1);
  });

  it("PrimeTestLab 11035 review: speaks a repeated server field error when the retry fails, once", async () => {
    mockCryptoReady = Promise.resolve();
    mockUseNetworkStatus.mockReturnValue({ isConnected: true, isInternetReachable: true });
    let finishRetry: (result: { error: { message: string } }) => void = () => {};
    const formatError = { error: { message: "Unable to validate email address: invalid format" } };
    mockResetPasswordForEmail.mockResolvedValueOnce(formatError).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRetry = resolve;
        }),
    );
    const { getByText, getByTestId } = render(<ForgotPasswordScreen />);

    fireEvent.changeText(getByTestId("forgot-password-email-input"), "name@example.com");
    fireEvent.press(getByText("Send reset link"));
    await waitFor(() => {
      expect(announced(INVALID_EMAIL_MESSAGE)).toBe(1);
    });

    fireEvent.press(getByText("Send reset link"));
    await waitFor(() => {
      expect(mockResetPasswordForEmail).toHaveBeenCalledTimes(2);
    });
    expect(announced(INVALID_EMAIL_MESSAGE)).toBe(1);

    await act(async () => {
      finishRetry(formatError);
    });
    expect(getByTestId("forgot-password-email-input-error")).toHaveTextContent(
      INVALID_EMAIL_MESSAGE,
    );
    expect(announced(INVALID_EMAIL_MESSAGE)).toBe(2);
  });
});
