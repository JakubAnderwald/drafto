import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  createNonce,
  DEFAULT_POSTHOG_HOST,
  setsOwnContentSecurityPolicy,
  type ContentSecurityPolicyOptions,
} from "@/lib/security/content-security-policy";

const NONCE = "bm9uY2Utb2YtdGhlLXRlc3Q=";

// The nonce pattern Next.js accepts (`get-script-nonce-from-header.js`). A nonce outside it is
// dropped, and Next's own scripts render without one.
const NEXT_NONCE = /^[A-Za-z0-9+/_-]+={0,2}$/;

function policy(overrides: Partial<ContentSecurityPolicyOptions> = {}): string {
  return buildContentSecurityPolicy({
    nonce: NONCE,
    supabaseUrl: "https://project.supabase.co",
    isDevelopment: false,
    ...overrides,
  });
}

/** The policy as directive name → sources. */
function directives(value: string): Map<string, string[]> {
  return new Map(
    value.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe("createNonce", () => {
  it("returns 128 bits of base64 that Next.js accepts", () => {
    const nonce = createNonce();

    expect(nonce).toMatch(NEXT_NONCE);
    expect(atob(nonce)).toHaveLength(16);
  });

  it("returns a fresh nonce each time", () => {
    expect(createNonce()).not.toBe(createNonce());
  });
});

describe("buildContentSecurityPolicy", () => {
  it("sets every directive, with the nonce on script-src", () => {
    expect(Object.fromEntries(directives(policy()))).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "blob:", "data:", "https://project.supabase.co", "https:"],
      "media-src": ["'self'", "blob:", "https://project.supabase.co", "https:"],
      "font-src": ["'self'"],
      "connect-src": [
        "'self'",
        "https://project.supabase.co",
        "wss://project.supabase.co",
        DEFAULT_POSTHOG_HOST,
        "https://*.posthog.com",
        "https://*.ingest.de.sentry.io",
      ],
      "worker-src": ["'self'", "blob:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"],
    });
  });

  it("keeps the nonce off style-src, where it would disable 'unsafe-inline'", () => {
    expect(directives(policy()).get("style-src")?.join(" ")).not.toContain("nonce-");
  });

  it("allows 'unsafe-eval' only in development", () => {
    expect(directives(policy({ isDevelopment: false })).get("script-src")).not.toContain(
      "'unsafe-eval'",
    );
    expect(directives(policy({ isDevelopment: true })).get("script-src")).toContain(
      "'unsafe-eval'",
    );
  });

  it("allows Supabase's origin and its realtime socket from the project URL", () => {
    const value = directives(policy({ supabaseUrl: "https://abc.supabase.co/" }));

    expect(value.get("connect-src")).toEqual(
      expect.arrayContaining(["https://abc.supabase.co", "wss://abc.supabase.co"]),
    );
    expect(value.get("img-src")).toContain("https://abc.supabase.co");
    expect(value.get("media-src")).toContain("https://abc.supabase.co");
  });

  it("uses ws: for the realtime socket of a local Supabase on http:", () => {
    const value = directives(policy({ supabaseUrl: "http://127.0.0.1:54321" }));

    expect(value.get("connect-src")).toEqual(
      expect.arrayContaining(["http://127.0.0.1:54321", "ws://127.0.0.1:54321"]),
    );
  });

  it("falls back to PostHog's default US host when no host is set", () => {
    expect(DEFAULT_POSTHOG_HOST).toBe("https://us.i.posthog.com");
    expect(directives(policy({ posthogHost: undefined })).get("connect-src")).toContain(
      DEFAULT_POSTHOG_HOST,
    );
    expect(directives(policy({ posthogHost: "" })).get("connect-src")).toContain(
      DEFAULT_POSTHOG_HOST,
    );
  });

  it("follows NEXT_PUBLIC_POSTHOG_HOST when it is set, by origin", () => {
    const connect = directives(
      policy({ posthogHost: "https://analytics.example.com/ingest/" }),
    ).get("connect-src");

    expect(connect).toContain("https://analytics.example.com");
    expect(connect).not.toContain(DEFAULT_POSTHOG_HOST);
  });

  it("never copies an unreadable PostHog host into the policy", () => {
    const value = policy({ posthogHost: "not a url; script-src *" });

    expect(value).not.toContain("not a url");
    expect(directives(value).get("script-src")).not.toContain("*");
    expect(directives(value).get("connect-src")).toContain(DEFAULT_POSTHOG_HOST);
  });

  // `new URL()` accepts these hosts and keeps the `;`, `,`, `'` or `*` in `origin`.
  it.each([
    "https://eu.i.posthog.com;",
    "https://x.com;script-src-elem",
    "https://a,b.com",
    "https://a'b.com",
    "https://a*b.com",
    "ftp://eu.i.posthog.com",
  ])("falls back to the default for the PostHog host %s", (posthogHost) => {
    const value = policy({ posthogHost });
    const parsed = directives(value);

    expect([...parsed.keys()]).toEqual([...directives(policy()).keys()]);
    expect(parsed.get("connect-src")).toContain(DEFAULT_POSTHOG_HOST);
    expect(value).not.toMatch(/a,b|a'b|a\*b|script-src-elem|ftp:/);
  });

  it.each(["https://abc.supabase.co;", "https://abc.supabase.co;script-src-elem", "not a url"])(
    "refuses to build a policy from the Supabase URL %s",
    (supabaseUrl) => {
      expect(() => policy({ supabaseUrl })).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    },
  );

  it("accepts a local Supabase on a bracketed IPv6 address", () => {
    expect(directives(policy({ supabaseUrl: "http://[::1]:54321" })).get("connect-src")).toEqual(
      expect.arrayContaining(["http://[::1]:54321", "ws://[::1]:54321"]),
    );
  });

  it("lists each source once", () => {
    for (const [, sources] of directives(policy({ posthogHost: DEFAULT_POSTHOG_HOST }))) {
      expect(new Set(sources).size).toBe(sources.length);
    }
  });
});

describe("setsOwnContentSecurityPolicy", () => {
  it.each(["/auth/apple/revocation", "/auth/apple/revocation/"])("is true for %s", (path) => {
    expect(setsOwnContentSecurityPolicy(path)).toBe(true);
  });

  it.each(["/", "/login", "/auth/apple", "/auth/apple/revocation-page", "/auth/callback"])(
    "is false for %s",
    (path) => {
      expect(setsOwnContentSecurityPolicy(path)).toBe(false);
    },
  );
});
