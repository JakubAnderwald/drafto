import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import DeleteAccountInfoPage, { metadata } from "@/app/account/delete/page";

describe("Account deletion page (/account/delete)", () => {
  it("has a descriptive page title", () => {
    expect(metadata.title).toBe("Delete your account — Drafto");
  });

  it("renders the page heading and every section", () => {
    render(<DeleteAccountInfoPage />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Delete your account");
    for (const name of [
      "Delete your account in the app",
      "What is deleted",
      "What may be kept",
      "No longer have the app, or can't sign in?",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("explains the in-app steps for every platform", () => {
    render(<DeleteAccountInfoPage />);

    for (const name of ["Web (drafto.eu)", "iPhone, iPad and Android", "Mac"]) {
      const heading = screen.getByRole("heading", { level: 3, name });
      const steps = heading.nextElementSibling as HTMLElement;
      expect(steps.tagName).toBe("OL");
      expect(steps).toHaveTextContent("Delete account");
      expect(steps).toHaveTextContent("DELETE");
    }
    // On the Mac, account actions sit behind the sidebar's ⋯ app menu.
    const macSteps = screen.getByRole("heading", { level: 3, name: "Mac" })
      .nextElementSibling as HTMLElement;
    expect(macSteps).toHaveTextContent(/⋯.*Choose Delete account\./);
    expect(macSteps).not.toHaveTextContent(/Sign out/);
    expect(screen.getByText(/needs an internet connection/)).toBeInTheDocument();
    expect(screen.getByText(/immediate and permanent/)).toBeInTheDocument();
  });

  it("lists everything that is deleted", () => {
    render(<DeleteAccountInfoPage />);

    const list = screen.getByRole("heading", { level: 2, name: "What is deleted" })
      .nextElementSibling as HTMLElement;
    const items = within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toEqual([
      expect.stringMatching(/account/),
      expect.stringMatching(/notebooks/),
      expect.stringMatching(/notes/),
      expect.stringMatching(/attachments/),
      expect.stringMatching(/API keys/),
    ]);
  });

  it("states what may be kept, per the privacy policy", () => {
    render(<DeleteAccountInfoPage />);

    const kept = screen.getByRole("heading", { level: 2, name: "What may be kept" })
      .nextElementSibling as HTMLElement;
    // Mirrors the privacy policy's retention section; there is no analytics data to keep.
    expect(kept).toHaveTextContent(/error reports in Sentry/);
    expect(kept).toHaveTextContent(/GitHub issues filed from your support emails/);
    // An app whose session ends because the account is gone keeps its copy, so the advice is
    // to sign out first, or uninstall afterwards.
    expect(kept).toHaveTextContent(
      /Before you delete your account, sign out of Drafto on your other devices to erase their local copies/,
    );
    expect(kept).toHaveTextContent(/if you have already deleted it, uninstall the app there/);
    expect(kept).not.toHaveTextContent(/analytics/i);
    expect(within(kept).getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });

  it("offers the support@drafto.eu email fallback", () => {
    render(<DeleteAccountInfoPage />);

    expect(screen.getByRole("link", { name: "support@drafto.eu" })).toHaveAttribute(
      "href",
      "mailto:support@drafto.eu",
    );
    expect(screen.getByText(/within 30 days/)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("privacy@drafto.eu");
  });

  it("links to the privacy policy and support page in the footer", () => {
    render(<DeleteAccountInfoPage />);

    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(within(footer).getByRole("link", { name: "Support" })).toHaveAttribute(
      "href",
      "/support",
    );
  });
});
