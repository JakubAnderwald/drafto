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

  it.each(["/", "/login", "/api/notes/abc", "/api/mcp", "/api/account"])("runs on %s", (path) => {
    expect(matches(path)).toBe(true);
  });

  it.each(["/_next/static/chunks/app.js", "/_next/image", "/favicon.ico", "/logo.svg"])(
    "skips static asset %s",
    (path) => {
      expect(matches(path)).toBe(false);
    },
  );
});
