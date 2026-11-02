import { describe, expect, it } from "vitest";
import { isSentryEnabled, resolveSentryEnvironment } from "@/lib/sentry-environment";

describe("resolveSentryEnvironment", () => {
  it("uses the configured environment", () => {
    expect(resolveSentryEnvironment("preview", "production")).toBe("preview");
  });

  it("trims whitespace around the configured environment", () => {
    expect(resolveSentryEnvironment("production\n", "production")).toBe("production");
    expect(resolveSentryEnvironment("  development ", "production")).toBe("development");
  });

  it.each([
    ["production", "production"],
    ["development", "development"],
    ["test", "development"],
    [undefined, "development"],
  ])("falls back by NODE_ENV=%s to %s when unset", (nodeEnv, expected) => {
    expect(resolveSentryEnvironment(undefined, nodeEnv)).toBe(expected);
  });

  it("treats a blank configured environment as unset", () => {
    expect(resolveSentryEnvironment("", "production")).toBe("production");
    expect(resolveSentryEnvironment("\n", "development")).toBe("development");
  });
});

describe("isSentryEnabled", () => {
  it.each([
    // Vercel deployments report.
    ["production", "production", true],
    ["preview", "production", true],
    // Local `next start` with .env.local's "development" stays off.
    ["development", "production", false],
    // `next dev` (and local E2E) stays off whatever environment is configured.
    ["development", "development", false],
    ["preview", "development", false],
    ["production", "development", false],
  ])("environment=%s, NODE_ENV=%s → %s", (environment, nodeEnv, expected) => {
    expect(isSentryEnabled(environment, nodeEnv)).toBe(expected);
  });
});
