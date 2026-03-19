import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import DesignSystemPage from "@/app/design-system/page";

describe("DesignSystemPage", () => {
  it("renders all design token sections", () => {
    render(<DesignSystemPage />);

    expect(screen.getByText("Color Scales")).toBeInTheDocument();
    expect(screen.getByText("Semantic Surfaces")).toBeInTheDocument();
    expect(screen.getByText("Status Colors")).toBeInTheDocument();
    expect(screen.getByText("Typography")).toBeInTheDocument();
    expect(screen.getByText("Shadows")).toBeInTheDocument();
    expect(screen.getByText("Border Radius")).toBeInTheDocument();
  });

  it("renders all component sections", () => {
    render(<DesignSystemPage />);

    expect(screen.getByText("Button")).toBeInTheDocument();
    expect(screen.getByText("IconButton")).toBeInTheDocument();
    expect(screen.getByText("Input & Label")).toBeInTheDocument();
    expect(screen.getByText("Badge")).toBeInTheDocument();
    expect(screen.getByText("Card")).toBeInTheDocument();
    expect(screen.getByText("Skeleton")).toBeInTheDocument();
    expect(screen.getByText("DropdownMenu")).toBeInTheDocument();
    expect(screen.getByText("ConfirmDialog")).toBeInTheDocument();
  });

  it("renders color scale swatches", () => {
    render(<DesignSystemPage />);

    expect(screen.getByText("Primary (Indigo)")).toBeInTheDocument();
    expect(screen.getByText("Secondary (Amber)")).toBeInTheDocument();
    expect(screen.getByText("Neutral (Stone)")).toBeInTheDocument();
  });

  it("renders semantic surface swatches", () => {
    render(<DesignSystemPage />);

    expect(screen.getByText("Background")).toBeInTheDocument();
    expect(screen.getByText("Foreground")).toBeInTheDocument();
    expect(screen.getByText("Ring / Focus")).toBeInTheDocument();
  });

  it("renders button variants", () => {
    render(<DesignSystemPage />);

    expect(screen.getByRole("button", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Secondary" })).toBeInTheDocument();
    // "Danger" and "Success" text also appears in Badge and Status sections
    expect(screen.getAllByRole("button", { name: "Danger" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("button", { name: "Success" }).length).toBeGreaterThanOrEqual(1);
  });

  it("renders button sizes", () => {
    render(<DesignSystemPage />);

    expect(screen.getByRole("button", { name: "Small" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Medium" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Large" })).toBeInTheDocument();
  });

  it("renders button states", () => {
    render(<DesignSystemPage />);

    expect(screen.getByRole("button", { name: "Loading" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disabled" })).toBeDisabled();
  });

  it("renders badge variants", () => {
    render(<DesignSystemPage />);

    expect(screen.getByText("Default")).toBeInTheDocument();
    // These labels appear in both Badge and Status Colors sections (and buttons),
    // so we verify at least 2 matches exist
    expect(screen.getAllByText("Warning").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Success").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Error").length).toBeGreaterThanOrEqual(2);
  });

  it("renders input sizes and error state", () => {
    render(<DesignSystemPage />);

    expect(screen.getByPlaceholderText("Small...")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Medium...")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Large...")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Something went wrong...")).toBeInTheDocument();
  });

  it("renders required label with asterisk", () => {
    render(<DesignSystemPage />);

    const requiredLabel = screen.getByText("Medium input (required)");
    const asterisk = requiredLabel.parentElement?.querySelector("span");
    expect(asterisk).toHaveTextContent("*");
  });

  it("renders card with shadow variants", () => {
    render(<DesignSystemPage />);

    expect(screen.getByText("Card — shadow-sm")).toBeInTheDocument();
    expect(screen.getByText("Card — shadow-md")).toBeInTheDocument();
    expect(screen.getByText("Card — shadow-lg")).toBeInTheDocument();
  });

  it("renders skeleton loading placeholders", () => {
    render(<DesignSystemPage />);

    const skeletons = screen.getAllByRole("status");
    expect(skeletons.length).toBeGreaterThanOrEqual(5);
  });

  it("opens dropdown menu on click", async () => {
    const user = userEvent.setup();
    render(<DesignSystemPage />);

    const openButton = screen.getByRole("button", { name: "Open menu" });
    await user.click(openButton);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Duplicate")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("shows confirm dialog and dismisses on cancel", async () => {
    const user = userEvent.setup();
    render(<DesignSystemPage />);

    const showButton = screen.getByRole("button", { name: "Show confirm dialog" });
    await user.click(showButton);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Delete this item?")).toBeInTheDocument();

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelButton);

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows confirm dialog and dismisses on confirm", async () => {
    const user = userEvent.setup();
    render(<DesignSystemPage />);

    await user.click(screen.getByRole("button", { name: "Show confirm dialog" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("closes dropdown menu items on click", async () => {
    const user = userEvent.setup();
    render(<DesignSystemPage />);

    await user.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(screen.getByText("Edit"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("renders typography samples", () => {
    render(<DesignSystemPage />);

    expect(screen.getByText("Heading 1 — The quick brown fox")).toBeInTheDocument();
    expect(screen.getByText(/const greeting/)).toBeInTheDocument();
  });

  it("renders shadow demos", () => {
    render(<DesignSystemPage />);

    expect(screen.getByText("shadow-xs")).toBeInTheDocument();
    expect(screen.getByText("shadow-lg")).toBeInTheDocument();
  });

  it("renders radius demos", () => {
    render(<DesignSystemPage />);

    expect(screen.getByText(/^sm \(0\.375rem\)$/)).toBeInTheDocument();
    expect(screen.getByText(/^full \(9999px\)$/)).toBeInTheDocument();
  });
});
