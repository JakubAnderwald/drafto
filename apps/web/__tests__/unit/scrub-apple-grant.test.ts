import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/nextjs";
import { scrubAppleGrantRequest } from "@/lib/sentry/scrub-apple-grant";

const event = (url: string): Event => ({
  event_id: "abc",
  request: {
    url,
    method: "POST",
    data: '{"apple":{"authorizationCode":"secret-code"}}',
    query_string: "code=secret-code",
    headers: { "user-agent": "test" },
  },
});

describe("scrubAppleGrantRequest", () => {
  it.each([
    "https://drafto.eu/api/account",
    "https://drafto.eu/api/account/",
    "https://drafto.eu/auth/apple/revocation",
    "/auth/apple/revocation?code=secret-code&state=android.x",
  ])("drops the body and query string for %s", (url) => {
    const original = event(url);
    const scrubbed = scrubAppleGrantRequest(original);

    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.headers).toEqual({ "user-agent": "test" });
    expect(scrubbed.request?.method).toBe("POST");
    expect(JSON.stringify(scrubbed)).not.toContain("secret-code");
    // Pure: the original event is untouched.
    expect(original.request?.data).toBeDefined();
  });

  it.each([
    "https://drafto.eu/api/notes",
    "https://drafto.eu/api/account-settings",
    "https://drafto.eu/auth/apple/revocation-other",
  ])("leaves other routes alone: %s", (url) => {
    const original = event(url);
    expect(scrubAppleGrantRequest(original)).toBe(original);
  });

  it("leaves events without a request URL alone", () => {
    const original: Event = { event_id: "abc" };
    expect(scrubAppleGrantRequest(original)).toBe(original);
    const noUrl: Event = { request: { data: "x" } };
    expect(scrubAppleGrantRequest(noUrl)).toBe(noUrl);
  });
});
