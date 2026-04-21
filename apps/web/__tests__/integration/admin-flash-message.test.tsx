import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AdminFlashMessage } from "@/app/(app)/admin/admin-flash-message";

describe("AdminFlashMessage", () => {
  it("renders nothing when no props", () => {
    const { container } = render(<AdminFlashMessage />);
    expect(container.firstChild).toBeNull();
  });

  it("renders success banner with the approved copy", () => {
    render(<AdminFlashMessage approved="approved" />);
    const banner = screen.getByTestId("admin-flash-success");
    expect(banner).toHaveAttribute("data-tone", "success");
    expect(banner.textContent).toMatch(/approved/i);
    expect(banner.textContent).toMatch(/emailed/i);
  });

  it("renders warning-tone banner with approved_email_failed", () => {
    render(<AdminFlashMessage approved="approved_email_failed" />);
    const banner = screen.getByTestId("admin-flash-success");
    expect(banner).toHaveAttribute("data-tone", "warning");
    expect(banner.textContent).toMatch(/email failed/i);
  });

  it("renders idempotent banner with already_approved", () => {
    render(<AdminFlashMessage approved="already_approved" />);
    expect(screen.getByText(/already approved/i)).toBeInTheDocument();
  });

  it("does not expose an email address in the rendered banner (no PII in flag)", () => {
    // The flag is a short token, not the user's email. The component renders
    // a generic message regardless of which user was approved.
    render(<AdminFlashMessage approved="approved" />);
    const banner = screen.getByTestId("admin-flash-success");
    expect(banner.textContent).not.toMatch(/@/);
  });

  it("renders specific error message for each known error code", () => {
    const expected: Record<string, RegExp> = {
      missing_token: /missing its token/i,
      invalid_or_expired_token: /invalid or has expired/i,
      forbidden: /signed in as an admin/i,
      update_failed: /Something went wrong/i,
      user_not_found: /no longer exists/i,
    };
    for (const [code, pattern] of Object.entries(expected)) {
      const { unmount } = render(<AdminFlashMessage error={code} />);
      expect(screen.getByTestId("admin-flash-error").textContent).toMatch(pattern);
      unmount();
    }
  });

  it("falls back to generic error message for unknown code", () => {
    render(<AdminFlashMessage error="some_unknown_code" />);
    expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
  });

  it("prefers approved banner over error when both given", () => {
    render(<AdminFlashMessage approved="approved" error="forbidden" />);
    expect(screen.queryByTestId("admin-flash-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-flash-success")).toBeInTheDocument();
  });
});
