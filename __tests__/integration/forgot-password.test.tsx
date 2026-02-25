import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const mockResetPassword = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { resetPasswordForEmail: mockResetPassword },
  }),
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const { default: ForgotPasswordPage } = await import("@/app/(auth)/forgot-password/page");

describe("Forgot password page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the forgot password form", async () => {
    await act(async () => {
      render(<ForgotPasswordPage />);
    });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Forgot Password");
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeInTheDocument();
  });

  it("has a link back to login", async () => {
    await act(async () => {
      render(<ForgotPasswordPage />);
    });

    expect(screen.getByRole("link", { name: "Back to login" })).toHaveAttribute("href", "/login");
  });

  it("calls resetPasswordForEmail and shows success message", async () => {
    mockResetPassword.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    await act(async () => {
      render(<ForgotPasswordPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(mockResetPassword).toHaveBeenCalledWith("test@example.com", {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Check Your Email");
    expect(screen.getByText(/test@example.com/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to login" })).toHaveAttribute("href", "/login");
  });

  it("displays error message when reset fails", async () => {
    mockResetPassword.mockResolvedValueOnce({
      error: { message: "Rate limit exceeded" },
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<ForgotPasswordPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Rate limit exceeded");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Forgot Password");
  });

  it("shows loading state while submitting", async () => {
    let resolveReset: (value: { error: null }) => void;
    mockResetPassword.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReset = resolve;
      }),
    );
    const user = userEvent.setup();

    await act(async () => {
      render(<ForgotPasswordPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();

    await act(async () => {
      resolveReset!({ error: null });
    });
  });

  it("handles unexpected exceptions in the catch block", async () => {
    mockResetPassword.mockRejectedValueOnce(new Error("Network failure"));
    const user = userEvent.setup();

    await act(async () => {
      render(<ForgotPasswordPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Network failure");
  });

  it("handles non-Error exceptions with fallback message", async () => {
    mockResetPassword.mockRejectedValueOnce("some string error");
    const user = userEvent.setup();

    await act(async () => {
      render(<ForgotPasswordPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to send reset link");
  });
});
