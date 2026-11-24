import React from "react";
import { AccessibilityInfo } from "react-native";
import {
  EMAIL_REQUIRED_MESSAGE,
  INVALID_EMAIL_MESSAGE,
  PASSWORD_REQUIRED_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  SIGNUP_CONFIRMATION_SENT,
  SIGNUP_EMAIL_REDIRECT_URL,
  USER_ALREADY_EXISTS_MESSAGE,
} from "@drafto/shared";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import { SignupScreen } from "../../src/screens/signup";

const mockSignUp = jest.fn();
let mockCryptoReady: Promise<void> = Promise.resolve();

jest.mock("@/lib/supabase", () => ({
  get cryptoReady() {
    return mockCryptoReady;
  },
  supabase: {
    auth: {
      signUp: (...args: unknown[]) => mockSignUp(...args),
    },
  },
}));

const NEW_USER = { id: "user-1", identities: [{ id: "identity-1" }] };

function fillAndSubmit({ getByPlaceholderText, getByText }: ReturnType<typeof render>) {
  fireEvent.changeText(getByPlaceholderText("you@example.com"), " test@example.com ");
  fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "password123");
  fireEvent.press(getByText("Sign up"));
}

describe("SignupScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCryptoReady = Promise.resolve();
    mockSignUp.mockResolvedValue({ data: { user: NEW_USER, session: null }, error: null });
  });

  it("renders signup form", () => {
    const { getByText } = render(<SignupScreen />);

    expect(getByText("Sign Up")).toBeTruthy();
    expect(getByText("Create your Drafto account")).toBeTruthy();
    expect(getByText("Sign up")).toBeTruthy();
  });

  it("shows error when submitting empty form", async () => {
    const { getByText, getByTestId } = render(<SignupScreen />);

    fireEvent.press(getByText("Sign up"));

    await waitFor(() => {
      expect(getByTestId("signup-email-input-error")).toHaveTextContent(EMAIL_REQUIRED_MESSAGE);
    });
    expect(getByTestId("signup-password-input-error")).toHaveTextContent(PASSWORD_REQUIRED_MESSAGE);

    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it("shows error when password is too short", async () => {
    const { getByText, getByPlaceholderText, getByTestId } = render(<SignupScreen />);

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "test@example.com");
    fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "12345");
    fireEvent.press(getByText("Sign up"));

    await waitFor(() => {
      expect(getByTestId("signup-password-input-error")).toHaveTextContent(
        PASSWORD_TOO_SHORT_MESSAGE,
      );
    });

    expect(mockSignUp).not.toHaveBeenCalled();
  });

  describe("email validation (PrimeTestLab 11035 M-02)", () => {
    it("PrimeTestLab 11035 M-02: shows the email and password errors together on the first click", () => {
      const { getByTestId, queryByTestId } = render(<SignupScreen />);

      fireEvent.changeText(getByTestId("signup-email-input"), "planner.com");
      fireEvent.changeText(getByTestId("signup-password-input"), "abc");
      fireEvent.press(getByTestId("signup-submit"));

      expect(mockSignUp).not.toHaveBeenCalled();
      expect(getByTestId("signup-email-input-error")).toHaveTextContent(INVALID_EMAIL_MESSAGE);
      expect(getByTestId("signup-password-input-error")).toHaveTextContent(
        PASSWORD_TOO_SHORT_MESSAGE,
      );
      expect(queryByTestId("signup-error")).toBeNull();
    });

    it("PrimeTestLab 11035 M-02: clears a field's error once the user edits that field", () => {
      const { getByTestId, queryByTestId } = render(<SignupScreen />);

      fireEvent.changeText(getByTestId("signup-email-input"), "planner.com");
      fireEvent.changeText(getByTestId("signup-password-input"), "abc");
      fireEvent.press(getByTestId("signup-submit"));

      fireEvent.changeText(getByTestId("signup-password-input"), "abcdef");
      expect(queryByTestId("signup-password-input-error")).toBeNull();
      expect(getByTestId("signup-email-input-error")).toBeTruthy();
    });

    it("PrimeTestLab 11035 M-02: puts Supabase's format error under the field, never the raw text", async () => {
      mockSignUp.mockResolvedValue({
        data: { user: null, session: null },
        error: { message: "Unable to validate email address: invalid format", status: 400 },
      });
      const screen = render(<SignupScreen />);

      fillAndSubmit(screen);

      await waitFor(() => {
        expect(screen.getByTestId("signup-email-input-error")).toHaveTextContent(
          INVALID_EMAIL_MESSAGE,
        );
      });
      expect(screen.queryByText(/Unable to validate/)).toBeNull();
      expect(screen.queryByTestId("signup-error")).toBeNull();
    });
  });

  it("calls signUp with the trimmed email and the web login page as the confirmation target", async () => {
    fillAndSubmit(render(<SignupScreen />));

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "password123",
        options: { emailRedirectTo: SIGNUP_EMAIL_REDIRECT_URL },
      });
    });
  });

  it("waits for the PKCE crypto before signing up, so its challenge is S256", async () => {
    let settle = () => {};
    mockCryptoReady = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const screen = render(<SignupScreen />);

    fillAndSubmit(screen);
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(mockSignUp).not.toHaveBeenCalled();

    settle();
    await waitFor(() => {
      expect(screen.getByTestId("signup-check-email")).toBeTruthy();
    });
    expect(mockSignUp).toHaveBeenCalledTimes(1);
  });

  it("switches to the check-email state when sign-up returns no session (#675)", async () => {
    // Email confirmation is on, so no session and no auth event: the screen used to just stop
    // its spinner and leave the user on the form.
    const onNavigateToLogin = jest.fn();
    const screen = render(<SignupScreen onNavigateToLogin={onNavigateToLogin} />);

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(screen.getByTestId("signup-check-email")).toBeTruthy();
    });
    expect(screen.getByText("Check Your Email")).toBeTruthy();
    expect(screen.getByText("test@example.com")).toBeTruthy();
    expect(screen.getByText(SIGNUP_CONFIRMATION_SENT)).toBeTruthy();
    // The form is gone, so it cannot be submitted again for a second email.
    expect(screen.queryByText("Sign up")).toBeNull();
    expect(screen.queryByPlaceholderText("Min. 6 characters")).toBeNull();

    fireEvent.press(screen.getByLabelText("Back to login"));
    expect(onNavigateToLogin).toHaveBeenCalledTimes(1);
  });

  it("shows the same state for an address that already has an account", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: "obfuscated", identities: [] }, session: null },
      error: null,
    });
    const screen = render(<SignupScreen />);

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(screen.getByText(SIGNUP_CONFIRMATION_SENT)).toBeTruthy();
    });
  });

  it("leaves navigation to the auth state change when sign-up returns a session", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: NEW_USER, session: { access_token: "token", user: NEW_USER } },
      error: null,
    });
    const screen = render(<SignupScreen />);

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("signup-check-email")).toBeNull();
    expect(screen.getByText("Sign up")).toBeTruthy();
  });

  it("shows error from Supabase", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "User already registered" },
    });

    const { getByText, getByPlaceholderText, queryByTestId } = render(<SignupScreen />);

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "test@example.com");
    fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "password123");
    fireEvent.press(getByText("Sign up"));

    await waitFor(() => {
      expect(getByText(USER_ALREADY_EXISTS_MESSAGE)).toBeTruthy();
    });
    expect(queryByTestId("signup-check-email")).toBeNull();
  });

  it("calls onNavigateToLogin when login link is pressed", () => {
    const onNavigateToLogin = jest.fn();
    const { getByText } = render(<SignupScreen onNavigateToLogin={onNavigateToLogin} />);

    fireEvent.press(getByText("Log in"));

    expect(onNavigateToLogin).toHaveBeenCalled();
  });

  it("tags the password as a new password and lets the user show it", () => {
    const { getByTestId } = render(<SignupScreen />);

    const field = () => getByTestId("signup-password-input");
    // "password" would hint the current password; a sign-up field takes a new one.
    expect(field().props.autoComplete).toBe("new-password");
    expect(field().props.textContentType).toBe("newPassword");
    expect(field().props.secureTextEntry).toBe(true);

    fireEvent.press(getByTestId("signup-password-input-toggle"));
    expect(field().props.secureTextEntry).toBe(false);
  });
});

describe("SignupScreen — VoiceOver announcements (PrimeTestLab 11035 review)", () => {
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

  it("PrimeTestLab 11035 review: announces the error banner on each failed submit", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "User already registered", code: "user_already_exists" },
    });
    const screen = render(<SignupScreen />);

    fillAndSubmit(screen);
    await waitFor(() => {
      expect(screen.getByTestId("signup-error")).toHaveTextContent(USER_ALREADY_EXISTS_MESSAGE);
    });
    expect(announced(USER_ALREADY_EXISTS_MESSAGE)).toBe(1);

    fireEvent.press(screen.getByText("Sign up"));
    await waitFor(() => {
      expect(announced(USER_ALREADY_EXISTS_MESSAGE)).toBe(2);
    });
  });
});
