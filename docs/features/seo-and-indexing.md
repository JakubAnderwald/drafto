# SEO and indexing

**Status:** shipped **Updated:** 2026-10-17

## What it is

How drafto.eu presents itself to search engines and app-link verifiers:

- the canonical host
- the public landing page at `/` for signed-out visitors
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
- **Landing page at `/`** ([ADR-0050](../adr/0050-public-landing-page-via-middleware-rewrite.md)):
  - Signed-out `/` is rewritten (200, the URL stays `/`) to `src/app/welcome/page.tsx`, a static page: what Drafto is, its features, Sign up / Log in, and links to the privacy policy and support page.
  - Signed-in `/` is the app, as before. The branch is in `updateSession` (`src/lib/supabase/middleware.ts`).
  - A direct request for `/welcome` gets a 308 to `/`, so the page has one public URL. It declares `/` as its canonical.
  - Until 2026-10-17, signed-out `/` was a 307 to `/login`. Google then indexed the login form under `/` and overrode `/login`'s self-canonical ("Duplicate, Google chose different canonical than user").
- **Indexed pages:**
  - `/`, `/login`, `/signup`, `/privacy`, `/support` and `/account/delete` each declare themselves canonical. For `/`, the declaration is on the landing page.
  - They are listed in `INDEXED_PATHS`, which feeds the sitemap.
- **Not indexed:**
  - Every other page in the `(auth)` route group (forgot/reset password, waiting for approval, the desktop hand-off) inherits `noindex, follow` from the group layout.
  - The app itself sits behind the session redirect.
- **`robots.txt`:** allows everything except `/api/` and points at the sitemap.
- **Files middleware skips:**
  - `/robots.txt`, `/sitemap.xml` and everything under `/.well-known/` bypass the session middleware, along with `/api/health`, `/api/mcp` and static assets.
  - Crawlers and the Apple and Google app-link verifiers come signed out and do not follow a 307 to `/login`.
  - `/robots.txt`, `/sitemap.xml` and the two app-link association files are also in `PUBLIC_ROUTES` as a backstop.
  - A `/.well-known/*` path with no file behind it, such as the OAuth discovery paths MCP clients probe, gets a static 404.
  - Signed-out visitors and crawlers on any other path still run the middleware, but without a Supabase cookie it skips the session lookup.

### Expected Search Console state

| Report                                             | URLs                                                      | Meaning                                                                                                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Indexed                                            | The `INDEXED_PATHS` pages, `https://drafto.eu/` included  | Correct                                                                                                                                                                                   |
| Page with redirect (Strona zawiera przekierowanie) | `http://drafto.eu/`, `https://www.drafto.eu/`, `/welcome` | Correct. These are permanent 308 redirects (protocol, host, and the landing page's own route), so the URLs are never indexed. Don't start "Validate fix" on this group: it can only fail. |
| Excluded by noindex                                | `/forgot-password` and the other `(auth)` utility pages   | Correct                                                                                                                                                                                   |

- A new "Duplicate without user-selected canonical" entry means a public page is missing its `alternates.canonical`.
- "Duplicate, Google chose different canonical than user" on `/login` dates from the 307 era, before 2026-10-17. It should clear once Google recrawls `/` and finds the landing page.
  - If it comes back, check that signed-out `/` still answers 200 with `<link rel="canonical" href="https://drafto.eu"/>` (Next.js drops the trailing slash on the root URL; it is the same URL).
  - Also check that its content still differs clearly from `/login`.

## Code paths

| Concern                         | Path                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical origin, indexed pages | `apps/web/src/lib/site.ts` → `SITE_URL`, `INDEXED_PATHS`                                                                                                                                                                                                                                                                           |
| Landing page                    | `apps/web/src/app/welcome/page.tsx`, `apps/web/src/components/landing/`, `apps/web/src/components/legal/legal-links.tsx`, `.brand-backdrop`/`.brand-wordmark` in `globals.css`, `apps/web/src/lib/auth/enter-app.ts`. The rewrite and the `/welcome` redirect live in `updateSession` (`apps/web/src/lib/supabase/middleware.ts`). |
| `metadataBase`                  | `apps/web/src/app/layout.tsx`                                                                                                                                                                                                                                                                                                      |
| `robots.txt`, `sitemap.xml`     | `apps/web/src/app/robots.ts`, `apps/web/src/app/sitemap.ts`                                                                                                                                                                                                                                                                        |
| Auth group noindex default      | `apps/web/src/app/(auth)/layout.tsx`                                                                                                                                                                                                                                                                                               |
| Login / sign-up metadata        | `apps/web/src/app/(auth)/{login,signup}/layout.tsx`. The pages are client components and can't export `metadata`.                                                                                                                                                                                                                  |
| Other page canonicals           | `metadata` in `apps/web/src/app/{privacy,support,account/delete}/page.tsx`                                                                                                                                                                                                                                                         |
| Middleware skip list            | `apps/web/middleware.ts` → `config.matcher`                                                                                                                                                                                                                                                                                        |
| App-link association files      | `apps/web/public/.well-known/`; the AASA `Content-Type` header is set in `apps/web/next.config.ts`                                                                                                                                                                                                                                 |
| Tests                           | `__tests__/unit/robots-and-sitemap.test.ts`, `__tests__/unit/middleware-matcher.test.ts`, `__tests__/unit/middleware.test.ts`, `__tests__/unit/landing-page.test.tsx`, `__tests__/integration/seo-metadata.test.tsx`, `e2e/seo.spec.ts`, `e2e/landing.spec.ts` (all under `apps/web/`)                                             |

## Related ADRs

- [ADR-0050](../adr/0050-public-landing-page-via-middleware-rewrite.md): signed-out `/` serves a public landing page through a middleware rewrite.

## Cross-platform notes

Web only. The native apps depend on it in one way: `apps/mobile/app.config.ts` claims `applinks:drafto.eu` (iOS) and an auto-verified `https://drafto.eu` intent filter (Android). Both verify only if the association file in `/.well-known/` answers 200 to a signed-out request.

## Modifying safely

- **New public page that should be indexed:**
  1. Give it `alternates: { canonical: "<its path>" }` in its `metadata`. For a client page, put the metadata in a sibling `layout.tsx`.
  2. Add its path to `INDEXED_PATHS`. `seo-metadata.test.tsx` fails until the two lists agree.
  3. If it must be reachable signed out, add it to `PUBLIC_ROUTES` ([privacy-policy.md → Modifying safely](./privacy-policy.md#modifying-safely)).
- **New page in the `(auth)` group:** it is noindex unless its own metadata sets `robots: { index: true, follow: true }`.
- **New static file that crawlers or verifiers fetch signed out:**
  - Under `/.well-known/` it already skips middleware.
  - Anywhere else, skip it in `config.matcher`, anchored with `$`, and add a case to `middleware-matcher.test.ts`.
  - Also add it to `PUBLIC_ROUTES` and `middleware.test.ts` as a backstop.
  - Relying on `PUBLIC_ROUTES` alone works, but bills a middleware run on every fetch.
- **Landing page copy:**
  - Keep `LANDING_FEATURES` true on the platforms each entry names, for example "offline" applies to the native apps only.
  - Keep the sign-up note about approval as long as sign-up is gated ([email-and-approval.md](./email-and-approval.md)).
- **New client-side sign-in path:** enter the app with `enterApp()` (`src/lib/auth/enter-app.ts`), a full page load, as the login and reset-password pages do. Don't use `router.push("/")`: the client router may still map `/` to the landing page.
- **Dark mode:** the signed-out pages use `.brand-backdrop` and `.brand-wordmark` from `globals.css`. They switch with the `.dark` class; the raw `primary-50`/`secondary-50` tints don't.
- **Only** the landing page declares `/` as its canonical. Never point a canonical or a sitemap entry at `/welcome`, at `www`, or at a preview URL.

## Verify

```bash
# Unit + integration
cd apps/web && pnpm test -- robots-and-sitemap seo-metadata middleware landing-page

# E2E
set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e -- seo landing

# Live
curl -sI https://drafto.eu/ | head -1                    # 200 signed out (the landing page), not a 307
curl -s https://drafto.eu/ | grep -o '<link rel="canonical"[^>]*>'   # href="https://drafto.eu" (root URL, no trailing slash)
curl -sI https://drafto.eu/welcome | grep -iE '^(HTTP|location)'    # 308 → /
curl -sI https://drafto.eu/robots.txt | head -1          # 200
curl -sI https://drafto.eu/sitemap.xml | head -1         # 200
curl -s https://drafto.eu/login | grep -o '<link rel="canonical"[^>]*>'
curl -sI https://www.drafto.eu/ | grep -iE '^(HTTP|location)'   # 308 → https://drafto.eu/, no TLS error
curl -sI https://drafto.eu/.well-known/apple-app-site-association | head -1   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://app-site-association.cdn-apple.com/a/v1/drafto.eu  # 200 once Apple's CDN refreshes
```
