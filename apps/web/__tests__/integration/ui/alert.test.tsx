import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Alert } from "@/components/ui/alert";

describe("Alert", () => {
  it("renders children inside a role=alert element", () => {
    render(<Alert>Couldn&apos;t save the note.</Alert>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save the note.");
  });

  it("applies the error tone", () => {
    render(<Alert>Failed</Alert>);
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("bg-error-bg");
    expect(alert.className).toContain("text-error-text");
  });

  it("renders no buttons by default", () => {
    render(<Alert>Failed</Alert>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onDismiss when Dismiss is clicked", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Alert onDismiss={onDismiss}>Failed</Alert>);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders the action label and calls its onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Alert action={{ label: "Retry", onClick }}>Failed</Alert>);

    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders both the action and Dismiss buttons", () => {
    render(
      <Alert action={{ label: "Retry", onClick: vi.fn() }} onDismiss={vi.fn()}>
        Failed
      </Alert>,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("merges custom className", () => {
    render(<Alert className="custom-class">Failed</Alert>);
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("custom-class");
    expect(alert.className).toContain("bg-error-bg");
  });

  it("passes through HTML attributes", () => {
    render(
      <Alert data-testid="alert" aria-live="assertive">
        Failed
      </Alert>,
    );
    expect(screen.getByTestId("alert")).toHaveAttribute("aria-live", "assertive");
  });
});
