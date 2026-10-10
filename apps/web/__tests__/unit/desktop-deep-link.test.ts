import { describe, expect, it } from "vitest";
import { buildDesktopDeepLink, DESKTOP_FLOWS, isDesktopFlow } from "@/lib/auth/desktop-deep-link";

describe("isDesktopFlow", () => {
  it("accepts exactly the flows the macOS app routes on", () => {
    expect(DESKTOP_FLOWS).toEqual(["callback", "recovery"]);
    expect(isDesktopFlow("callback")).toBe(true);
    expect(isDesktopFlow("recovery")).toBe(true);
    expect(isDesktopFlow("reset-password")).toBe(false);
    expect(isDesktopFlow("")).toBe(false);
  });
});

describe("buildDesktopDeepLink", () => {
  it("forwards the PKCE code to the OAuth path", () => {
    const link = buildDesktopDeepLink("callback", "?code=abc", "");

    expect(link).toEqual({
      url: "eu.drafto.desktop://auth/callback?code=abc",
      code: "abc",
      hasError: false,
    });
  });

  it("forwards the PKCE code to the recovery path", () => {
    expect(buildDesktopDeepLink("recovery", "?code=xyz", "").url).toBe(
      "eu.drafto.desktop://auth/recovery?code=xyz",
    );
  });

  it("drops session tokens, so a drafto.eu link cannot push a session into the app", () => {
    const link = buildDesktopDeepLink(
      "callback",
      "?code=abc&access_token=AAA&refresh_token=RRR&next=/evil",
      "#access_token=BBB&refresh_token=SSS&type=recovery",
    );

    expect(link.url).toBe("eu.drafto.desktop://auth/callback?code=abc");
  });

  it("reads an error from the fragment, which the server never sees", () => {
    const link = buildDesktopDeepLink(
      "recovery",
      "",
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );

    expect(link.code).toBeNull();
    expect(link.hasError).toBe(true);
    expect(link.url).toBe(
      "eu.drafto.desktop://auth/recovery?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
  });

  it("lets the fragment win a collision, like the desktop parser", () => {
    expect(buildDesktopDeepLink("callback", "?code=from-query", "#code=from-fragment").code).toBe(
      "from-fragment",
    );
  });

  it("flags an error from either the bare error or its description", () => {
    expect(buildDesktopDeepLink("callback", "?error=server_error", "").hasError).toBe(true);
    expect(buildDesktopDeepLink("callback", "?error_description=Nope", "").hasError).toBe(true);
    expect(buildDesktopDeepLink("callback", "?error_code=otp_expired", "").hasError).toBe(false);
  });

  it("encodes values so they cannot break out of their param", () => {
    const link = buildDesktopDeepLink("callback", "?code=a%26access_token%3DAAA", "");

    expect(link.code).toBe("a&access_token=AAA");
    expect(link.url).toBe("eu.drafto.desktop://auth/callback?code=a%26access_token%3DAAA");
  });

  it("accepts search and hash with or without their leading marker", () => {
    expect(buildDesktopDeepLink("callback", "code=abc", "").url).toBe(
      "eu.drafto.desktop://auth/callback?code=abc",
    );
    expect(buildDesktopDeepLink("callback", "", "code=abc").url).toBe(
      "eu.drafto.desktop://auth/callback?code=abc",
    );
  });

  it("returns the bare path when nothing is forwarded", () => {
    expect(buildDesktopDeepLink("callback", "?foo=bar", "")).toEqual({
      url: "eu.drafto.desktop://auth/callback",
      code: null,
      hasError: false,
    });
  });
});
