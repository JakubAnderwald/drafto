/**
 * A note opened from Search. iOS presents every screen pushed over a modal as a
 * sheet of its own, so that note has no back button; app/_layout.tsx gives it a
 * close button instead. The query records where the note was opened from.
 */
const FROM_SEARCH = "search";

export function noteFromSearchHref(id: string): string {
  return `/notes/${id}?from=${FROM_SEARCH}`;
}

export function isOpenedFromSearch(params: object | undefined): boolean {
  return (params as { from?: unknown } | undefined)?.from === FROM_SEARCH;
}
