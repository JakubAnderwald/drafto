import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/nextjs";
import { scrubSearchQuery } from "@/lib/sentry/scrub-search-query";

describe("scrubSearchQuery", () => {
  it.each([
    ["https://drafto.eu/api/notes/search?q=secret%20words", "https://drafto.eu/api/notes/search"],
    ["https://drafto.eu/api/notes/search/?q=secret%20words", "https://drafto.eu/api/notes/search/"],
    ["/api/notes/search?q=secret%20words#top", "/api/notes/search"],
  ])("drops the query string of a search request: %s", (url, expected) => {
    const original: Event = {
      event_id: "abc",
      request: {
        url,
        method: "GET",
        query_string: "q=secret%20words",
        headers: { "user-agent": "test" },
      },
    };
    const scrubbed = scrubSearchQuery(original);

    expect(scrubbed.request?.url).toBe(expected);
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.method).toBe("GET");
    expect(scrubbed.request?.headers).toEqual({ "user-agent": "test" });
    expect(JSON.stringify(scrubbed)).not.toContain("secret");
    // Pure: the original event is untouched.
    expect(original.request?.query_string).toBe("q=secret%20words");
  });

  it("drops the query string from fetch breadcrumbs that called the search route", () => {
    const notebooksFetch = {
      category: "fetch",
      type: "http",
      data: { method: "GET", url: "/api/notebooks?x=1" },
    };
    const click = { category: "ui.click", message: "button" };
    const original: Event = {
      breadcrumbs: [
        {
          category: "fetch",
          type: "http",
          data: { method: "GET", url: "/api/notes/search?q=secret", status_code: 500 },
        },
        notebooksFetch,
        click,
      ],
    };
    const scrubbed = scrubSearchQuery(original);

    expect(scrubbed.breadcrumbs?.[0].data).toEqual({
      method: "GET",
      url: "/api/notes/search",
      status_code: 500,
    });
    expect(scrubbed.breadcrumbs?.[1]).toBe(notebooksFetch);
    expect(scrubbed.breadcrumbs?.[2]).toBe(click);
    expect(JSON.stringify(scrubbed)).not.toContain("secret");
    expect(original.breadcrumbs?.[0].data?.url).toBe("/api/notes/search?q=secret");
  });

  it.each([
    "https://drafto.eu/api/notes?q=x",
    "https://drafto.eu/api/notes/search-other?q=x",
    "https://drafto.eu/api/notes/search/extra?q=x",
  ])("leaves other routes alone: %s", (url) => {
    const original: Event = {
      request: { url, query_string: "q=x" },
      breadcrumbs: [{ category: "fetch", data: { url } }],
    };
    expect(scrubSearchQuery(original)).toBe(original);
  });

  it("leaves events without a request URL or breadcrumbs alone", () => {
    const bare: Event = { event_id: "abc" };
    expect(scrubSearchQuery(bare)).toBe(bare);
    const noUrl: Event = { request: { query_string: "q=x" }, breadcrumbs: [{ message: "hi" }] };
    expect(scrubSearchQuery(noUrl)).toBe(noUrl);
  });
});
