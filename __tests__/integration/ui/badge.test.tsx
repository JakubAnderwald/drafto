import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "@/components/ui/badge";

describe("Badge", () => {
  it("renders children", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders as a span element", () => {
    render(<Badge data-testid="badge">Active</Badge>);
    const badge = screen.getByTestId("badge");
    expect(badge.tagName).toBe("SPAN");
  });

  it("applies default variant styles", () => {
    render(<Badge data-testid="badge">Tag</Badge>);
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("bg-neutral-100");
    expect(badge.className).toContain("text-neutral-700");
  });

  it("applies success variant styles", () => {
    render(
      <Badge variant="success" data-testid="badge">
        Saved
      </Badge>,
    );
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("bg-green-50");
    expect(badge.className).toContain("text-green-700");
  });

  it("applies warning variant styles", () => {
    render(
      <Badge variant="warning" data-testid="badge">
        Saving
      </Badge>,
    );
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("bg-amber-50");
    expect(badge.className).toContain("text-amber-700");
  });

  it("applies error variant styles", () => {
    render(
      <Badge variant="error" data-testid="badge">
        Error
      </Badge>,
    );
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("bg-red-50");
    expect(badge.className).toContain("text-red-700");
  });

  it("applies pill shape", () => {
    render(<Badge data-testid="badge">Tag</Badge>);
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("rounded-full");
  });

  it("applies small text size", () => {
    render(<Badge data-testid="badge">Tag</Badge>);
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("text-xs");
  });

  it("merges custom className", () => {
    render(
      <Badge className="custom-class" data-testid="badge">
        Tag
      </Badge>,
    );
    expect(screen.getByTestId("badge").className).toContain("custom-class");
  });

  it("passes through HTML attributes", () => {
    render(
      <Badge data-testid="badge" role="status">
        Active
      </Badge>,
    );
    expect(screen.getByTestId("badge")).toHaveAttribute("role", "status");
  });
});
