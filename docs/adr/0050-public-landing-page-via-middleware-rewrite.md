# 0050 — Serve a Public Landing Page at `/` Through a Middleware Rewrite

- **Status**: Accepted
- **Date**: 2026-10-17
- **Authors**: Jakub Anderwald, with Claude Code

## Context

drafto.eu had no home page for signed-out visitors. The session middleware answered signed-out `/` with a 307 to `/login`. The redirect had to be temporary, because signed-in users get the app at the same URL.

On 15 October 2026 Google Search Console reported `https://drafto.eu/login` as "Duplicate, Google chose different canonical than user":

- `/login` declared itself canonical (#698), but Google chose `https://drafto.eu/`.
- Google had indexed `/` with the login form's content. The GitHub README links to it, and it is shorter.
- A temporary redirect is only a weak hint that the target is canonical. Two URLs serving one page let Google keep the homepage URL, whatever `/login` declared.

The App Store and Play listings and Google's OAuth brand verification also send people to drafto.eu. They landed on a bare login form, with one footer line saying what Drafto is.

## Decision

**Signed-out `/` serves a public landing page through a middleware rewrite. Signed-in `/` stays the app.**

- **Rewrite.** In `updateSession` (`apps/web/src/lib/supabase/middleware.ts`), a signed-out request for `/` gets `NextResponse.rewrite` to `/welcome` (`apps/web/src/app/welcome/page.tsx`). The URL stays `/` and the response is a 200. Cookies refreshed during `getUser()` are carried on the rewrite, along with the no-cache headers `@supabase/ssr` sends with any auth-cookie write. The landing page is static, so this keeps a cache from storing it together with a cookie change. Signed-in requests fall through to the app exactly as before.
- **One public URL.** A direct request for `/welcome` gets a 308 to `/` before any session lookup. Middleware doesn't run again on its own rewrite, so the rewritten request is never redirected.
- **Indexing.** The landing page declares `/` as its canonical, and `/` is the first entry in `INDEXED_PATHS`, which feeds the sitemap. `/login` keeps its own canonical; it is now a different page from `/`.
- **Client router.** Supabase sets the session cookie in the browser, which Next.js doesn't see, and the client router keeps mapping `/` to the landing page it first loaded there. `router.refresh()` clears cached page data but not that route mapping. So the client-side sign-ins (the login and reset-password pages) enter the app with `enterApp()` (`apps/web/src/lib/auth/enter-app.ts`), which is `window.location.assign("/")`, a full page load. OAuth and email-link sign-ins already return through `/auth/callback` with a full page load.
- **Scope.** Web only. The native apps never load `/`.

## Consequences

- **Positive**:
  - `/` and `/login` are different pages, so Google can honour both canonicals. drafto.eu shows visitors and reviewers what Drafto is.
  - The app, its routes and `(app)/layout.tsx` are untouched. The change is one branch in the middleware plus a static page.
  - The landing page is static. Signed-out `/` costs the same middleware run as before, and the 307 round trip to `/login` is gone.
- **Negative**:
  - One URL now serves two different pages depending on the session. Anything that caches `/` must vary by session. Vercel runs middleware before its cache, and the client router is handled by `enterApp()`. Any new client-side sign-in path must use it too.
  - A password sign-in now ends in a full page load rather than a client transition. It is the same cost as the OAuth path, and the app layout renders on the server either way.
  - When a session expires inside the open app, a client navigation to `/` now shows the landing page, with its Log in button, rather than redirecting to `/login`.
  - `/welcome` exists as a route only to be a rewrite target. A test asserts it redirects, and it is not in the sitemap.
- **Neutral**:
  - The landing copy has to stay true as features change. `LANDING_FEATURES` in `apps/web/src/components/landing/feature-list.tsx` lists what it claims.

## Alternatives Considered

- **Accept Google's choice and document it.** This needs no code, and `/` is arguably the nicer URL in results. Rejected: the Search Console warning would stay, `/login` would never be indexed as itself, and drafto.eu would still open on a login form.
- **Make the signed-out redirect permanent (308).** Google would move indexing to `/login`. Rejected: a permanent redirect that depends on a cookie is false, and a browser that cached it would send a signed-in user from `/` to `/login`. Even with `no-store`, the homepage would drop out of the index.
- **Render the landing page from `(app)/page.tsx`.** Rejected: `(app)/layout.tsx` redirects signed-out users and wraps everything in `AppShell`. Giving it a signed-out branch would mix marketing into the app shell and restructure a layout that prefetches user data.
- **Point `/login`'s canonical at `/`.** Rejected: `/` redirected back to `/login`, so the canonical would point at a URL that redirects to the page declaring it. Google ignores such loops.
