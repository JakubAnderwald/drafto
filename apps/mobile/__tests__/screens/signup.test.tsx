import React from "react";
import { useRouter } from "expo-router";
import { SIGNUP_CONFIRMATION_SENT, SIGNUP_EMAIL_REDIRECT_URL } from "@drafto/shared";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import SignupScreen from "../../app/(auth)/signup";

const mockSignUp = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      signUp: (...args: unknown[]) => mockSignUp(...args),
    },
  },
}));

// OAuth is covered by its own suite; here it would only pull in the native sign-in modules.
jest.mock("@/components/auth/oauth-buttons", () => ({
  OAuthButtons: () => null,
}));

const NEW_USER = { id: "user-1", identities: [{ id: "identity-1" }] };

function fillAndSubmit({ getByPlaceholderText, getByText }: ReturnType<typeof render>) {
  fireEvent.changeText(getByPlaceholderText("you@example.com"), "  new@example.com ");
  fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "secret123");
  fireEvent.press(getByText("Sign up"));
}

describe("SignupScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignUp.mockResolvedValue({ data: { user: NEW_USER, session: null }, error: null });
  });

  it("renders the sign-up form", () => {
    const { getByText, getByPlaceholderText } = render(<SignupScreen />);

    expect(getByText("Sign Up")).toBeTruthy();
    expect(getByPlaceholderText("you@example.com")).toBeTruthy();
    expect(getByPlaceholderText("Min. 6 characters")).toBeTruthy();
  });

  it("validates the form before calling Supabase", () => {
    const { getByText, getByPlaceholderText } = render(<SignupScreen />);

    fireEvent.press(getByText("Sign up"));
    expect(getByText("Please enter your email and password.")).toBeTruthy();

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "new@example.com");
    fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "12345");
    fireEvent.press(getByText("Sign up"));
    expect(getByText("Password must be at least 6 characters.")).toBeTruthy();

    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it("sends the confirmation link to the web login page", async () => {
    const screen = render(<SignupScreen />);

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalledWith({
        email: "new@example.com",
        password: "secret123",
        options: { emailRedirectTo: SIGNUP_EMAIL_REDIRECT_URL },
      });
    });
  });

  it("shows the check-email state and stays put when sign-up returns no session", async () => {
    // The App Review recording (0:36-0:51): sign-up replaced to the waiting screen, the guard
    // found no session and bounced to login, so the user never learned an email was sent.
    const replace = jest.fn();
    const push = jest.fn();
    (useRouter as jest.Mock).mockReturnValue({ replace, push, back: jest.fn() });

    const screen = render(<SignupScreen />);
    const { getByText, getByTestId, queryByText } = screen;

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(getByTestId("signup-check-email")).toBeTruthy();
    });
    expect(getByText("Check Your Email")).toBeTruthy();
    expect(getByText("new@example.com")).toBeTruthy();
    expect(getByText(SIGNUP_CONFIRMATION_SENT)).toBeTruthy();
    // The form is gone, so it cannot send a second email.
    expect(queryByText("Sign up")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the same check-email state for an address that already has an account", async () => {
    // Supabase answers an existing address with an obfuscated user (no identities) and no
    // session, and sends nothing: the copy must not depend on which case it was.
    mockSignUp.mockResolvedValue({
      data: { user: { id: "obfuscated", identities: [] }, session: null },
      error: null,
    });

    const screen = render(<SignupScreen />);
    const { getByText, getByTestId } = screen;

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(getByTestId("signup-check-email")).toBeTruthy();
    });
    expect(getByText(SIGNUP_CONFIRMATION_SENT)).toBeTruthy();
  });

  it("leaves routing to the auth state change when sign-up returns a session", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: NEW_USER, session: { access_token: "token", user: NEW_USER } },
      error: null,
    });

    const screen = render(<SignupScreen />);
    const { getByText, queryByTestId } = screen;

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalled();
    });
    expect(queryByTestId("signup-check-email")).toBeNull();
  });

  it("shows the Supabase error and keeps the form", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Signups not allowed for this instance" },
    });

    const screen = render(<SignupScreen />);
    const { getByText, queryByTestId } = screen;

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(getByText("Signups not allowed for this instance")).toBeTruthy();
    });
    expect(queryByTestId("signup-check-email")).toBeNull();
  });

  it("dismisses back to the login screen below instead of pushing another one", async () => {
    const screen = render(<SignupScreen />);
    const { getByText } = screen;

    expect(getByText("Log in").props.dismissTo).toBe(true);

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(getByText("Back to login").props.dismissTo).toBe(true);
    });
  });
});
