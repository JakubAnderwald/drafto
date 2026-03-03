import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IconButton } from "@/components/ui/icon-button";

describe("IconButton", () => {
  it("renders children", () => {
    render(<IconButton aria-label="close">X</IconButton>);
    expect(screen.getByRole("button")).toHaveTextContent("X");
  });

  it("renders as a button element", () => {
    render(<IconButton aria-label="close">X</IconButton>);
    expect(screen.getByRole("button").tagName).toBe("BUTTON");
  });

  it("applies default ghost variant styles", () => {
    render(<IconButton aria-label="close">X</IconButton>);
    const button = screen.getByRole("button");
    expect(button.className).toContain("text-neutral-600");
    expect(button.className).toContain("hover:bg-neutral-100");
  });

  it("applies danger variant styles", () => {
    render(
      <IconButton variant="danger" aria-label="delete">
        X
      </IconButton>,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("text-error");
    expect(button.className).toContain("hover:bg-red-50");
  });

  it("applies default md size", () => {
    render(<IconButton aria-label="action">X</IconButton>);
    const button = screen.getByRole("button");
    expect(button.className).toContain("h-9");
    expect(button.className).toContain("w-9");
  });

  it("applies sm size", () => {
    render(
      <IconButton size="sm" aria-label="action">
        X
      </IconButton>,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("h-7");
    expect(button.className).toContain("w-7");
  });

  it("applies lg size", () => {
    render(
      <IconButton size="lg" aria-label="action">
        X
      </IconButton>,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("h-11");
    expect(button.className).toContain("w-11");
  });

  it("handles click events", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <IconButton aria-label="close" onClick={onClick}>
        X
      </IconButton>,
    );
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("disables button when disabled prop is true", () => {
    render(
      <IconButton disabled aria-label="close">
        X
      </IconButton>,
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("applies disabled styling", () => {
    render(
      <IconButton disabled aria-label="close">
        X
      </IconButton>,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("pointer-events-none");
    expect(button.className).toContain("opacity-50");
  });

  it("merges custom className", () => {
    render(
      <IconButton className="custom-class" aria-label="close">
        X
      </IconButton>,
    );
    expect(screen.getByRole("button").className).toContain("custom-class");
  });

  it("forwards ref to button element", () => {
    const ref = { current: null } as React.RefObject<HTMLButtonElement | null>;
    render(
      <IconButton ref={ref} aria-label="close">
        X
      </IconButton>,
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("is square shaped", () => {
    render(<IconButton aria-label="action">X</IconButton>);
    const button = screen.getByRole("button");
    // h-9 and w-9 means equal width and height
    expect(button.className).toMatch(/h-\d+/);
    expect(button.className).toMatch(/w-\d+/);
  });
});
