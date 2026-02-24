import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockSignOut = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: mockSignOut },
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
  });

  it("renders the waiting message", async () => {
    await act(async () => {
      render(<WaitingPage />);
    });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Waiting for Approval");
    expect(screen.getByText(/pending approval/)).toBeInTheDocument();
  });

  it("has a logout button", async () => {
    await act(async () => {
      render(<WaitingPage />);
    });

    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });
});
