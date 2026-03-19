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
    expect(badge.className).toContain("bg-bg-muted");
    expect(badge.className).toContain("text-fg-muted");
  });

  it("applies success variant styles", () => {
    render(
      <Badge variant="success" data-testid="badge">
        Saved
      </Badge>,
    );
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("bg-success-bg");
    expect(badge.className).toContain("text-success-text");
  });

  it("applies warning variant styles", () => {
    render(
      <Badge variant="warning" data-testid="badge">
        Saving
      </Badge>,
    );
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("bg-warning-bg");
    expect(badge.className).toContain("text-warning-text");
  });

  it("applies error variant styles", () => {
    render(
      <Badge variant="error" data-testid="badge">
        Error
      </Badge>,
    );
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("bg-error-bg");
    expect(badge.className).toContain("text-error-text");
  });

  it("applies pill shape", () => {
    render(<Badge data-testid="badge">Tag</Badge>);
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("rounded-md");
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
