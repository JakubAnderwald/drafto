import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

describe("ConfirmDialog", () => {
  const defaultProps = {
    title: "Delete this item?",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it("renders title", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText("Delete this item?")).toBeInTheDocument();
  });

  it("has alertdialog role", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("uses title as aria-label", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByRole("alertdialog")).toHaveAttribute("aria-label", "Delete this item?");
  });

  it("renders default confirm and cancel labels", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("renders custom confirm and cancel labels", () => {
    render(<ConfirmDialog {...defaultProps} confirmLabel="Delete" cancelLabel="Keep" />);
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep" })).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button is clicked", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when cancel button is clicked", async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("renders children as description", () => {
    render(<ConfirmDialog {...defaultProps}>This action cannot be undone.</ConfirmDialog>);
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });

  it("renders error message with alert role", () => {
    render(<ConfirmDialog {...defaultProps} error="Something went wrong" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
  });

  it("does not render error when error is null", () => {
    render(<ConfirmDialog {...defaultProps} error={null} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not render error when error is not provided", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows loading state on confirm button", () => {
    render(<ConfirmDialog {...defaultProps} loading confirmLabel="Delete" />);
    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    expect(confirmBtn).toBeDisabled();
  });

  it("does not disable cancel button when loading", () => {
    render(<ConfirmDialog {...defaultProps} loading />);
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(cancelBtn).not.toBeDisabled();
  });

  it("merges custom className", () => {
    render(<ConfirmDialog {...defaultProps} className="custom-class" />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.className).toContain("custom-class");
  });

  it("forwards ref", () => {
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    render(<ConfirmDialog {...defaultProps} ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it("passes through HTML attributes", () => {
    render(<ConfirmDialog {...defaultProps} data-testid="confirm-dialog" />);
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
  });

  it("applies danger variant by default", () => {
    render(<ConfirmDialog {...defaultProps} confirmLabel="Delete" />);
    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    expect(confirmBtn.className).toContain("bg-error");
  });

  it("applies primary variant for warning", () => {
    render(<ConfirmDialog {...defaultProps} variant="warning" confirmLabel="Proceed" />);
    const confirmBtn = screen.getByRole("button", { name: "Proceed" });
    expect(confirmBtn.className).toContain("bg-primary-600");
  });
});
