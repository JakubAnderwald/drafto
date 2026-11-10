import { describe, expect, it, vi } from "vitest";
import { APPLE_RELAY_PRIVATE_HEADERS } from "@/lib/apple/revocation-relay";

// `withSentryConfig` wraps the config for the build. Here it hands it back unchanged, so the test
// reads the app's own `headers()`.
vi.mock("@sentry/nextjs", () => ({
  withSentryConfig: <T>(config: T) => config,
}));

const { default: nextConfig } = await import("../../next.config");

type HeaderEntry = { source: string; headers: Array<{ key: string; value: string }> };

async function entries(): Promise<HeaderEntry[]> {
  const headers = nextConfig.headers;
  if (!headers) throw new Error("next.config.ts defines no headers()");
  return (await headers()) as HeaderEntry[];
}

function headerMap(entry: HeaderEntry | undefined): Record<string, string> {
  return Object.fromEntries((entry?.headers ?? []).map(({ key, value }) => [key, value]));
}

describe("next.config.ts security headers", () => {
  it("sends the static hardening headers on every path", async () => {
    const all = await entries();
    const everyPath = all.find((entry) => entry.source === "/:path*");

    expect(headerMap(everyPath)).toEqual({
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
  });

  it("asks for no HSTS preload", async () => {
    const everyPath = (await entries()).find((entry) => entry.source === "/:path*");

    expect(headerMap(everyPath)["Strict-Transport-Security"]).not.toContain("preload");
  });

  it("sets no Content-Security-Policy, which carries a per-request nonce from the middleware", async () => {
    for (const entry of await entries()) {
      expect(Object.keys(headerMap(entry)).map((key) => key.toLowerCase())).not.toContain(
        "content-security-policy",
      );
    }
  });

  it("keeps the Apple relay's no-referrer policy, in an entry after the every-path one", async () => {
    // When two entries set the same header for a path, the later one wins, and the route can't
    // set it itself once config has.
    const all = await entries();
    const everyPathIndex = all.findIndex((entry) => entry.source === "/:path*");
    const relayIndex = all.findIndex((entry) => entry.source === "/auth/apple/revocation");

    expect(relayIndex).toBeGreaterThan(everyPathIndex);
    expect(headerMap(all[relayIndex])).toEqual({
      "Referrer-Policy": APPLE_RELAY_PRIVATE_HEADERS["Referrer-Policy"],
    });
  });

  it("still serves the apple-app-site-association file as JSON", async () => {
    const aasa = (await entries()).find(
      (entry) => entry.source === "/.well-known/apple-app-site-association",
    );

    expect(headerMap(aasa)).toEqual({ "Content-Type": "application/json" });
  });
});
