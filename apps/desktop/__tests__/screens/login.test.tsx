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
    const { getByText } = render(<LoginScreen />);

    expect(getByText("Log In")).toBeTruthy();
    expect(getByText("Email")).toBeTruthy();
    expect(getByText("Password")).toBeTruthy();
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
    const { getByDisplayValue, getByText, UNSAFE_getAllByType } = render(<LoginScreen />);

    // Get TextInput elements by their rendered type
    const inputs = UNSAFE_getAllByType("RCTSinglelineTextInputView" as never);
    expect(inputs.length).toBeGreaterThanOrEqual(2);

    // First input is email, second is password
    fireEvent.changeText(inputs[0], "test@example.com");
    fireEvent.changeText(inputs[1], "password123");
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

    const { getByText, UNSAFE_getAllByType } = render(<LoginScreen />);

    const inputs = UNSAFE_getAllByType("RCTSinglelineTextInputView" as never);
    fireEvent.changeText(inputs[0], "test@example.com");
    fireEvent.changeText(inputs[1], "wrong");
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
