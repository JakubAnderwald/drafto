import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PRIVACY_POLICY_URL, SUPPORT_URL } from "@drafto/shared";
import { LEGAL_PAGES } from "@/components/legal/legal-pages";
import { LegalLinks } from "@/components/legal/legal-links";
import { AboutSection } from "@/components/settings/about-section";

function linksOf(container: HTMLElement) {
  return within(container)
    .getAllByRole("link")
    .map((link) => ({ name: link.textContent, href: link.getAttribute("href") }));
}

describe("legal page links", () => {
  it("PrimeTestLab 11035 S-01: link the same paths the mobile About URLs end in", () => {
    expect(LEGAL_PAGES.map((page) => page.href)).toEqual([
      new URL(PRIVACY_POLICY_URL).pathname,
      new URL(SUPPORT_URL).pathname,
    ]);
  });

  it("PrimeTestLab 11035 S-01: the About card and the signed-out LegalLinks show the same links", () => {
    const { container: legal } = render(<LegalLinks />);
    const { container: about } = render(<AboutSection />);

    const expected = [
      { name: "Privacy Policy", href: "/privacy" },
      { name: "Support", href: "/support" },
    ];
    expect(linksOf(legal)).toEqual(expected);
    expect(linksOf(about)).toEqual(expected);
    expect(screen.getByTestId("about-privacy")).toHaveAttribute("href", "/privacy");
    expect(screen.getByTestId("about-support")).toHaveAttribute("href", "/support");
  });
});
