import { describe, expect, it, vi } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

// Importing the middleware module pulls in `@/env`, which validates real env vars.
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  },
}));

const { config } = await import("../../middleware");

function matches(path: string): boolean {
  return unstable_doesMiddlewareMatch({ config, url: `https://drafto.eu${path}` });
}

describe("middleware matcher", () => {
  it("skips /api/health so uptime checks do not run the session middleware", () => {
    expect(matches("/api/health")).toBe(false);
  });

  it.each(["/api/healthz", "/api/health-check", "/api/health/extra"])(
    "still runs on %s, which only shares the /api/health prefix",
    (path) => {
      expect(matches(path)).toBe(true);
    },
  );

  it.each(["/", "/login", "/api/notes/abc", "/api/account"])("runs on %s", (path) => {
    expect(matches(path)).toBe(true);
  });

  it("skips /api/mcp, which authenticates its own Bearer API key", () => {
    expect(matches("/api/mcp")).toBe(false);
  });

  it.each(["/api/mcp-tools", "/api/mcpx"])(
    "still runs on %s, which only shares the /api/mcp prefix",
    (path) => {
      expect(matches(path)).toBe(true);
    },
  );

  it.each(["/_next/static/chunks/app.js", "/_next/image", "/favicon.ico", "/logo.svg"])(
    "skips static asset %s",
    (path) => {
      expect(matches(path)).toBe(false);
    },
  );

  it.each([
    "/robots.txt",
    "/sitemap.xml",
    "/.well-known/apple-app-site-association",
    "/.well-known/assetlinks.json",
  ])("skips %s so crawlers and app-link verifiers are not redirected to /login", (path) => {
    expect(matches(path)).toBe(false);
  });

  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    // The MCP SDK's fallback endpoints when discovery finds nothing.
    "/register",
    "/authorize",
    "/token",
  ])("skips %s, which MCP clients probe after a 401", (path) => {
    expect(matches(path)).toBe(false);
  });

  it.each([
    "/robots.txt.bak",
    "/sitemap.xml/extra",
    "/well-known/x",
    "/api/.well-known/x",
    "/.well-known/assetlinks.json.bak",
    "/register/extra",
    "/tokens",
  ])("still runs on %s, which only resembles a skipped path", (path) => {
    expect(matches(path)).toBe(true);
  });

  it("still runs on any other /.well-known path, so a future route there gets a session", () => {
    expect(matches("/.well-known/some-future-route")).toBe(true);
  });
});
