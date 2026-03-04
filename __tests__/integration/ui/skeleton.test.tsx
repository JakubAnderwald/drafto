import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Skeleton } from "@/components/ui/skeleton";

describe("Skeleton", () => {
  it("renders a div element", () => {
    render(<Skeleton data-testid="skeleton" />);
    expect(screen.getByTestId("skeleton").tagName).toBe("DIV");
  });

  it("has role=status for accessibility", () => {
    render(<Skeleton />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("has aria-label for screen readers", () => {
    render(<Skeleton />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Loading");
  });

  it("applies pulse animation", () => {
    render(<Skeleton data-testid="skeleton" />);
    expect(screen.getByTestId("skeleton").className).toContain("animate-pulse");
  });

  it("applies neutral background", () => {
    render(<Skeleton data-testid="skeleton" />);
    expect(screen.getByTestId("skeleton").className).toContain("bg-bg-muted");
  });

  it("applies default md rounded", () => {
    render(<Skeleton data-testid="skeleton" />);
    expect(screen.getByTestId("skeleton").className).toContain("rounded-md");
  });

  it("applies sm rounded", () => {
    render(<Skeleton rounded="sm" data-testid="skeleton" />);
    expect(screen.getByTestId("skeleton").className).toContain("rounded-sm");
  });

  it("applies lg rounded", () => {
    render(<Skeleton rounded="lg" data-testid="skeleton" />);
    expect(screen.getByTestId("skeleton").className).toContain("rounded-lg");
  });

  it("applies full rounded", () => {
    render(<Skeleton rounded="full" data-testid="skeleton" />);
    expect(screen.getByTestId("skeleton").className).toContain("rounded-full");
  });

  it("applies custom width via style", () => {
    render(<Skeleton width="200px" data-testid="skeleton" />);
    expect(screen.getByTestId("skeleton").style.width).toBe("200px");
  });

  it("applies custom height via style", () => {
    render(<Skeleton height="40px" data-testid="skeleton" />);
    expect(screen.getByTestId("skeleton").style.height).toBe("40px");
  });

  it("applies both width and height", () => {
    render(<Skeleton width="100px" height="20px" data-testid="skeleton" />);
    const el = screen.getByTestId("skeleton");
    expect(el.style.width).toBe("100px");
    expect(el.style.height).toBe("20px");
  });

  it("merges custom className", () => {
    render(<Skeleton className="custom-class" data-testid="skeleton" />);
    expect(screen.getByTestId("skeleton").className).toContain("custom-class");
  });

  it("merges custom inline styles", () => {
    render(<Skeleton width="100px" style={{ marginTop: "10px" }} data-testid="skeleton" />);
    const el = screen.getByTestId("skeleton");
    expect(el.style.width).toBe("100px");
    expect(el.style.marginTop).toBe("10px");
  });

  it("passes through HTML attributes", () => {
    render(<Skeleton data-testid="skeleton" id="my-skeleton" />);
    expect(screen.getByTestId("skeleton")).toHaveAttribute("id", "my-skeleton");
  });
});
