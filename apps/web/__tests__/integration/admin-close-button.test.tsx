import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminCloseButton } from "@/app/(app)/admin/admin-close-button";

// Mock next/navigation
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe("AdminCloseButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a close button with an accessible name", () => {
    render(<AdminCloseButton />);

    expect(screen.getByRole("button", { name: "Close admin" })).toBeInTheDocument();
  });

  it("navigates to the app home via client-side routing when clicked", async () => {
    const user = userEvent.setup();
    render(<AdminCloseButton />);

    await user.click(screen.getByRole("button", { name: "Close admin" }));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/");
  });
});
