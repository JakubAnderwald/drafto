import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProgressBar } from "@/components/ui/progress-bar";

function fill(): HTMLElement {
  return screen.getByTestId("progress-bar-fill");
}

describe("ProgressBar", () => {
  it("is an accessible progressbar named by its label", () => {
    render(<ProgressBar value={0.5} label="Storage used" />);

    const bar = screen.getByRole("progressbar", { name: "Storage used" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(fill()).toHaveStyle({ width: "50%" });
  });

  it("rounds the value to a whole percent", () => {
    render(<ProgressBar value={0.248} label="Progress" />);

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(fill()).toHaveStyle({ width: "25%" });
  });

  it.each([
    { value: 1.7, percent: "100" },
    { value: 1, percent: "100" },
    { value: 0, percent: "0" },
    { value: -0.3, percent: "0" },
    { value: Number.NaN, percent: "0" },
    { value: Number.POSITIVE_INFINITY, percent: "0" },
  ])("clamps $value to $percent%", ({ value, percent }) => {
    render(<ProgressBar value={value} label="Progress" />);

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", percent);
    expect(fill()).toHaveStyle({ width: `${percent}%` });
  });

  it("uses a muted track and the primary fill by default", () => {
    render(<ProgressBar value={0.3} label="Progress" />);

    expect(screen.getByRole("progressbar")).toHaveClass("bg-bg-muted", "rounded-full");
    expect(fill()).toHaveClass("bg-primary-500");
  });

  it.each([
    { tone: "default", className: "bg-primary-500" },
    { tone: "warning", className: "bg-warning" },
    { tone: "danger", className: "bg-error" },
  ] as const)("fills with $className for the $tone tone", ({ tone, className }) => {
    render(<ProgressBar value={0.95} tone={tone} label="Progress" />);

    expect(fill()).toHaveClass(className);
    for (const other of ["bg-primary-500", "bg-warning", "bg-error"].filter(
      (c) => c !== className,
    )) {
      expect(fill()).not.toHaveClass(other);
    }
  });

  it("merges a className onto the track", () => {
    render(<ProgressBar value={0.3} label="Progress" className="mt-2" />);

    expect(screen.getByRole("progressbar")).toHaveClass("mt-2", "bg-bg-muted");
  });
});
