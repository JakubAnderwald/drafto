# SEO and indexing

**Status:** shipped **Updated:** 2026-10-12

## What it is

How drafto.eu presents itself to search engines and app-link verifiers:

- the canonical host
- per-page canonical and robots tags
- `robots.txt` and `sitemap.xml`
- the `www` and `http` redirects
- the `.well-known` association files behind iOS Universal Links and Android App Links

The property is verified in Google Search Console as the domain property `drafto.eu`.

## Current state

- **Canonical host:** `https://drafto.eu`, the apex.
  - The root layout sets `metadataBase` from `SITE_URL`, so every relative `alternates.canonical` becomes an absolute apex URL.
  - This holds on localhost and Vercel previews too.
- **Redirects:**
  - `http://` returns a 308 to `https://`. Vercel enforces this.
  - `www.drafto.eu` returns a 308 to `drafto.eu`. This is a redirect domain in the Vercel project's domain settings, not code. GoDaddy has `www` as a CNAME into Vercel.
- **The home page has no landing page.** Signed-out `/` returns a 307 to `/login` (`src/lib/supabase/middleware.ts`). It has to be temporary, because signed-in users get the app at `/`. That is why `/` is not in the sitemap and `/login` declares itself canonical: without that, Google files `/login` as a duplicate of `/`.
- **Indexed pages:**
  - `/login`, `/signup`, `/privacy`, `/support` and `/account/delete` each declare themselves canonical.
  - They are listed in `INDEXED_PATHS`, which feeds the sitemap.
- **Not indexed:**
  - Every other page in the `(auth)` route group (forgot/reset password, waiting for approval, the desktop hand-off) inherits `noindex, follow` from the group layout.
  - The app itself sits behind the session redirect.
- **`robots.txt`:** allows everything except `/api/` and points at the sitemap.
- **Files middleware skips:**
  - `/robots.txt`, `/sitemap.xml`, `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` bypass the session middleware, along with `/api/health` and static assets.
  - Crawlers and the Apple and Google app-link verifiers come signed out and do not follow a 307 to `/login`.
  - The four files are also in `PUBLIC_ROUTES` as a backstop.
  - Any other `/.well-known/*` path still runs the middleware.

### Expected Search Console state

| Report                                             | URLs                                                    | Meaning                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Indexed                                            | The `INDEXED_PATHS` pages                               | Correct                                                                                                                                                                                                |
| Page with redirect (Strona zawiera przekierowanie) | `http://drafto.eu/`, `https://www.drafto.eu/`           | Correct. These are permanent 308 redirects (protocol and host), so the URLs are never indexed. Don't start "Validate fix" on this group: it can only fail.                                             |
| Page with redirect (Strona zawiera przekierowanie) | `https://drafto.eu/` (possibly)                         | Expected while there is no landing page. Signed-out `/` is a temporary 307 to `/login`, so Google may list it here or fold it into `/login`. The redirect is temporary on purpose, not a fault to fix. |
| Excluded by noindex                                | `/forgot-password` and the other `(auth)` utility pages | Correct                                                                                                                                                                                                |

A new "Duplicate without user-selected canonical" entry means a public page is missing its `alternates.canonical`.

## Code paths

| Concern                         | Path                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical origin, indexed pages | `apps/web/src/lib/site.ts` → `SITE_URL`, `INDEXED_PATHS`                                                                                                                                                                |
| `metadataBase`                  | `apps/web/src/app/layout.tsx`                                                                                                                                                                                           |
| `robots.txt`, `sitemap.xml`     | `apps/web/src/app/robots.ts`, `apps/web/src/app/sitemap.ts`                                                                                                                                                             |
| Auth group noindex default      | `apps/web/src/app/(auth)/layout.tsx`                                                                                                                                                                                    |
| Login / sign-up metadata        | `apps/web/src/app/(auth)/{login,signup}/layout.tsx`. The pages are client components and can't export `metadata`.                                                                                                       |
| Other page canonicals           | `metadata` in `apps/web/src/app/{privacy,support,account/delete}/page.tsx`                                                                                                                                              |
| Middleware skip list            | `apps/web/middleware.ts` → `config.matcher`                                                                                                                                                                             |
| App-link association files      | `apps/web/public/.well-known/`; the AASA `Content-Type` header is set in `apps/web/next.config.ts`                                                                                                                      |
| Tests                           | `__tests__/unit/robots-and-sitemap.test.ts`, `__tests__/unit/middleware-matcher.test.ts`, `__tests__/unit/middleware.test.ts`, `__tests__/integration/seo-metadata.test.tsx`, `e2e/seo.spec.ts` (all under `apps/web/`) |

## Related ADRs

None. This is configuration, not an architectural decision.

## Cross-platform notes

Web only. The native apps depend on it in one way: `apps/mobile/app.config.ts` claims `applinks:drafto.eu` (iOS) and an auto-verified `https://drafto.eu` intent filter (Android). Both verify only if the association file in `/.well-known/` answers 200 to a signed-out request.

## Modifying safely

- **New public page that should be indexed:**
  1. Give it `alternates: { canonical: "<its path>" }` in its `metadata`. For a client page, put the metadata in a sibling `layout.tsx`.
  2. Add its path to `INDEXED_PATHS`. `seo-metadata.test.tsx` fails until the two lists agree.
  3. If it must be reachable signed out, add it to `PUBLIC_ROUTES` ([privacy-policy.md → Modifying safely](./privacy-policy.md#modifying-safely)).
- **New page in the `(auth)` group:** it is noindex unless its own metadata sets `robots: { index: true, follow: true }`.
- **New static file that crawlers or verifiers fetch signed out:**
  - Skip it in `config.matcher`, anchored with `$`, and add a case to `middleware-matcher.test.ts`.
  - Also add it to `PUBLIC_ROUTES` and `middleware.test.ts` as a backstop.
  - Relying on `PUBLIC_ROUTES` alone works, but runs a Supabase session lookup on every fetch.
- **Never** point a canonical or a sitemap entry at `/`, at `www`, or at a preview URL.

## Verify

```bash
# Unit + integration
cd apps/web && pnpm test -- robots-and-sitemap seo-metadata middleware-matcher

# E2E
set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e -- seo

# Live
curl -sI https://drafto.eu/robots.txt | head -1          # 200
curl -sI https://drafto.eu/sitemap.xml | head -1         # 200
curl -s https://drafto.eu/login | grep -o '<link rel="canonical"[^>]*>'
curl -sI https://www.drafto.eu/ | grep -iE '^(HTTP|location)'   # 308 → https://drafto.eu/, no TLS error
curl -sI https://drafto.eu/.well-known/apple-app-site-association | head -1   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://app-site-association.cdn-apple.com/a/v1/drafto.eu  # 200 once Apple's CDN refreshes
```
