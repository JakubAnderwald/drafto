import React from "react";
import { Alert, KeyboardAvoidingView, StyleSheet, AccessibilityInfo, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import LoginScreen from "../../app/(auth)/login";
import { OfflineBannerHeightContext } from "@/hooks/use-offline-banner-height";
import {
  ACCOUNT_DELETED_MESSAGE,
  EMAIL_REQUIRED_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  INVALID_EMAIL_MESSAGE,
  PASSWORD_REQUIRED_MESSAGE,
} from "@drafto/shared";
import {
  clearAuthCallbackError,
  getAuthCallbackError,
  reportAuthCallbackError,
} from "@/lib/auth-callback-errors";
import {
  clearAccountDeletedNotice,
  isAccountDeletedNoticeShown,
  reportAccountDeleted,
} from "@/lib/account-deleted-notice";

// Mock supabase
const mockSignInWithPassword = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
    },
  },
}));

describe("LoginScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the login form", () => {
    const { getByText, getByPlaceholderText } = render(<LoginScreen />);

    expect(getByText("Log In")).toBeTruthy();
    expect(getByText("Sign in to your Drafto account")).toBeTruthy();
    expect(getByPlaceholderText("you@example.com")).toBeTruthy();
    expect(getByPlaceholderText("Your password")).toBeTruthy();
    expect(getByText("Log in")).toBeTruthy();
  });

  it("shows validation error when fields are empty", () => {
    const { getByText, getByTestId } = render(<LoginScreen />);

    fireEvent.press(getByText("Log in"));

    expect(getByTestId("email-input-error")).toHaveTextContent(EMAIL_REQUIRED_MESSAGE);
    expect(getByTestId("password-input-error")).toHaveTextContent(PASSWORD_REQUIRED_MESSAGE);
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it("PrimeTestLab 11035 M-02: refuses a malformed email without calling Supabase, under the field", () => {
    const { getByText, getByPlaceholderText, getByTestId, queryByTestId } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "planner.com");
    fireEvent.changeText(getByPlaceholderText("Your password"), "abc");
    fireEvent.press(getByText("Log in"));

    expect(mockSignInWithPassword).not.toHaveBeenCalled();
    expect(getByTestId("email-input-error")).toHaveTextContent(INVALID_EMAIL_MESSAGE);
    // Log-in never checks a password's length: older accounts may have shorter ones.
    expect(queryByTestId("password-input-error")).toBeNull();
    expect(queryByTestId("login-error")).toBeNull();

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "planner@example.com");
    expect(queryByTestId("email-input-error")).toBeNull();
  });

  it("PrimeTestLab 11035 M-02: puts Supabase's format error under the email field", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Unable to validate email address: invalid format" },
    });

    const { getByText, getByPlaceholderText, getByTestId, queryByText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "name@example.com");
    fireEvent.changeText(getByPlaceholderText("Your password"), "password123");
    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(getByTestId("email-input-error")).toHaveTextContent(INVALID_EMAIL_MESSAGE);
    });
    expect(queryByText(/Unable to validate/)).toBeNull();
  });

  it("calls signInWithPassword with email and password", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });

    const { getByText, getByPlaceholderText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "test@example.com");
    fireEvent.changeText(getByPlaceholderText("Your password"), "password123");
    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "password123",
      });
    });
  });

  it("displays error message from Supabase on failed login", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });

    const { getByText, getByPlaceholderText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "wrong@example.com");
    fireEvent.changeText(getByPlaceholderText("Your password"), "wrongpass");
    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(getByText(INVALID_CREDENTIALS_MESSAGE)).toBeTruthy();
    });
  });

  describe("Apple callback errors held outside the screen", () => {
    afterEach(() => clearAuthCallbackError());

    it("shows one reported before the screen mounted", () => {
      reportAuthCallbackError("Apple Sign-In failed. Please try again.");

      const { getByText } = render(<LoginScreen />);

      expect(getByText("Apple Sign-In failed. Please try again.")).toBeTruthy();
    });

    it("still shows it after the screen is mounted a second time", () => {
      // A cold start can mount, unmount and remount login while the router settles.
      reportAuthCallbackError("Apple Sign-In failed. Please try again.");
      render(<LoginScreen />).unmount();

      const { getByText } = render(<LoginScreen />);

      expect(getByText("Apple Sign-In failed. Please try again.")).toBeTruthy();
    });

    it("shows one reported while the screen is open", () => {
      const { getByText } = render(<LoginScreen />);

      act(() => reportAuthCallbackError("Apple Sign-In failed. Please try again."));

      expect(getByText("Apple Sign-In failed. Please try again.")).toBeTruthy();
    });

    it("drops it when the user starts a new sign-in", () => {
      reportAuthCallbackError("Apple Sign-In failed. Please try again.");
      const { getByText, queryByText } = render(<LoginScreen />);

      fireEvent.press(getByText("Log in"));

      expect(queryByText("Apple Sign-In failed. Please try again.")).toBeNull();
      expect(getAuthCallbackError()).toBeNull();
    });
  });

  describe("account-deleted confirmation", () => {
    afterEach(() => clearAccountDeletedNotice());

    it("is not shown by default", () => {
      const { queryByTestId, queryByText } = render(<LoginScreen />);

      expect(queryByTestId("account-deleted-notice")).toBeNull();
      expect(queryByText(ACCOUNT_DELETED_MESSAGE)).toBeNull();
    });

    it("confirms a deletion that finished before the screen mounted", () => {
      // The App Review recording (3:27): deleting the account dropped the user on login with
      // no sign that anything had happened.
      reportAccountDeleted();

      const { getByTestId, getByText } = render(<LoginScreen />);

      expect(getByTestId("account-deleted-notice")).toBeTruthy();
      expect(getByText(ACCOUNT_DELETED_MESSAGE)).toBeTruthy();
    });

    it("survives the screen being mounted a second time", () => {
      reportAccountDeleted();
      render(<LoginScreen />).unmount();

      const { getByText } = render(<LoginScreen />);

      expect(getByText(ACCOUNT_DELETED_MESSAGE)).toBeTruthy();
    });

    it("goes away when the user starts a new sign-in", () => {
      reportAccountDeleted();
      const { getByText, queryByText } = render(<LoginScreen />);

      fireEvent.press(getByText("Log in"));

      expect(queryByText(ACCOUNT_DELETED_MESSAGE)).toBeNull();
      expect(isAccountDeletedNoticeShown()).toBe(false);
    });
  });

  it("offsets its keyboard avoidance by the offline banner above it", () => {
    const online = render(<LoginScreen />);
    expect(online.UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(0);
    online.unmount();

    const { UNSAFE_getByType } = render(
      <OfflineBannerHeightContext.Provider value={52}>
        <LoginScreen />
      </OfflineBannerHeightContext.Provider>,
    );

    expect(UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(52);
  });

  it("keeps its content below the status bar, having no header of its own", () => {
    const insets = useSafeAreaInsets as jest.Mock;
    insets.mockReturnValue({ top: 47, bottom: 34, left: 0, right: 0 });
    try {
      const { getByTestId } = render(<LoginScreen />);

      expect(StyleSheet.flatten(getByTestId("login-screen").props.style)).toEqual(
        expect.objectContaining({ paddingTop: 47 }),
      );
    } finally {
      insets.mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0 });
    }
  });

  it("shows sign up link", () => {
    const { getByText } = render(<LoginScreen />);

    expect(getByText("Sign up")).toBeTruthy();
  });

  it("offers a route into the forgot-password flow", () => {
    const { getByTestId, getByText } = render(<LoginScreen />);

    expect(getByText("Forgot your password?")).toBeTruthy();
    expect(getByTestId("forgot-password-link").props.href).toBe("/(auth)/forgot-password");
  });

  it("trims email whitespace before submitting", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });

    const { getByText, getByPlaceholderText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "  test@example.com  ");
    fireEvent.changeText(getByPlaceholderText("Your password"), "password123");
    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "password123",
      });
    });
  });

  it("lets the user show and hide the password", () => {
    const { getByTestId } = render(<LoginScreen />);

    const field = () => getByTestId("password-input");
    expect(field().props.secureTextEntry).toBe(true);
    expect(field().props.autoComplete).toBe("password");

    fireEvent.press(getByTestId("password-input-toggle"));
    expect(field().props.secureTextEntry).toBe(false);
    expect(getByTestId("password-input-toggle").props.accessibilityLabel).toBe("Hide password");

    fireEvent.press(getByTestId("password-input-toggle"));
    expect(field().props.secureTextEntry).toBe(true);
  });
});

describe("LoginScreen — VoiceOver announcements (PrimeTestLab 11035 review)", () => {
  const originalOS = Platform.OS;
  let announce: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    announce = jest
      .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    announce.mockRestore();
    Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
  });

  /** How many times VoiceOver was asked to speak `message`. */
  const announced = (message: string) =>
    announce.mock.calls.filter(([spoken]) => spoken === message).length;

  it("PrimeTestLab 11035 review: announces the error banner, and again when a resubmit fails the same way", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    const { getByText, getByTestId } = render(<LoginScreen />);

    fireEvent.changeText(getByTestId("email-input"), "test@example.com");
    fireEvent.changeText(getByTestId("password-input"), "wrongpassword");
    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(getByTestId("login-error")).toHaveTextContent(INVALID_CREDENTIALS_MESSAGE);
    });
    expect(announced(INVALID_CREDENTIALS_MESSAGE)).toBe(1);

    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(announced(INVALID_CREDENTIALS_MESSAGE)).toBe(2);
    });
    expect(mockSignInWithPassword).toHaveBeenCalledTimes(2);
  });

  it("PrimeTestLab 11035 review: announces unchanged field errors again on each submit", () => {
    const { getByText } = render(<LoginScreen />);

    fireEvent.press(getByText("Log in"));
    expect(announced(EMAIL_REQUIRED_MESSAGE)).toBe(1);
    expect(announced(PASSWORD_REQUIRED_MESSAGE)).toBe(1);

    fireEvent.press(getByText("Log in"));
    expect(announced(EMAIL_REQUIRED_MESSAGE)).toBe(2);
    expect(announced(PASSWORD_REQUIRED_MESSAGE)).toBe(2);
  });

  it("PrimeTestLab 11035 review: leaves Android to the banner's polite live region", async () => {
    Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
    mockSignInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    const { getByText, getByTestId } = render(<LoginScreen />);

    fireEvent.changeText(getByTestId("email-input"), "test@example.com");
    fireEvent.changeText(getByTestId("password-input"), "wrongpassword");
    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(getByTestId("login-error").props.accessibilityLiveRegion).toBe("polite");
    });
    expect(announce).not.toHaveBeenCalled();
  });
});
