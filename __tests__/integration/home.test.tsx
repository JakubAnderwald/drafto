import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";

describe("Home page", () => {
  it("renders the heading", async () => {
    await act(async () => {
      render(<Home />);
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Drafto - Notes App");
  });

  it("renders the tagline", async () => {
    await act(async () => {
      render(<Home />);
    });
    expect(screen.getByText("Your notes, organized.")).toBeInTheDocument();
  });
});
