import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DropdownMenu, DropdownMenuItem } from "@/components/ui/dropdown-menu";

interface HarnessProps {
  onClose: () => void;
  withTriggerRef: boolean;
  open?: boolean;
}

/** A trigger, an open menu and an element outside both. */
function Harness({ onClose, withTriggerRef, open = true }: HarnessProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={triggerRef} type="button" data-testid="trigger">
        <span data-testid="trigger-icon">...</span>
      </button>
      <button type="button" data-testid="outside">
        Outside
      </button>
      <DropdownMenu
        open={open}
        onClose={onClose}
        triggerRef={withTriggerRef ? triggerRef : undefined}
        data-testid="menu"
      >
        <DropdownMenuItem>Item</DropdownMenuItem>
      </DropdownMenu>
    </div>
  );
}

/** A trigger whose click toggles the menu, like AppMenu and the note-list row menus. */
function ToggleHarness({ withTriggerRef }: { withTriggerRef: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        data-testid="trigger"
        onClick={() => setOpen((prev) => !prev)}
      >
        Toggle
      </button>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={withTriggerRef ? triggerRef : undefined}
      >
        <DropdownMenuItem>Item</DropdownMenuItem>
      </DropdownMenu>
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DropdownMenu outside-click handling", () => {
  it("with triggerRef, a mousedown on the trigger does not close the menu", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} withTriggerRef />);

    fireEvent.mouseDown(screen.getByTestId("trigger"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("with triggerRef, a mousedown on an element inside the trigger does not close the menu", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} withTriggerRef />);

    fireEvent.mouseDown(screen.getByTestId("trigger-icon"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("with triggerRef, a mousedown outside the menu and trigger closes the menu", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} withTriggerRef />);

    fireEvent.mouseDown(screen.getByTestId("outside"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a mousedown inside the menu", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} withTriggerRef />);

    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Item" }));
    fireEvent.mouseDown(screen.getByRole("menu"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("without triggerRef, a mousedown on the trigger still closes the menu", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} withTriggerRef={false} />);

    fireEvent.mouseDown(screen.getByTestId("trigger"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not listen for mousedowns while closed", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} withTriggerRef open={false} />);

    fireEvent.mouseDown(screen.getByTestId("outside"));

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("DropdownMenu keyboard handling", () => {
  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} withTriggerRef />);

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} withTriggerRef />);

    fireEvent.keyDown(document, { key: "Enter" });

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("DropdownMenu triggerRef prop", () => {
  it("does not reach the DOM", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Harness onClose={vi.fn()} withTriggerRef />);

    const menu = screen.getByTestId("menu");
    expect(menu).not.toHaveAttribute("triggerRef");
    expect(menu).not.toHaveAttribute("triggerref");
    const unknownPropWarnings = consoleError.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === "string" && /triggerref/i.test(arg)),
    );
    expect(unknownPropWarnings).toEqual([]);
  });
});

describe("DropdownMenu toggled by its trigger", () => {
  it("with triggerRef, a second trigger click closes the menu and it stays closed", async () => {
    const user = userEvent.setup();
    render(<ToggleHarness withTriggerRef />);
    const trigger = screen.getByTestId("trigger");

    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("without triggerRef, the trigger's mousedown closes the menu and its click reopens it", async () => {
    // The behaviour triggerRef exists to prevent: the outside-click handler closes the menu on
    // mousedown, then the trigger's click toggles it straight back open.
    const user = userEvent.setup();
    render(<ToggleHarness withTriggerRef={false} />);
    const trigger = screen.getByTestId("trigger");

    await user.click(trigger);
    await user.click(trigger);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
