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
const mockSignIn = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signInWithPassword: mockSignIn },
  }),
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const { default: LoginPage } = await import("@/app/(auth)/login/page");

describe("Login page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the login form", async () => {
    await act(async () => {
      render(<LoginPage />);
    });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Log In");
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
  });

  it("has links to signup and forgot password", async () => {
    await act(async () => {
      render(<LoginPage />);
    });

    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("calls signInWithPassword and navigates on success", async () => {
    mockSignIn.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    await act(async () => {
      render(<LoginPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(mockSignIn).toHaveBeenCalledWith({
      email: "test@example.com",
      password: "password123",
    });
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("displays error message when sign in fails", async () => {
    mockSignIn.mockResolvedValueOnce({
      error: { message: "Invalid login credentials" },
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<LoginPage />);
    });

    await user.type(screen.getByLabelText("Email"), "bad@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login credentials");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("shows loading state while submitting", async () => {
    let resolveSignIn: (value: { error: null }) => void;
    mockSignIn.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    const user = userEvent.setup();

    await act(async () => {
      render(<LoginPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(screen.getByRole("button", { name: "Logging in..." })).toBeDisabled();

    await act(async () => {
      resolveSignIn!({ error: null });
    });
  });

  it("clears previous error on new submission", async () => {
    mockSignIn.mockResolvedValueOnce({
      error: { message: "First error" },
    });
    mockSignIn.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    await act(async () => {
      render(<LoginPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("First error");

    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
