import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

describe("DropdownMenu", () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
  };

  it("renders children when open", () => {
    render(
      <DropdownMenu {...defaultProps}>
        <DropdownMenuItem>Item 1</DropdownMenuItem>
      </DropdownMenu>,
    );
    expect(screen.getByText("Item 1")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(
      <DropdownMenu open={false} onClose={vi.fn()}>
        <DropdownMenuItem>Item 1</DropdownMenuItem>
      </DropdownMenu>,
    );
    expect(screen.queryByText("Item 1")).not.toBeInTheDocument();
  });

  it("has menu role", () => {
    render(
      <DropdownMenu {...defaultProps}>
        <DropdownMenuItem>Item</DropdownMenuItem>
      </DropdownMenu>,
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("calls onClose when clicking outside", async () => {
    const onClose = vi.fn();
    render(
      <div>
        <button>Outside</button>
        <DropdownMenu open onClose={onClose}>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenu>
      </div>,
    );
    await userEvent.click(screen.getByText("Outside"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(
      <DropdownMenu open onClose={onClose}>
        <DropdownMenuItem>Item</DropdownMenuItem>
      </DropdownMenu>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when clicking inside", async () => {
    const onClose = vi.fn();
    render(
      <DropdownMenu open onClose={onClose}>
        <DropdownMenuItem>Item</DropdownMenuItem>
      </DropdownMenu>,
    );
    await userEvent.click(screen.getByText("Item"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("aligns right by default", () => {
    render(
      <DropdownMenu {...defaultProps}>
        <DropdownMenuItem>Item</DropdownMenuItem>
      </DropdownMenu>,
    );
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("right-0");
  });

  it("aligns left when specified", () => {
    render(
      <DropdownMenu {...defaultProps} align="left">
        <DropdownMenuItem>Item</DropdownMenuItem>
      </DropdownMenu>,
    );
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("left-0");
  });

  it("merges custom className", () => {
    render(
      <DropdownMenu {...defaultProps} className="custom-menu">
        <DropdownMenuItem>Item</DropdownMenuItem>
      </DropdownMenu>,
    );
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("custom-menu");
  });

  it("passes through HTML attributes", () => {
    render(
      <DropdownMenu {...defaultProps} data-testid="dropdown">
        <DropdownMenuItem>Item</DropdownMenuItem>
      </DropdownMenu>,
    );
    expect(screen.getByTestId("dropdown")).toBeInTheDocument();
  });
});

describe("DropdownMenuItem", () => {
  it("renders children text", () => {
    render(<DropdownMenuItem>Delete</DropdownMenuItem>);
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("has menuitem role", () => {
    render(<DropdownMenuItem>Action</DropdownMenuItem>);
    expect(screen.getByRole("menuitem")).toBeInTheDocument();
  });

  it("calls onClick when clicked", async () => {
    const onClick = vi.fn();
    render(<DropdownMenuItem onClick={onClick}>Action</DropdownMenuItem>);
    await userEvent.click(screen.getByRole("menuitem"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("applies default variant styles", () => {
    render(<DropdownMenuItem>Item</DropdownMenuItem>);
    const item = screen.getByRole("menuitem");
    expect(item.className).toContain("text-fg");
  });

  it("applies danger variant styles", () => {
    render(<DropdownMenuItem variant="danger">Delete</DropdownMenuItem>);
    const item = screen.getByRole("menuitem");
    expect(item.className).toContain("text-error");
  });

  it("merges custom className", () => {
    render(<DropdownMenuItem className="custom-item">Item</DropdownMenuItem>);
    const item = screen.getByRole("menuitem");
    expect(item.className).toContain("custom-item");
  });

  it("forwards ref", () => {
    const ref = { current: null } as React.RefObject<HTMLButtonElement | null>;
    render(<DropdownMenuItem ref={ref}>Item</DropdownMenuItem>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("has type button", () => {
    render(<DropdownMenuItem>Item</DropdownMenuItem>);
    expect(screen.getByRole("menuitem")).toHaveAttribute("type", "button");
  });
});

describe("DropdownMenuLabel", () => {
  it("renders label text", () => {
    render(<DropdownMenuLabel>Move to...</DropdownMenuLabel>);
    expect(screen.getByText("Move to...")).toBeInTheDocument();
  });

  it("renders as a paragraph", () => {
    render(<DropdownMenuLabel data-testid="label">Label</DropdownMenuLabel>);
    const label = screen.getByTestId("label");
    expect(label.tagName).toBe("P");
  });

  it("merges custom className", () => {
    render(
      <DropdownMenuLabel className="custom-label" data-testid="label">
        Label
      </DropdownMenuLabel>,
    );
    expect(screen.getByTestId("label").className).toContain("custom-label");
  });

  it("forwards ref", () => {
    const ref = { current: null } as React.RefObject<HTMLParagraphElement | null>;
    render(<DropdownMenuLabel ref={ref}>Label</DropdownMenuLabel>);
    expect(ref.current).toBeInstanceOf(HTMLParagraphElement);
  });
});

describe("DropdownMenuSeparator", () => {
  it("renders with separator role", () => {
    render(<DropdownMenuSeparator />);
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("renders as an hr element", () => {
    const { container } = render(<DropdownMenuSeparator />);
    expect(container.querySelector("hr")).toBeInTheDocument();
  });

  it("merges custom className", () => {
    render(<DropdownMenuSeparator data-testid="sep" className="custom-sep" />);
    expect(screen.getByTestId("sep").className).toContain("custom-sep");
  });

  it("forwards ref", () => {
    const ref = { current: null } as React.RefObject<HTMLHRElement | null>;
    render(<DropdownMenuSeparator ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLHRElement);
  });
});

describe("DropdownMenu composition", () => {
  it("renders a full dropdown with items, labels, and separators", () => {
    render(
      <DropdownMenu open onClose={vi.fn()}>
        <DropdownMenuItem variant="danger">Delete</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Move to...</DropdownMenuLabel>
        <DropdownMenuItem>Notebook A</DropdownMenuItem>
        <DropdownMenuItem>Notebook B</DropdownMenuItem>
      </DropdownMenu>,
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByText("Move to...")).toBeInTheDocument();
  });
});
