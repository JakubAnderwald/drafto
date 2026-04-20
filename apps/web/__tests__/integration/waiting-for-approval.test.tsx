import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockSignOut = vi.fn();
const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: mockSignOut, getUser: mockGetUser },
  }),
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const { default: WaitingPage } = await import("@/app/(auth)/waiting-for-approval/page");

describe("Waiting for approval page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { email: "pending@example.com" } } });
  });

  it("renders the waiting message and user email", async () => {
    await act(async () => {
      render(<WaitingPage />);
    });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Waiting for approval");
    expect(screen.getByText(/admin has been notified/i)).toBeInTheDocument();
    expect(screen.getByText("pending@example.com")).toBeInTheDocument();
  });

  it("falls back to a generic line when email is unavailable", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    await act(async () => {
      render(<WaitingPage />);
    });

    expect(screen.getByText(/email you as soon as you.+re approved/)).toBeInTheDocument();
  });

  it("has a logout button", async () => {
    await act(async () => {
      render(<WaitingPage />);
    });

    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("calls signOut and navigates to login on logout", async () => {
    mockSignOut.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    await act(async () => {
      render(<WaitingPage />);
    });

    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(mockSignOut).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith("/login");
  });

  it("navigates to login even when signOut returns an error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockSignOut.mockResolvedValueOnce({
      error: { message: "Sign out failed" },
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<WaitingPage />);
    });

    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(mockSignOut).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to sign out:",
      expect.objectContaining({ message: "Sign out failed" }),
    );
    expect(mockPush).toHaveBeenCalledWith("/login");

    consoleSpy.mockRestore();
  });
});
