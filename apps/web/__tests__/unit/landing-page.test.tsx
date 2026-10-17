import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import WelcomePage from "@/app/welcome/page";
import { FeatureList, LANDING_FEATURES } from "@/components/landing/feature-list";

describe("Landing page", () => {
  it("says what Drafto is", () => {
    render(<WelcomePage />);

    expect(screen.getByRole("heading", { level: 1, name: "Drafto" })).toBeInTheDocument();
    expect(
      screen.getByText(/note-taking app for the web, iPhone, iPad, Android and Mac/),
    ).toBeInTheDocument();
  });

  it("leads to sign-up and login, and says new accounts need approval", () => {
    render(<WelcomePage />);

    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    expect(screen.getByText(/approved by hand/)).toBeInTheDocument();
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
