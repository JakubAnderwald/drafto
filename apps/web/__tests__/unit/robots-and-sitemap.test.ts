import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

describe("robots.txt", () => {
  it("allows crawling the site except the API", () => {
    expect(robots().rules).toEqual({ userAgent: "*", allow: "/", disallow: "/api/" });
  });

  it("points crawlers at the sitemap on the apex host", () => {
    expect(robots().sitemap).toBe("https://drafto.eu/sitemap.xml");
  });
});

describe("sitemap.xml", () => {
  const urls = sitemap().map((entry) => entry.url);

  it("lists the public pages as absolute apex URLs", () => {
    expect(urls).toEqual([
      "https://drafto.eu/login",
      "https://drafto.eu/signup",
      "https://drafto.eu/privacy",
      "https://drafto.eu/support",
      "https://drafto.eu/account/delete",
    ]);
  });

  it("leaves out the home page, which redirects signed-out visitors to /login", () => {
    expect(urls).not.toContain("https://drafto.eu/");
    expect(urls).not.toContain("https://drafto.eu");
  });
});
