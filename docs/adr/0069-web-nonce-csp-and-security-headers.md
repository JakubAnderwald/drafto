# 0069 — Web Nonce CSP and Security Headers

- **Status**: Accepted
- **Date**: 2026-11-09
- **Authors**: Jakub Anderwald, Claude

## Context

The web app at drafto.eu renders user-generated note content, but its responses carried no HTTP security headers. `next.config.ts` set only a `Content-Type` for the apple-app-site-association file. So:

- there was no `frame-ancestors` or `X-Frame-Options`, and any site could frame the signed-in app (clickjacking);
- there was no Content-Security-Policy as a second line of defence behind any XSS sink in note rendering;
- there was no HSTS, `Referrer-Policy`, `X-Content-Type-Options` or `Permissions-Policy`.

A useful CSP has to block inline scripts. The root layout injects one, the theme-detection script that sets `dark` before first paint, and Next.js adds its own inline scripts (the RSC payload) to every page. A static allowlist can't cover those. Next.js supports a nonce instead: when the request it renders carries a `content-security-policy` header with a `'nonce-…'` source in `script-src`, it puts that nonce on every script it emits.

[#492](https://github.com/JakubAnderwald/drafto/issues/492) asked for the headers. The plan's design was checked on two Vercel previews by the plan-stage browser probe ([ADR-0071](./0071-plan-stage-browser-probe.md)).

## Decision

1. **A per-request nonce policy, from the middleware.** `src/middleware.ts` generates a 128-bit nonce (`crypto.getRandomValues`, base64) and builds the policy with `buildContentSecurityPolicy` (`src/lib/security/content-security-policy.ts`). It first deletes any `x-nonce`, `content-security-policy` or `content-security-policy-report-only` header the client sent. It then sets its own `x-nonce` and `content-security-policy` on `request.headers`, calls `updateSession`, and sets the policy on whatever response comes back: page, rewrite, redirect or API error.
   - `updateSession` already forwards `request` when it renders, because that is how refreshed Supabase cookies reach the page. The nonce rides along. The one exception was the signed-out `/` → `/welcome` rewrite: a bare `NextResponse.rewrite(url)` forwards no request headers, so it now passes `{ request: { headers: request.headers } }`.
   - Next.js reads the nonce from the forwarded policy for its own scripts. The root layout reads `x-nonce` with `headers()` and puts it on the theme script.

2. **The policy.**
   - `default-src 'self'`
   - `script-src 'self' 'nonce-…' 'strict-dynamic'`, plus `'unsafe-eval'` under `next dev` only. `'strict-dynamic'` lets the trusted scripts load the rest: Next's chunks, PostHog, Sign in with Apple JS.
   - `style-src 'self' 'unsafe-inline'`, with no nonce. A browser ignores `'unsafe-inline'` in a directive that also has a nonce, and Mantine and BlockNote set inline styles.
   - `img-src 'self' blob: data: <supabase> https:` and `media-src 'self' blob: <supabase> https:`. `https:` is there because the editor renders remote image, video and audio URLs (BlockNote's Embed tab, pasted HTML, MCP markdown) as they are.
   - `font-src 'self'`, since next/font self-hosts.
   - `connect-src 'self' <supabase> wss://<supabase-host> <posthog-host> https://*.posthog.com https://*.ingest.de.sentry.io`. The `wss:` entry is the realtime channel of an open note.
   - `worker-src 'self' blob:` for Sentry Replay and PostHog's recorder.
   - `object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
   - No `report-uri` or `report-to`: a reporting endpoint would be new infrastructure.

3. **Static headers from `next.config.ts`.** On `/:path*`: `Strict-Transport-Security: max-age=63072000; includeSubDomains` (no `preload`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. Paths the middleware matcher skips get these too, but no CSP.

4. **Header precedence decides two exceptions.** `next start` and Vercel write the config headers and the middleware's response headers before a route handler runs, then skip any header the handler sets that is already there. So a route handler can't override them. The Sign in with Apple relay (`/auth/apple/revocation`) sends its own hash-based CSP and `Referrer-Policy: no-referrer`:
   - the middleware puts neither a nonce nor a CSP on routes listed in `setsOwnContentSecurityPolicy`, which holds the relay;
   - a `next.config.ts` entry after `/:path*` sets `Referrer-Policy: no-referrer` on the relay. When two entries set the same header for a path, the later one wins.

5. **Every page renders per request.** `await headers()` in the root layout takes the whole tree out of static generation. Nonces need that: a page prerendered at build time has no nonce on its scripts, and the policy would block them.

## Consequences

- **Positive**: The signed-in app can't be framed. An injected `<script>` in server-rendered HTML doesn't run: the E2E positive control (`e2e/security-headers.spec.ts`) serves `/login` with an unsigned inline script and the real header, and checks the browser blocks it and reports the violation. Browsers get HSTS, MIME sniffing is off, and referrers to other origins carry only the origin.
- **Negative**:
  - The pages that were static (`/welcome`, `/privacy`, `/support`, `/account/delete`, the auth pages, `/auth/desktop/[flow]`, the 404, which MCP OAuth probes hit often) now render on the server for each request. That costs Vercel function invocations and Active CPU against the Hobby cap. Check usage a week after the merge; if it climbs, the probe paths could get a bare 404.
  - The Vercel toolbar doesn't load on previews: its frame (`frame-src https://vercel.live`) falls back to `default-src 'self'`. Production has no toolbar.
  - HSTS with `includeSubDomains` and a two-year max-age is slow to undo. Every drafto.eu subdomain must serve HTTPS.
  - A new third-party origin the browser talks to (an analytics host, a CDN, an embed) now needs a matching entry in `buildContentSecurityPolicy`, or the browser blocks it. A violation names the directive and the blocked source in the console.
- **Neutral**: The relay keeps exactly its own policy. Native apps are unaffected; they get no HTML responses.

## Alternatives Considered

- **A hash-based policy without a nonce.** It needs no per-request rendering, but Next's RSC payload scripts change with every page, so they can't be hashed ahead of time. Rejected.
- **A static policy with `'unsafe-inline'` in `script-src`.** Pages could stay static, but the policy would no longer stop an injected inline script, which is the point of having one. Rejected.
- **`Content-Security-Policy-Report-Only` first.** Reports need an endpoint, which is out of scope, and the plan-stage probe already showed the enforced policy blocks nothing the app loads. Rejected.
- **The whole policy in `next.config.ts`.** Config headers are static, so they can't carry a per-request nonce. Only the static headers live there.
