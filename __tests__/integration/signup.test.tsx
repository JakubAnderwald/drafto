import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
