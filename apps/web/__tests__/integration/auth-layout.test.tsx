import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AuthLayout from "@/app/(auth)/layout";

vi.mock("@/components/ui/theme-toggle", () => ({
  ThemeToggle: () => null,
}));

describe("Auth layout", () => {
  // drafto.eu sends signed-out visitors to /login, so this layout is the public home page
  // Google's OAuth brand verification checks: it must say what Drafto is and link the policy.
  it("describes Drafto and links the privacy policy and support", () => {
    render(
      <AuthLayout>
        <p>form</p>
      </AuthLayout>,
    );

    expect(screen.getByText(/Drafto is a note-taking app/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByRole("link", { name: "Support" })).toHaveAttribute("href", "/support");
    expect(screen.getByText("form")).toBeInTheDocument();
  });
});
