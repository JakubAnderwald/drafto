import React from "react";
import { Alert } from "react-native";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import LoginScreen from "../../app/(auth)/login";

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

  it("shows sign up link", () => {
    const { getByText } = render(<LoginScreen />);

    expect(getByText("Sign up")).toBeTruthy();
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
