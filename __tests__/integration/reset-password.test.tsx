import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockUpdateUser = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { updateUser: mockUpdateUser },
  }),
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const { default: ResetPasswordPage } = await import("@/app/(auth)/reset-password/page");

describe("Reset password page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the reset password form", async () => {
    await act(async () => {
      render(<ResetPasswordPage />);
    });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Reset Password");
    expect(screen.getByLabelText("New Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset password" })).toBeInTheDocument();
  });

  it("has a link back to login", async () => {
    await act(async () => {
      render(<ResetPasswordPage />);
    });

    expect(screen.getByRole("link", { name: "Back to login" })).toHaveAttribute("href", "/login");
  });

  it("calls updateUser and navigates on success", async () => {
    mockUpdateUser.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    await user.type(screen.getByLabelText("New Password"), "newpassword123");
    await user.type(screen.getByLabelText("Confirm Password"), "newpassword123");
    await user.click(screen.getByRole("button", { name: "Reset password" }));

    expect(mockUpdateUser).toHaveBeenCalledWith({ password: "newpassword123" });
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("shows error when passwords do not match", async () => {
    const user = userEvent.setup();

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    await user.type(screen.getByLabelText("New Password"), "password1");
    await user.type(screen.getByLabelText("Confirm Password"), "password2");
    await user.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Passwords do not match");
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("displays error message when updateUser fails", async () => {
    mockUpdateUser.mockResolvedValueOnce({
      error: { message: "Password is too weak" },
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    await user.type(screen.getByLabelText("New Password"), "weak");
    await user.type(screen.getByLabelText("Confirm Password"), "weak");
    await user.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Password is too weak");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("shows loading state while submitting", async () => {
    let resolveUpdate: (value: { error: null }) => void;
    mockUpdateUser.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    const user = userEvent.setup();

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    await user.type(screen.getByLabelText("New Password"), "newpassword123");
    await user.type(screen.getByLabelText("Confirm Password"), "newpassword123");
    await user.click(screen.getByRole("button", { name: "Reset password" }));

    expect(screen.getByRole("button", { name: "Resetting..." })).toBeDisabled();

    await act(async () => {
      resolveUpdate!({ error: null });
    });
  });

  it("resets loading state after API error", async () => {
    mockUpdateUser.mockResolvedValueOnce({
      error: { message: "Session expired" },
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    await user.type(screen.getByLabelText("New Password"), "newpassword123");
    await user.type(screen.getByLabelText("Confirm Password"), "newpassword123");
    await user.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Session expired");
    expect(screen.getByRole("button", { name: "Reset password" })).not.toBeDisabled();
  });

  it("requires minimum password length attributes", async () => {
    await act(async () => {
      render(<ResetPasswordPage />);
    });

    expect(screen.getByLabelText("New Password")).toHaveAttribute("minlength", "6");
    expect(screen.getByLabelText("Confirm Password")).toHaveAttribute("minlength", "6");
  });
});
