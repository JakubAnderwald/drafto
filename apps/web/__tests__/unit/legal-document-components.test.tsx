import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { outlineEntry, type OutlineEntry } from "@/components/legal/document-outline";
import { NumberedSection } from "@/components/legal/numbered-section";
import { TableOfContents } from "@/components/legal/table-of-contents";

const OUTLINE: readonly OutlineEntry[] = [
  { id: "first", title: "First Section" },
  { id: "second", title: "Second Section" },
];

describe("outlineEntry", () => {
  it("numbers a section by its position in the outline", () => {
    expect(outlineEntry(OUTLINE, "first")).toEqual({
      id: "first",
      title: "First Section",
      number: 1,
    });
    expect(outlineEntry(OUTLINE, "second").number).toBe(2);
  });

  it("throws for a section that is not in the outline", () => {
    expect(() => outlineEntry(OUTLINE, "missing")).toThrow("Unknown document section: missing");
  });
});

describe("NumberedSection", () => {
  it("renders a numbered h2 that labels the section it anchors", () => {
    render(
      <NumberedSection {...outlineEntry(OUTLINE, "second")}>
        <p>Body</p>
      </NumberedSection>,
    );

    const heading = screen.getByRole("heading", { level: 2, name: "2. Second Section" });
    const section = heading.closest("section") as HTMLElement;
    expect(section).toHaveAttribute("id", "second");
    expect(section).toHaveAttribute("aria-labelledby", heading.id);
    expect(heading.nextElementSibling).toHaveTextContent("Body");
  });
});

describe("TableOfContents", () => {
  it("links to each section in order", () => {
    render(<TableOfContents entries={OUTLINE} />);

    const nav = screen.getByRole("navigation", { name: "On this page" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["First Section", "#first"],
      ["Second Section", "#second"],
    ]);
    expect(within(nav).getAllByRole("listitem")[1]).toHaveTextContent("2. Second Section");
  });

  it("labels the navigation with its own heading, unique per instance", () => {
    render(
      <>
        <TableOfContents entries={OUTLINE} />
        <TableOfContents entries={OUTLINE} />
      </>,
    );

    const navs = screen.getAllByRole("navigation", { name: "On this page" });
    const ids = navs.map((nav) => nav.getAttribute("aria-labelledby"));
    expect(new Set(ids).size).toBe(2);
    for (const nav of navs) {
      const heading = within(nav).getByRole("heading", { level: 2, name: "On this page" });
      expect(nav).toHaveAttribute("aria-labelledby", heading.id);
    }
  });
});
