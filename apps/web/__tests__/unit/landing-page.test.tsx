import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import WelcomePage from "@/app/welcome/page";
import { FeatureList, LANDING_FEATURES } from "@/components/landing/feature-list";
import { APP_STORE_URL, GOOGLE_PLAY_PUBLIC } from "@/lib/store-links";

describe("Landing page", () => {
  it("says what Drafto is", () => {
    render(<WelcomePage />);

    expect(screen.getByRole("heading", { level: 1, name: "Drafto" })).toBeInTheDocument();
    expect(
      screen.getByText(/note-taking app for the web, iPhone, iPad, Android and Mac/),
    ).toBeInTheDocument();
  });

  it("leads to sign-up and login, and no longer says new accounts need approval", () => {
    render(<WelcomePage />);

    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    expect(screen.queryByText(/approved by hand/)).not.toBeInTheDocument();
  });

  it("shows the store badges in the hero", () => {
    render(<WelcomePage />);

    const badges = screen.getByRole("list", { name: "Get the app" });
    // The hero's <header> sits inside <main>, so it has no banner role: find it by tag.
    expect(badges.closest("header")).toHaveTextContent("Your notes, beautifully organized");
    expect(
      within(badges).getByRole("link", { name: "Download Drafto on the App Store" }),
    ).toHaveAttribute("href", APP_STORE_URL);
    expect(
      within(badges).getByRole("link", { name: "Download Drafto on the Mac App Store" }),
    ).toHaveAttribute("href", APP_STORE_URL);
    expect(within(badges).queryAllByRole("link", { name: /Google Play/ })).toHaveLength(
      GOOGLE_PLAY_PUBLIC ? 1 : 0,
    );
  });

  it("lists every feature", () => {
    render(<WelcomePage />);

    const features = screen.getByRole("region", { name: "What Drafto does" });
    for (const feature of LANDING_FEATURES) {
      expect(
        within(features).getByRole("heading", { level: 3, name: feature.title }),
      ).toBeInTheDocument();
    }
  });

  it("links the privacy policy and support page", () => {
    render(<WelcomePage />);

    const legal = screen.getByRole("navigation", { name: "Legal" });
    expect(within(legal).getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(within(legal).getByRole("link", { name: "Support" })).toHaveAttribute(
      "href",
      "/support",
    );
  });
});

describe("FeatureList", () => {
  it("renders the features it is given", () => {
    render(<FeatureList features={[{ title: "Custom", description: "A custom feature." }]} />);

    expect(screen.getByRole("heading", { level: 3, name: "Custom" })).toBeInTheDocument();
    expect(screen.getByText("A custom feature.")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
