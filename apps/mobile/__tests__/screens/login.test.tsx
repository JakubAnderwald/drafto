import React from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import LoginScreen from "../../app/(auth)/login";
import { ACCOUNT_DELETED_MESSAGE } from "@drafto/shared";
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
    const { getByText } = render(<LoginScreen />);

    fireEvent.press(getByText("Log in"));

    expect(getByText("Please enter your email and password.")).toBeTruthy();
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
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
      expect(getByText("Invalid login credentials")).toBeTruthy();
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

  it("makes room for the keyboard without re-laying the form out on iOS", () => {
    // A KeyboardAvoidingView here made the form jitter when a field was focused.
    const platformOs = jest.replaceProperty(Platform, "OS", "ios");
    try {
      const { UNSAFE_getByType, UNSAFE_queryByType } = render(<LoginScreen />);

      expect(UNSAFE_queryByType(KeyboardAvoidingView)).toBeNull();
      expect(UNSAFE_getByType(ScrollView).props.automaticallyAdjustKeyboardInsets).toBe(true);
    } finally {
      platformOs.restore();
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
});
