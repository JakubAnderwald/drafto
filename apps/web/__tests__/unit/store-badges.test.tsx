import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StoreBadges } from "@/components/landing/store-badges";
import { APP_STORE_URL, GOOGLE_PLAY_PUBLIC, GOOGLE_PLAY_URL } from "@/lib/store-links";

const APPLE_NAMES = ["Download Drafto on the App Store", "Download Drafto on the Mac App Store"];

describe("StoreBadges", () => {
  describe("while Google Play is not public", () => {
    it("links both Apple badges to the App Store listing", () => {
      render(<StoreBadges googlePlayPublic={false} />);

      for (const name of APPLE_NAMES) {
        expect(screen.getByRole("link", { name })).toHaveAttribute("href", APP_STORE_URL);
      }
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });

    it("renders no Google Play badge", () => {
      const { container } = render(<StoreBadges googlePlayPublic={false} />);

      expect(screen.queryByRole("link", { name: /Google Play/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/Google Play|Coming soon/)).not.toBeInTheDocument();
      expect(container.querySelector('img[src*="google-play"]')).toBeNull();
    });
  });

  describe("once Google Play is public", () => {
    it("links the Google Play badge to the Play listing, after the Apple badges", () => {
      render(<StoreBadges googlePlayPublic />);

      const links = screen.getAllByRole("link");
      expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
        ...APPLE_NAMES,
        "Get Drafto on Google Play",
      ]);
      expect(links[2]).toHaveAttribute("href", GOOGLE_PLAY_URL);
      expect(screen.queryByText(/Coming soon/)).not.toBeInTheDocument();
    });
  });

  it("follows GOOGLE_PLAY_PUBLIC by default", () => {
    render(<StoreBadges />);

    expect(screen.queryAllByRole("link", { name: /Google Play/ })).toHaveLength(
      GOOGLE_PLAY_PUBLIC ? 1 : 0,
    );
  });

  it("gives each Apple badge a light and a dark variant, with decorative images", () => {
    render(<StoreBadges googlePlayPublic />);

    const appStore = screen.getByRole("link", { name: APPLE_NAMES[0] });
    const images = Array.from(appStore.querySelectorAll("img"));
    expect(images.map((img) => img.getAttribute("src"))).toEqual([
      "/badges/app-store-black.svg",
      "/badges/app-store-white.svg",
    ]);
    expect(images.map((img) => img.className)).toEqual([
      expect.stringContaining("theme-light-only"),
      expect.stringContaining("theme-dark-only"),
    ]);
    for (const img of document.querySelectorAll("img")) {
      expect(img).toHaveAttribute("alt", "");
    }
  });

  it("does not open the stores in a new tab", () => {
    render(<StoreBadges googlePlayPublic />);

    for (const link of screen.getAllByRole("link")) {
      expect(link).not.toHaveAttribute("target");
    }
  });
});
