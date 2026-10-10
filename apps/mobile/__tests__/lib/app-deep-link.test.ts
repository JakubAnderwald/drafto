import { APP_SCHEME_PREFIX, parseAppDeepLink } from "@/lib/app-deep-link";

describe("parseAppDeepLink", () => {
  it("only accepts the app's own scheme", () => {
    expect(APP_SCHEME_PREFIX).toBe("drafto://");
    expect(parseAppDeepLink("https://drafto.eu/auth/callback?code=abc")).toBeNull();
    expect(parseAppDeepLink("eu.drafto.desktop://auth/callback?code=abc")).toBeNull();
  });

  it("splits the path and the query params", () => {
    const link = parseAppDeepLink("drafto://auth/callback?code=abc&state=xyz");

    expect(link?.path).toBe("auth/callback");
    expect(link?.params.get("code")).toBe("abc");
    expect(link?.params.get("state")).toBe("xyz");
  });

  it("reads fragment params too, and lets them win a collision", () => {
    const link = parseAppDeepLink(
      "drafto://reset-password?error=query#error=fragment&type=recovery",
    );

    expect(link?.params.get("error")).toBe("fragment");
    expect(link?.params.get("type")).toBe("recovery");
  });

  it("normalises scheme casing and stray slashes in the path", () => {
    expect(parseAppDeepLink("DRAFTO:///Reset-Password/?code=abc")?.path).toBe("reset-password");
  });

  it("decodes percent-escapes and plus signs", () => {
    const link = parseAppDeepLink(
      "drafto://reset-password#error_description=Email+link+is%20invalid",
    );

    expect(link?.params.get("error_description")).toBe("Email link is invalid");
  });

  it("keeps a malformed escape as-is instead of throwing", () => {
    expect(parseAppDeepLink("drafto://auth/callback?code=%zz")?.params.get("code")).toBe("%zz");
  });

  it("treats a key without a value as empty", () => {
    expect(parseAppDeepLink("drafto://auth/callback?flag")?.params.get("flag")).toBe("");
  });

  it("returns an empty param map for a bare link", () => {
    const link = parseAppDeepLink("drafto://reset-password");

    expect(link?.path).toBe("reset-password");
    expect(link?.params.size).toBe(0);
  });
});
