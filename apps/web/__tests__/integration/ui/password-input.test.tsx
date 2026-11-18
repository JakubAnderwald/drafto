import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PASSWORD_VISIBILITY_LABELS } from "@drafto/shared";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";

function renderField(props: Partial<Parameters<typeof PasswordInput>[0]> = {}) {
  return render(
    <>
      <Label htmlFor="pw">Password</Label>
      <PasswordInput id="pw" {...props} />
    </>,
  );
}

describe("PasswordInput", () => {
  it("hides the value by default and offers to show it", () => {
    renderField();

    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    const toggle = screen.getByRole("button", { name: PASSWORD_VISIBILITY_LABELS.show });
    expect(toggle).toHaveAttribute("aria-controls", "pw");
    expect(toggle).toHaveAttribute("data-testid", "pw-toggle");
    expect(toggle.querySelector('[data-icon="eye"]')).not.toBeNull();
  });

  it("shows and hides the value when the toggle is clicked", async () => {
    const user = userEvent.setup();
    renderField();

    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    const hide = screen.getByRole("button", { name: PASSWORD_VISIBILITY_LABELS.hide });
    expect(hide.querySelector('[data-icon="eye-off"]')).not.toBeNull();

    await user.click(hide);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeInTheDocument();
  });

  it("never submits the surrounding form when toggled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput id="pw" aria-label="Password" />
      </form>,
    );

    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("type", "button");
  });

  it("goes back to hidden when its form submits", async () => {
    const user = userEvent.setup();
    render(
      <form onSubmit={(e) => e.preventDefault()}>
        <PasswordInput id="pw" aria-label="Password" />
        <button type="submit">Go</button>
      </form>,
    );

    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");

    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  });

  it("keeps autofill and validation attributes in both states", async () => {
    const user = userEvent.setup();
    renderField({ name: "password", autoComplete: "new-password", required: true, minLength: 6 });

    const assertAttrs = () => {
      const input = screen.getByLabelText("Password");
      expect(input).toHaveAttribute("id", "pw");
      expect(input).toHaveAttribute("name", "password");
      expect(input).toHaveAttribute("autocomplete", "new-password");
      expect(input).toBeRequired();
      expect(input).toHaveAttribute("minlength", "6");
    };

    assertAttrs();
    await user.click(screen.getByRole("button", { name: "Show password" }));
    assertAttrs();
  });

  it("keeps the typed value when toggled", async () => {
    const user = userEvent.setup();
    renderField();

    await user.type(screen.getByLabelText("Password"), "visibility-check-123");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("Password")).toHaveValue("visibility-check-123");
  });

  it("disables the toggle with the input", () => {
    renderField({ disabled: true });

    expect(screen.getByLabelText("Password")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show password" })).toBeDisabled();
  });

  it("puts wrapper classes on the wrapper and input classes on the input", () => {
    renderField({ wrapperClassName: "mt-1", className: "custom-input" });

    const input = screen.getByLabelText("Password");
    expect(input.className).toContain("custom-input");
    expect(input.className).toContain("pr-10");
    expect(input.parentElement?.className).toContain("mt-1");
    expect(input.parentElement?.className).toContain("relative");
  });

  it("forwards an object ref to the input", () => {
    const ref = createRef<HTMLInputElement>();
    render(<PasswordInput id="pw" aria-label="Password" ref={ref} />);

    expect(ref.current).toBe(screen.getByLabelText("Password"));
  });

  it("forwards a callback ref to the input", () => {
    const ref = vi.fn();
    render(<PasswordInput id="pw" aria-label="Password" ref={ref} />);

    expect(ref).toHaveBeenCalledWith(screen.getByLabelText("Password"));
  });

  it("passes change events through", () => {
    const onChange = vi.fn();
    renderField({ onChange });

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("has no toggle test id when the field has no id", () => {
    render(<PasswordInput aria-label="Password" />);

    expect(screen.getByRole("button", { name: "Show password" })).not.toHaveAttribute(
      "data-testid",
    );
  });
});
