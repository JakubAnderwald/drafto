import React from "react";
import { SIGNUP_CONFIRMATION_SENT, SIGNUP_EMAIL_REDIRECT_URL } from "@drafto/shared";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import { SignupScreen } from "../../src/screens/signup";

const mockSignUp = jest.fn();

jest.mock("@/lib/supabase", () => ({
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
    mockSignUp.mockResolvedValue({ data: { user: NEW_USER, session: null }, error: null });
  });

  it("renders signup form", () => {
    const { getByText } = render(<SignupScreen />);

    expect(getByText("Sign Up")).toBeTruthy();
    expect(getByText("Create your Drafto account")).toBeTruthy();
    expect(getByText("Sign up")).toBeTruthy();
  });

  it("shows error when submitting empty form", async () => {
    const { getByText } = render(<SignupScreen />);

    fireEvent.press(getByText("Sign up"));

    await waitFor(() => {
      expect(getByText("Please enter your email and password.")).toBeTruthy();
    });

    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it("shows error when password is too short", async () => {
    const { getByText, getByPlaceholderText } = render(<SignupScreen />);

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "test@example.com");
    fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "12345");
    fireEvent.press(getByText("Sign up"));

    await waitFor(() => {
      expect(getByText("Password must be at least 6 characters.")).toBeTruthy();
    });

    expect(mockSignUp).not.toHaveBeenCalled();
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
      expect(getByText("User already registered")).toBeTruthy();
    });
    expect(queryByTestId("signup-check-email")).toBeNull();
  });

  it("calls onNavigateToLogin when login link is pressed", () => {
    const onNavigateToLogin = jest.fn();
    const { getByText } = render(<SignupScreen onNavigateToLogin={onNavigateToLogin} />);

    fireEvent.press(getByText("Log in"));

    expect(onNavigateToLogin).toHaveBeenCalled();
  });
});
