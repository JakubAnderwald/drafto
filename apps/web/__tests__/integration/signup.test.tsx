import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";

// Mock next/navigation
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Mock Supabase client
const mockSignUp = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signUp: mockSignUp },
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

  it("renders the signup form", async () => {
    await act(async () => {
      render(<SignupPage />);
    });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Create Account");
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign up" })).toBeInTheDocument();
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

  it("calls signUp and navigates to waiting page on success", async () => {
    mockSignUp.mockResolvedValueOnce({ error: null });
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
    expect(mockPush).toHaveBeenCalledWith("/waiting-for-approval");
  });

  it("displays error message when sign up fails", async () => {
    mockSignUp.mockResolvedValueOnce({
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
    let resolveSignUp: (value: { error: null }) => void;
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
      resolveSignUp!({ error: null });
    });
  });

  it("resets loading state after error", async () => {
    mockSignUp.mockResolvedValueOnce({
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
