import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

describe("Input", () => {
  it("renders an input element", () => {
    render(<Input aria-label="test input" />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("applies default md size styles", () => {
    render(<Input aria-label="test" />);
    const input = screen.getByRole("textbox");
    expect(input.className).toContain("py-2");
    expect(input.className).toContain("rounded-lg");
  });

  it("applies sm size styles", () => {
    render(<Input inputSize="sm" aria-label="test" />);
    const input = screen.getByRole("textbox");
    expect(input.className).toContain("py-1");
    expect(input.className).toContain("rounded-md");
  });

  it("applies lg size styles", () => {
    render(<Input inputSize="lg" aria-label="test" />);
    const input = screen.getByRole("textbox");
    expect(input.className).toContain("py-2.5");
  });

  it("applies error border when error is true", () => {
    render(<Input error aria-label="test" />);
    const input = screen.getByRole("textbox");
    expect(input.className).toContain("border-error");
  });

  it("applies normal border when error is false", () => {
    render(<Input aria-label="test" />);
    const input = screen.getByRole("textbox");
    expect(input.className).toContain("border-border");
  });

  it("disables input when disabled prop is true", () => {
    render(<Input disabled aria-label="test" />);
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("accepts user input", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="test" />);
    const input = screen.getByRole("textbox");
    await user.type(input, "hello");
    expect(input).toHaveValue("hello");
  });

  it("calls onChange when typing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input aria-label="test" onChange={onChange} />);
    await user.type(screen.getByRole("textbox"), "a");
    expect(onChange).toHaveBeenCalled();
  });

  it("merges custom className", () => {
    render(<Input className="custom-class" aria-label="test" />);
    const input = screen.getByRole("textbox");
    expect(input.className).toContain("custom-class");
  });

  it("forwards ref to input element", () => {
    const ref = { current: null } as React.RefObject<HTMLInputElement | null>;
    render(<Input ref={ref} aria-label="test" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it("passes through placeholder", () => {
    render(<Input placeholder="Enter text..." aria-label="test" />);
    expect(screen.getByPlaceholderText("Enter text...")).toBeInTheDocument();
  });

  it("supports type prop", () => {
    render(<Input type="password" aria-label="password" />);
    const input = document.querySelector('input[type="password"]');
    expect(input).toBeInTheDocument();
  });
});

describe("Label", () => {
  it("renders label text", () => {
    render(<Label>Email</Label>);
    expect(screen.getByText("Email")).toBeInTheDocument();
  });

  it("renders as a label element", () => {
    render(<Label htmlFor="email">Email</Label>);
    const label = screen.getByText("Email");
    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveAttribute("for", "email");
  });

  it("applies muted text styling", () => {
    render(<Label>Email</Label>);
    const label = screen.getByText("Email");
    expect(label.className).toContain("text-fg-muted");
  });

  it("shows required indicator when required is true", () => {
    render(<Label required>Email</Label>);
    const asterisk = screen.getByText("*");
    expect(asterisk).toBeInTheDocument();
    expect(asterisk.className).toContain("text-error");
  });

  it("does not show required indicator by default", () => {
    render(<Label>Email</Label>);
    expect(screen.queryByText("*")).not.toBeInTheDocument();
  });

  it("merges custom className", () => {
    render(<Label className="custom-class">Email</Label>);
    const label = screen.getByText("Email");
    expect(label.className).toContain("custom-class");
  });

  it("forwards ref to label element", () => {
    const ref = { current: null } as React.RefObject<HTMLLabelElement | null>;
    render(<Label ref={ref}>Email</Label>);
    expect(ref.current).toBeInstanceOf(HTMLLabelElement);
  });

  it("associates with input via htmlFor", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Label htmlFor="test-input">Click me</Label>
        <input id="test-input" />
      </>,
    );
    await user.click(screen.getByText("Click me"));
    expect(document.getElementById("test-input")).toHaveFocus();
  });
});
