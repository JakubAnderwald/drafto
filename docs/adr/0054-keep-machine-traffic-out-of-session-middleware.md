# 0054 — Keep Machine Traffic Out of the Session Middleware

- **Status**: Accepted
- **Date**: 2026-10-24
- **Authors**: Jakub Anderwald, Claude

## Context

The Vercel team behind drafto.eu is on the Hobby plan. It includes 4 hours of Fluid Active CPU per 30 days, and when that runs out every project on the team is paused. On 2026-10-21 Vercel warned that 75% was used, the third such warning since September.

Usage over the 30 days to 2026-10-23 was 3h15m: 2h22m for drafto, 53m for routista.

- Middleware was 2h04m of drafto's 2h22m. Each run costs roughly 100 ms of CPU, mostly from the Sentry-traced edge bundle and building the Supabase client.
- An hour of production logs showed about 100 middleware runs. About 94% came from one MCP client with an invalid API key:
  - `POST /api/mcp` returned 401 about once a minute, in bursts of about 20 a second.
  - After each 401 the client probed `/.well-known/oauth-protected-resource[/api/mcp]`, `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`.
  - Each probe ran the Supabase session lookup, got a 307 to `/login`, and `fetch` followed it into a second middleware run.
- If discovery finds nothing, the MCP SDK falls back to `/register`, `/authorize` and `/token` at the site root, so stopping discovery alone would only have moved the loop.
- The only previous exclusion of this kind is `/api/health` (uptime checks). Static assets were already skipped.

## Decision

1. `config.matcher` in `apps/web/middleware.ts` also skips:
   - `/api/mcp` and `/api/mcp/*`: the route authenticates its own Bearer API key, and MCP clients send no cookie;
   - `/.well-known/oauth-*` and `/.well-known/openid-configuration`;
   - exactly `/register`, `/authorize` and `/token`.

   None of these OAuth paths is a route, so each becomes a static 404. Every exclusion is anchored or bounded, so lookalike paths and any future `/.well-known/*` route still run the middleware.

2. `updateSession` builds the Supabase client only when the request has an `sb-*` cookie. Without one, `getUser()` could only return no user, so the request goes straight to the existing signed-out branches:
   - public route → pass through
   - `/` → landing page rewrite
   - anything else → `/login`

   Crawlers, bot probes and signed-out visitors take this path.

Sentry tracing stays at 100%; reducing it was considered and declined.

## Consequences

- **Positive**:
  - The MCP retry loop no longer reaches middleware at all; only the `/api/mcp` function itself runs, and it answers 401 without Supabase work beyond the key lookup.
  - Signed-out traffic no longer builds a Supabase client.
  - Expected drafto Active CPU drops from about 2h20m to under an hour per 30 days, which keeps the team well under the pause limit.
- **Negative**:
  - The early exit depends on @supabase/ssr's default cookie name prefix (`sb-`). If a client ever sets `cookieOptions.name`, `hasSupabaseCookie` must change with it, or every signed-in request looks signed out.
  - The OAuth probe exclusions are not in `PUBLIC_ROUTES`. If a matcher edit drops them, they go back to a 307 to `/login`. That is safe, just costly.
  - Requests that skip middleware never get their `x-verified-*` headers overwritten. No skipped path reads them today, and the existing rule stands: only routes behind the session gate may use `getAuthenticatedUserFast`.
- **Neutral**:
  - ADR-0050 says signed-out `/` "costs the same middleware run as before". It still runs middleware, now without the Supabase client.

## Alternatives Considered

- **Answer an invalid API key with 403 instead of 401.** The MCP SDK only starts OAuth after a 401, so this would stop the probing at its source. Rejected: the MCP authorization spec says invalid or expired tokens get 401, and spec-following clients could misreport a revoked key.
- **Skip all of `/.well-known/`.** Simpler, but a future `/.well-known/*` route would then skip the session gate, and forged `x-verified-*` headers would reach it untouched.
- **Upgrade to Vercel Pro.** It removes the cap but adds a monthly bill, against the repo's [infrastructure cost discipline](../../CLAUDE.md#infrastructure-cost-discipline).
- **Lower Sentry `tracesSampleRate`.** It would cut CPU per run, but the owner wants full tracing.
