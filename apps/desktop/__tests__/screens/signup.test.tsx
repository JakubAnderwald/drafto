import React from "react";

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

describe("SignupScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignUp.mockResolvedValue({ error: null });
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

  it("calls signUp with email and password", async () => {
    const { getByText, getByPlaceholderText } = render(<SignupScreen />);

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "test@example.com");
    fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "password123");
    fireEvent.press(getByText("Sign up"));

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "password123",
      });
    });
  });

  it("shows error from Supabase", async () => {
    mockSignUp.mockResolvedValue({
      error: { message: "User already registered" },
    });

    const { getByText, getByPlaceholderText } = render(<SignupScreen />);

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "test@example.com");
    fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "password123");
    fireEvent.press(getByText("Sign up"));

    await waitFor(() => {
      expect(getByText("User already registered")).toBeTruthy();
    });
  });

  it("calls onNavigateToLogin when login link is pressed", () => {
    const onNavigateToLogin = jest.fn();
    const { getByText } = render(<SignupScreen onNavigateToLogin={onNavigateToLogin} />);

    fireEvent.press(getByText("Log in"));

    expect(onNavigateToLogin).toHaveBeenCalled();
  });
});
