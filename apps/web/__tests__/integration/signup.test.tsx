import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { SIGNUP_CONFIRMATION_SENT } from "@drafto/shared";

// Mock next/navigation
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Mock Supabase client
const mockSignUp = vi.fn();
const mockSignInWithOAuth = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signUp: mockSignUp,
      signInWithOAuth: mockSignInWithOAuth,
    },
  }),
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

// Import after mocks
const { default: SignupPage } = await import("@/app/(auth)/signup/page");

describe("Signup page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the signup form with OAuth buttons", async () => {
    await act(async () => {
      render(<SignupPage />);
    });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Create Account");
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Google" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apple" })).toBeInTheDocument();
  });

  it("has a link to the login page", async () => {
    await act(async () => {
      render(<SignupPage />);
    });

    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
  });

  it("shows validation for required email", async () => {
    await act(async () => {
      render(<SignupPage />);
    });

    const emailInput = screen.getByLabelText("Email");
    expect(emailInput).toBeRequired();
  });

  it("requires minimum password length", async () => {
    await act(async () => {
      render(<SignupPage />);
    });

    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toHaveAttribute("minlength", "6");
  });

  it("asks the user to check their email when sign-up returns no session", async () => {
    // Email confirmation is on, so there is no session yet. Pushing to /waiting-for-approval
    // only bounced the user back to /login through the middleware.
    mockSignUp.mockResolvedValueOnce({
      data: { user: { id: "user-1", identities: [{ id: "identity-1" }] }, session: null },
      error: null,
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<SignupPage />);
    });

    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.type(screen.getByLabelText("Password"), "securepass");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(mockSignUp).toHaveBeenCalledWith({
      email: "new@example.com",
      password: "securepass",
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Check Your Email");
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    expect(screen.getByText(SIGNUP_CONFIRMATION_SENT)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to login" })).toHaveAttribute("href", "/login");
    // The form is gone, so it cannot send a second email.
    expect(screen.queryByRole("button", { name: "Sign up" })).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("shows the same state for an address that already has an account", async () => {
    // Supabase answers an existing address with an obfuscated user and no session, and sends
    // no email — the copy must not depend on which case it was.
    mockSignUp.mockResolvedValueOnce({
      data: { user: { id: "obfuscated", identities: [] }, session: null },
      error: null,
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<SignupPage />);
    });

    await user.type(screen.getByLabelText("Email"), "existing@example.com");
    await user.type(screen.getByLabelText("Password"), "securepass");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByText(SIGNUP_CONFIRMATION_SENT)).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("goes to the waiting page when sign-up returns a session", async () => {
    mockSignUp.mockResolvedValueOnce({
      data: { user: { id: "user-1" }, session: { access_token: "token" } },
      error: null,
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<SignupPage />);
    });

    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.type(screen.getByLabelText("Password"), "securepass");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(mockPush).toHaveBeenCalledWith("/waiting-for-approval");
    expect(screen.queryByText("Check Your Email")).not.toBeInTheDocument();
  });

  it("displays error message when sign up fails", async () => {
    mockSignUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: "User already registered" },
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<SignupPage />);
    });

    await user.type(screen.getByLabelText("Email"), "existing@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("User already registered");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("shows loading state while submitting", async () => {
    let resolveSignUp: (value: { data: { user: null; session: null }; error: null }) => void;
    mockSignUp.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignUp = resolve;
      }),
    );
    const user = userEvent.setup();

    await act(async () => {
      render(<SignupPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(screen.getByRole("button", { name: "Creating account..." })).toBeDisabled();

    await act(async () => {
      resolveSignUp!({ data: { user: null, session: null }, error: null });
    });
  });

  it("resets loading state after error", async () => {
    mockSignUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: "Signup failed" },
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<SignupPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Signup failed");
    expect(screen.getByRole("button", { name: "Sign up" })).not.toBeDisabled();
  });
});
