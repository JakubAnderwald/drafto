import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, CardHeader, CardBody, CardFooter } from "@/components/ui/card";

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText("Card content")).toBeInTheDocument();
  });

  it("renders as a div element", () => {
    render(<Card data-testid="card">content</Card>);
    const card = screen.getByTestId("card");
    expect(card.tagName).toBe("DIV");
  });

  it("applies default sm shadow", () => {
    render(<Card data-testid="card">content</Card>);
    const card = screen.getByTestId("card");
    expect(card.className).toContain("shadow-sm");
  });

  it("applies md shadow variant", () => {
    render(
      <Card shadow="md" data-testid="card">
        content
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card.className).toContain("shadow-md");
  });

  it("applies lg shadow variant", () => {
    render(
      <Card shadow="lg" data-testid="card">
        content
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card.className).toContain("shadow-lg");
  });

  it("applies border and background styles", () => {
    render(<Card data-testid="card">content</Card>);
    const card = screen.getByTestId("card");
    expect(card.className).toContain("bg-bg-subtle");
    expect(card.className).toContain("rounded-lg");
  });

  it("merges custom className", () => {
    render(
      <Card className="custom-class" data-testid="card">
        content
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card.className).toContain("custom-class");
  });

  it("forwards ref to div element", () => {
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    render(<Card ref={ref}>content</Card>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it("passes through HTML attributes", () => {
    render(
      <Card data-testid="card" role="region" aria-label="Test card">
        content
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card).toHaveAttribute("role", "region");
    expect(card).toHaveAttribute("aria-label", "Test card");
  });
});

describe("CardHeader", () => {
  it("renders children", () => {
    render(<CardHeader>Header</CardHeader>);
    expect(screen.getByText("Header")).toBeInTheDocument();
  });

  it("applies bottom border and padding", () => {
    render(<CardHeader data-testid="header">Header</CardHeader>);
    const header = screen.getByTestId("header");
    expect(header.className).toContain("px-6");
    expect(header.className).toContain("py-4");
  });

  it("merges custom className", () => {
    render(
      <CardHeader className="custom-header" data-testid="header">
        Header
      </CardHeader>,
    );
    expect(screen.getByTestId("header").className).toContain("custom-header");
  });

  it("forwards ref", () => {
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    render(<CardHeader ref={ref}>Header</CardHeader>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});

describe("CardBody", () => {
  it("renders children", () => {
    render(<CardBody>Body content</CardBody>);
    expect(screen.getByText("Body content")).toBeInTheDocument();
  });

  it("applies padding", () => {
    render(<CardBody data-testid="body">Body</CardBody>);
    const body = screen.getByTestId("body");
    expect(body.className).toContain("px-6");
    expect(body.className).toContain("py-4");
  });

  it("does not apply borders", () => {
    render(<CardBody data-testid="body">Body</CardBody>);
    const body = screen.getByTestId("body");
    expect(body.className).not.toContain("border");
  });

  it("merges custom className", () => {
    render(
      <CardBody className="custom-body" data-testid="body">
        Body
      </CardBody>,
    );
    expect(screen.getByTestId("body").className).toContain("custom-body");
  });

  it("forwards ref", () => {
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    render(<CardBody ref={ref}>Body</CardBody>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});

describe("CardFooter", () => {
  it("renders children", () => {
    render(<CardFooter>Footer</CardFooter>);
    expect(screen.getByText("Footer")).toBeInTheDocument();
  });

  it("applies top border and padding", () => {
    render(<CardFooter data-testid="footer">Footer</CardFooter>);
    const footer = screen.getByTestId("footer");
    expect(footer.className).toContain("px-6");
    expect(footer.className).toContain("py-4");
  });

  it("merges custom className", () => {
    render(
      <CardFooter className="custom-footer" data-testid="footer">
        Footer
      </CardFooter>,
    );
    expect(screen.getByTestId("footer").className).toContain("custom-footer");
  });

  it("forwards ref", () => {
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    render(<CardFooter ref={ref}>Footer</CardFooter>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});

describe("Card composition", () => {
  it("renders all slots together", () => {
    render(
      <Card data-testid="card">
        <CardHeader>My Header</CardHeader>
        <CardBody>My Body</CardBody>
        <CardFooter>My Footer</CardFooter>
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card).toBeInTheDocument();
    expect(screen.getByText("My Header")).toBeInTheDocument();
    expect(screen.getByText("My Body")).toBeInTheDocument();
    expect(screen.getByText("My Footer")).toBeInTheDocument();
  });

  it("works with only body slot", () => {
    render(
      <Card>
        <CardBody>Just body</CardBody>
      </Card>,
    );
    expect(screen.getByText("Just body")).toBeInTheDocument();
  });

  it("works with header and body only", () => {
    render(
      <Card>
        <CardHeader>Title</CardHeader>
        <CardBody>Content</CardBody>
      </Card>,
    );
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Content")).toBeInTheDocument();
  });
});
