import React from "react";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import { LoginScreen } from "../../src/screens/login";

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
    const { getByText } = render(<LoginScreen />);

    fireEvent.press(getByText("Log in"));

    await waitFor(() => {
      expect(getByText("Please enter your email and password.")).toBeTruthy();
    });

    expect(mockSignInWithPassword).not.toHaveBeenCalled();
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
      expect(getByText("Invalid login credentials")).toBeTruthy();
    });
  });

  it("calls onNavigateToSignup when signup link is pressed", () => {
    const onNavigateToSignup = jest.fn();
    const { getByText } = render(<LoginScreen onNavigateToSignup={onNavigateToSignup} />);

    fireEvent.press(getByText("Sign up"));

    expect(onNavigateToSignup).toHaveBeenCalled();
  });
});
