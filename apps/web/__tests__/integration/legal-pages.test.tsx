import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import SupportPage from "@/app/support/page";
import PrivacyPolicyPage from "@/app/privacy/page";

describe("Support page", () => {
  it("describes the in-app deletion flow before the email fallback", () => {
    render(<SupportPage />);

    const heading = screen.getByRole("heading", { level: 3, name: "How do I delete my account?" });
    // The answer is every sibling after the question, up to the next question (if any).
    const answer: string[] = [];
    let el = heading.nextElementSibling;
    while (el && el.tagName !== "H3") {
      answer.push(el.textContent ?? "");
      el = el.nextElementSibling;
    }
    const text = answer.join(" ");

    expect(text).toMatch(/Web:.*Settings.*Delete account/);
    expect(text).toMatch(/iPhone, iPad and Android:.*Settings.*Delete account/);
    expect(text).toMatch(/Mac:.*⋯.*sidebar.*choose Delete account\./);
    expect(text.indexOf("Delete account")).toBeLessThan(text.indexOf("support@drafto.eu"));
    expect(text).toMatch(/within 30 days/);
  });

  it("links to the account deletion page from the answer and the footer", () => {
    render(<SupportPage />);

    expect(screen.getByRole("link", { name: "how to delete your account" })).toHaveAttribute(
      "href",
      "/account/delete",
    );
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "Delete your account" })).toHaveAttribute(
      "href",
      "/account/delete",
    );
    expect(within(footer).getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });

  it("only points to the support@drafto.eu mailbox", () => {
    render(<SupportPage />);

    const mailtos = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.startsWith("mailto:"));
    expect(mailtos.length).toBeGreaterThan(0);
    expect(new Set(mailtos)).toEqual(new Set(["mailto:support@drafto.eu"]));
    expect(document.body.innerHTML).not.toContain("privacy@drafto.eu");
  });
});

describe("Privacy policy page", () => {
  it("shows the updated date and keeps the effective date", () => {
    render(<PrivacyPolicyPage />);

    expect(screen.getByText(/Effective date: March 8, 2026/)).toHaveTextContent(
      "Last updated: September 14, 2026",
    );
  });

  it("scopes PostHog and Sentry to the web app and says the native apps send no analytics", () => {
    render(<PrivacyPolicyPage />);

    expect(screen.getByText(/When you use the web app at drafto.eu/)).toHaveTextContent(
      /PostHog.*Sentry/,
    );
    expect(
      screen.getByText(
        /The iOS, Android and macOS apps contain no analytics or crash-reporting SDK/,
      ),
    ).toBeInTheDocument();

    const rowFor = (service: string) =>
      screen.getByRole("cell", { name: service }).closest("tr") as HTMLElement;
    expect(rowFor("PostHog")).toHaveTextContent("web app only");
    expect(rowFor("Sentry")).toHaveTextContent("web app and drafto.eu servers only");
  });

  it("describes immediate in-app deletion and links to the deletion page", () => {
    render(<PrivacyPolicyPage />);

    expect(screen.getByText(/Deletion is immediate/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /When you delete your account in the app, we immediately delete your account, notebooks, notes, attachments and API keys/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/by email, we process the request within 30 days/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "how to delete your account" })).toHaveAttribute(
      "href",
      "/account/delete",
    );

    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "Delete your account" })).toHaveAttribute(
      "href",
      "/account/delete",
    );
    expect(within(footer).getByRole("link", { name: "Support" })).toHaveAttribute(
      "href",
      "/support",
    );
  });

  it("uses support@drafto.eu as the contact address", () => {
    render(<PrivacyPolicyPage />);

    expect(screen.getByRole("link", { name: "support@drafto.eu" })).toHaveAttribute(
      "href",
      "mailto:support@drafto.eu",
    );
    expect(document.body.innerHTML).not.toContain("privacy@drafto.eu");
  });
});
