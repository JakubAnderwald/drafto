import { describe, expect, it } from "vitest";
import { buildPageviewUrl } from "@/lib/posthog/pageview-url";

describe("buildPageviewUrl", () => {
  it("keeps the query string on ordinary pages", () => {
    expect(buildPageviewUrl("https://drafto.eu", "/login", "error=auth-callback-error")).toBe(
      "https://drafto.eu/login?error=auth-callback-error",
    );
  });

  it("omits an empty query string", () => {
    expect(buildPageviewUrl("https://drafto.eu", "/support", "")).toBe("https://drafto.eu/support");
  });

  it.each(["/auth/desktop/callback", "/auth/desktop/recovery", "/auth/callback"])(
    "drops the one-time auth code from %s",
    (pathname) => {
      expect(buildPageviewUrl("https://drafto.eu", pathname, "code=secret-code")).toBe(
        `https://drafto.eu${pathname}`,
      );
    },
  );

  it("does not treat a lookalike path as an auth page", () => {
    expect(buildPageviewUrl("https://drafto.eu", "/authors", "page=2")).toBe(
      "https://drafto.eu/authors?page=2",
    );
  });
});
