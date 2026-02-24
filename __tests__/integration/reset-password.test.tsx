import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
