import { describe, expect, it } from "vitest";
import { sanitizeRedirectPath } from "@/lib/auth/redirect-path";

describe("sanitizeRedirectPath", () => {
  it.each(["/", "/reset-password", "/notes/123?tab=1#top", "/notes/a%5Cb"])(
    "keeps the same-origin path %s",
    (path) => {
      expect(sanitizeRedirectPath(path)).toBe(path);
    },
  );

  it.each([
    ["missing", null],
    ["empty", ""],
    ["protocol-relative", "//evil.example"],
    ["protocol-relative with a path", "//evil.example/login"],
    ["absolute", "https://evil.example"],
    ["relative without a leading slash", "notes"],
    ["javascript: URL", "javascript:alert(1)"],
    // Read as "//" by the URL parser and by browsers: these used to escape to another host.
    ["backslash host", "/\\evil.example"],
    ["backslash host with a path", "/\\evil.example/login"],
    ["tab-split host", "/\t/evil.example"],
    ["newline-split host", "/\n/evil.example"],
  ])("falls back to / for a %s path", (_case, path) => {
    expect(sanitizeRedirectPath(path)).toBe("/");
  });
});
