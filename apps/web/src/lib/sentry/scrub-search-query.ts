import type { Breadcrumb, Event } from "@sentry/nextjs";

/** The notes search route. Its `q` query parameter is the user's search text (ADR-0099). */
export const SEARCH_PATH = "/api/notes/search";

function isSearchUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    return new URL(url, "http://localhost").pathname.replace(/\/+$/, "") === SEARCH_PATH;
  } catch {
    return false;
  }
}

function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Drops the search text from a breadcrumb that called the search route (the browser SDK records
 * the URL it fetched). Runs as `beforeBreadcrumb` in the browser config: Session Replay records
 * each fetch from the breadcrumb that hook returns, so its network entries lose the text too.
 * Other breadcrumbs are returned unchanged. Pure: it returns a copy and never mutates.
 */
export function scrubSearchBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const url = breadcrumb.data?.url;
  if (!isSearchUrl(url)) return breadcrumb;
  return { ...breadcrumb, data: { ...breadcrumb.data, url: withoutQuery(url) } };
}

/**
 * Drops the search text from a Sentry error event: the query string of a search request the event
 * came from (the server and edge SDKs attach it as `request.url` and `request.query_string`), and of
 * any fetch breadcrumb that called the search route (the browser SDK records the URL it fetched).
 * Other events are returned unchanged. Pure: it returns a copy and never mutates the event.
 */
export function scrubSearchQuery<T extends Event>(event: T): T {
  let scrubbed = event;

  const request = event.request;
  if (request && isSearchUrl(request.url)) {
    const cleanRequest = { ...request, url: withoutQuery(request.url) };
    delete cleanRequest.query_string;
    scrubbed = { ...scrubbed, request: cleanRequest };
  }

  const breadcrumbs = event.breadcrumbs;
  if (breadcrumbs?.some((breadcrumb) => isSearchUrl(breadcrumb.data?.url))) {
    scrubbed = { ...scrubbed, breadcrumbs: breadcrumbs.map(scrubSearchBreadcrumb) };
  }

  return scrubbed;
}
