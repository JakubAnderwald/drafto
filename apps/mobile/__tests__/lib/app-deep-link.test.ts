import {
  APP_SCHEME_PREFIX,
  PKCE_FLOW_ID_PARAM,
  type AppDeepLink,
  parseAppDeepLink,
  readPkceFlowId,
} from "@/lib/app-deep-link";

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

describe("readPkceFlowId", () => {
  const flowIdOf = (url: string) => readPkceFlowId(parseAppDeepLink(url) as AppDeepLink);

  it("reads auth-js's reserved sb_flow_id param", () => {
    expect(PKCE_FLOW_ID_PARAM).toBe("sb_flow_id");
  });

  it("reads the flow id from the query, next to the code Supabase appends", () => {
    expect(flowIdOf("drafto://reset-password?code=abc&sb_flow_id=0123abcd")).toBe("0123abcd");
  });

  it("reads it from the fragment too", () => {
    expect(flowIdOf("drafto://auth/callback?code=abc#sb_flow_id=0123abcd")).toBe("0123abcd");
  });

  it("decodes it like any other param", () => {
    expect(flowIdOf("drafto://auth/callback?sb_flow_id=flow%2Did")).toBe("flow-id");
  });

  it.each(["drafto://reset-password?code=abc&sb_flow_id=", "drafto://reset-password?sb_flow_id"])(
    "treats an empty flow id as none: %s",
    (url) => {
      expect(flowIdOf(url)).toBeNull();
    },
  );

  it("returns null when the link carries none", () => {
    expect(flowIdOf("drafto://reset-password?code=abc")).toBeNull();
  });

  it("passes an id auth-js would reject through unchanged, for auth-js to refuse", () => {
    // Validating here and dropping the id would fall back to another flow's verifier.
    expect(flowIdOf("drafto://reset-password?code=abc&sb_flow_id=../x")).toBe("../x");
  });
});
