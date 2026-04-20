import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AdminFlashMessage } from "@/app/(app)/admin/admin-flash-message";

describe("AdminFlashMessage", () => {
  it("renders nothing when no props", () => {
    const { container } = render(<AdminFlashMessage />);
    expect(container.firstChild).toBeNull();
  });

  it("renders success message with email when approved prop is set", () => {
    render(<AdminFlashMessage approved="jane@example.com" />);
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    expect(screen.getByText(/emailed and can sign in now/)).toBeInTheDocument();
  });

  it("renders specific error message for known error code", () => {
    render(<AdminFlashMessage error="invalid_or_expired_token" />);
    expect(screen.getByText(/invalid or has expired/)).toBeInTheDocument();
  });

  it("renders each known error message", () => {
    const codes = [
      "missing_token",
      "invalid_or_expired_token",
      "forbidden",
      "update_failed",
      "user_not_found",
    ];
    for (const code of codes) {
      const { unmount } = render(<AdminFlashMessage error={code} />);
      const banner = screen.getByText(/./, {
        selector: "div.bg-red-50",
      });
      expect(banner.textContent).not.toBe("Something went wrong.");
      unmount();
    }
  });

  it("falls back to generic error message for unknown code", () => {
    render(<AdminFlashMessage error="some_unknown_code" />);
    expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
  });

  it("prefers approved message over error when both given", () => {
    render(<AdminFlashMessage approved="jane@example.com" error="forbidden" />);
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    expect(screen.queryByText(/signed in as an admin/)).not.toBeInTheDocument();
  });
});
