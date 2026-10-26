# 0059 — Keep `/login` Out of the Search Index

- **Status**: Accepted
- **Date**: 2026-10-26
- **Authors**: Jakub Anderwald, with Claude Code

## Context

[ADR-0050](./0050-public-landing-page-via-middleware-rewrite.md) put a landing page at signed-out `/` so that `/` and `/login` would be different pages, and Google could honour `/login`'s self-canonical. It did not work:

- On 2026-10-17, 25 minutes after the landing page shipped, Googlebot crawled `/` and `/login` in the same second. It indexed `/` as the landing page, with its own canonical.
- For `/login` it still chose `https://drafto.eu/` as the canonical, over the declared `https://drafto.eu/login`. The "Duplicate, Google chose different canonical than user" fix validation failed on 2026-10-20, and Search Console emailed on 2026-10-25.
- `/login` is a bare form of about 40 words. Its heading, tagline and footer are the same as on the landing page. Google had also seen `/` answer with the login form, through the 307, for weeks before that.

A login page has no value as a search result. Someone looking for Drafto should land on `/`, which says what Drafto is and links to Log in.

## Decision

**`/login` is noindex, declares no canonical, and is left out of the sitemap.**

- `apps/web/src/app/(auth)/login/layout.tsx` sets only the title. The page inherits `robots: { index: false, follow: true }` from the `(auth)` group layout, like the other auth utility pages.
- `/login` is removed from `INDEXED_PATHS` (`apps/web/src/lib/site.ts`), so the sitemap no longer lists it. Listing a noindex URL there would be a Search Console error.
- `/signup` stays indexed with its self-canonical. It has been indexed as itself since September and was never flagged.
- Everything else in ADR-0050 stands: the landing page, the rewrite, and `/` as the only page declaring `/` as its canonical.

## Consequences

- **Positive**:
  - The duplicate group empties once Google recrawls `/login` and finds `noindex`. It moves to "Excluded by noindex", a state the docs already list as correct.
  - Brand searches resolve to `/`, the page meant for them.
- **Negative**:
  - `/login` can't appear in search results as itself. This was already the case in practice, because Google never indexed it.
  - Login and sign-up are now treated differently. If `/signup` gets the same flag, it should get the same treatment.
- **Neutral**:
  - The auth layout's footer (what Drafto is, Privacy and Support links) stays. It serves visitors and Google OAuth brand verification, not indexing.

## Alternatives Considered

- **noindex both `/login` and `/signup`.** This is consistent and pre-empts the same flag on `/signup`. Rejected for now: `/signup` is indexed and healthy, and the cost of waiting is low.
- **Give `/login` enough content of its own to stand apart from `/`.** Rejected: it would add marketing copy to a form people use every day, with no guarantee that Google splits the cluster.
- **Change nothing, request indexing and validate again.** Rejected: Google already re-evaluated both pages after the landing page shipped and kept `/`.
- **Point `/login`'s canonical at `/`.** Rejected: it says the login form is a copy of the landing page, which it isn't, and `noindex` states the intent directly.
