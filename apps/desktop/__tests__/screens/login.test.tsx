import React from "react";
import { AccessibilityInfo } from "react-native";
import {
  ACCOUNT_DELETED_MESSAGE,
  EMAIL_REQUIRED_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  INVALID_EMAIL_MESSAGE,
  PASSWORD_REQUIRED_MESSAGE,
} from "@drafto/shared";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import { LoginScreen } from "../../src/screens/login";
import {
  clearAccountDeletedNotice,
  isAccountDeletedNoticeShown,
  reportAccountDeleted,
} from "@/lib/account-deleted-notice";

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
    mockSignInWithPassword.mockResolvedValue({ error: null });
  });

  it("renders login form", () => {
    const { getByText, getByTestId } = render(<LoginScreen />);

    expect(getByText("Log In")).toBeTruthy();
    expect(getByTestId("email-input")).toBeTruthy();
    expect(getByTestId("password-input")).toBeTruthy();
    expect(getByText("Log in")).toBeTruthy();
  });

  it("shows error when submitting empty form", async () => {
    const { getByText, getByTestId } = render(<LoginScreen />);

    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(getByTestId("email-input-error")).toHaveTextContent(EMAIL_REQUIRED_MESSAGE);
    });
    expect(getByTestId("password-input-error")).toHaveTextContent(PASSWORD_REQUIRED_MESSAGE);

    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it("PrimeTestLab 11035 M-02: refuses a malformed email without calling Supabase, under the field", () => {
    const { getByText, getByTestId, queryByTestId } = render(<LoginScreen />);

    fireEvent.changeText(getByTestId("email-input"), "planner.com");
    fireEvent.changeText(getByTestId("password-input"), "abc");
    fireEvent.press(getByText("Log in"));

    expect(mockSignInWithPassword).not.toHaveBeenCalled();
    expect(getByTestId("email-input-error")).toHaveTextContent(INVALID_EMAIL_MESSAGE);
    // Log-in never checks a password's length: older accounts may have shorter ones.
    expect(queryByTestId("password-input-error")).toBeNull();
    expect(queryByTestId("login-error")).toBeNull();
    // VoiceOver reads the error again when the field gets focus.
    expect(getByTestId("email-input").props.accessibilityHint).toBe(INVALID_EMAIL_MESSAGE);
    expect(getByTestId("email-input-error").props.accessibilityRole).toBe("alert");

    fireEvent.changeText(getByTestId("email-input"), "planner@example.com");
    expect(queryByTestId("email-input-error")).toBeNull();
  });

  it("PrimeTestLab 11035 M-02: puts Supabase's format error under the email field", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Unable to validate email address: invalid format" },
    });
    const { getByText, getByTestId, queryByText } = render(<LoginScreen />);

    fireEvent.changeText(getByTestId("email-input"), "name@example.com");
    fireEvent.changeText(getByTestId("password-input"), "password123");
    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(getByTestId("email-input-error")).toHaveTextContent(INVALID_EMAIL_MESSAGE);
    });
    expect(queryByText(/Unable to validate/)).toBeNull();
  });

  it("calls signInWithPassword with email and password", async () => {
    const { getByTestId, getByText } = render(<LoginScreen />);

    fireEvent.changeText(getByTestId("email-input"), "test@example.com");
    fireEvent.changeText(getByTestId("password-input"), "password123");
    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "password123",
      });
    });
  });

  it("shows error from Supabase auth", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });

    const { getByTestId, getByText } = render(<LoginScreen />);

    fireEvent.changeText(getByTestId("email-input"), "test@example.com");
    fireEvent.changeText(getByTestId("password-input"), "wrong");
    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(getByText(INVALID_CREDENTIALS_MESSAGE)).toBeTruthy();
    });
  });

  it("calls onNavigateToSignup when signup link is pressed", () => {
    const onNavigateToSignup = jest.fn();
    const { getByText } = render(<LoginScreen onNavigateToSignup={onNavigateToSignup} />);

    fireEvent.press(getByText("Sign up"));

    expect(onNavigateToSignup).toHaveBeenCalled();
  });

  it("calls onNavigateToForgotPassword when the forgot-password link is pressed", () => {
    const onNavigateToForgotPassword = jest.fn();
    const { getByText, getByTestId } = render(
      <LoginScreen onNavigateToForgotPassword={onNavigateToForgotPassword} />,
    );

    expect(getByText("Forgot your password?")).toBeTruthy();
    fireEvent.press(getByTestId("forgot-password-link"));

    expect(onNavigateToForgotPassword).toHaveBeenCalled();
  });

  describe("account-deleted confirmation", () => {
    afterEach(() => clearAccountDeletedNotice());

    it("is not shown by default", () => {
      const { queryByTestId } = render(<LoginScreen />);

      expect(queryByTestId("account-deleted-notice")).toBeNull();
    });

    it("confirms a deletion that finished before the screen mounted", () => {
      reportAccountDeleted();

      const { getByTestId, getByText } = render(<LoginScreen />);

      expect(getByTestId("account-deleted-notice")).toBeTruthy();
      expect(getByText(ACCOUNT_DELETED_MESSAGE)).toBeTruthy();
    });

    it("appears when the deletion is reported while the screen is open", () => {
      const { getByText } = render(<LoginScreen />);

      act(() => reportAccountDeleted());

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
});
