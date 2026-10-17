import { describe, expect, it } from "vitest";
import { resolveSentryEnvironment } from "@/lib/sentry-environment";

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
