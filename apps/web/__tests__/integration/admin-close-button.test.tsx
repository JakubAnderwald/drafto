import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("renders a button named Close admin", () => {
    render(<AdminCloseButton />);

    expect(screen.getByRole("button", { name: "Close admin" })).toBeInTheDocument();
  });

  it("navigates home once when clicked", async () => {
    const user = userEvent.setup();
    render(<AdminCloseButton />);

    await user.click(screen.getByRole("button", { name: "Close admin" }));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("navigates home when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(<AdminCloseButton />);

    await user.keyboard("{Escape}");

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("navigates home on Escape with focus inside the panel", async () => {
    const user = userEvent.setup();
    render(
      <div data-testid="admin-panel">
        <button type="button">Approve</button>
        <AdminCloseButton />
      </div>,
    );

    screen.getByRole("button", { name: "Approve" }).focus();
    await user.keyboard("{Escape}");

    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("does not navigate on Escape while the panel's confirm dialog is open", async () => {
    const user = userEvent.setup();
    render(
      <div data-testid="admin-panel">
        <AdminCloseButton />
        <div role="alertdialog" aria-label="Delete user?" />
      </div>,
    );

    await user.keyboard("{Escape}");

    expect(mockPush).not.toHaveBeenCalled();
  });

  it("does not navigate on Escape with focus outside the panel", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">App menu</button>
        <div data-testid="admin-panel">
          <AdminCloseButton />
        </div>
      </>,
    );

    screen.getByRole("button", { name: "App menu" }).focus();
    await user.keyboard("{Escape}");

    expect(mockPush).not.toHaveBeenCalled();
  });

  it("does not navigate when Escape first closes an overlay outside the panel", async () => {
    const user = userEvent.setup();
    const overlayButton = document.createElement("button");
    document.body.appendChild(overlayButton);
    // Registered before the component's listener, like React's root listener in
    // the app: it removes the focused overlay button, so focus falls to <body>.
    const closeOverlay = (event: KeyboardEvent) => {
      if (event.key === "Escape") overlayButton.remove();
    };
    document.addEventListener("keydown", closeOverlay);

    try {
      render(
        <div data-testid="admin-panel">
          <AdminCloseButton />
        </div>,
      );
      overlayButton.focus();
      await user.keyboard("{Escape}");
    } finally {
      document.removeEventListener("keydown", closeOverlay);
    }

    expect(overlayButton.isConnected).toBe(false);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("stops listening for Escape after unmount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AdminCloseButton />);

    unmount();
    await user.keyboard("{Escape}");

    expect(mockPush).not.toHaveBeenCalled();
  });
});
