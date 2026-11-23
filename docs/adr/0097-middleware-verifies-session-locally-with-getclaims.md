# 0097 — Middleware Verifies the Session Locally with getClaims

- **Status**: Accepted
- **Date**: 2026-11-23
- **Authors**: Jakub Anderwald (with Claude Code)
- **Issue**: [#913](https://github.com/JakubAnderwald/drafto/issues/913)
- **Related**: [0054](./0054-keep-machine-traffic-out-of-session-middleware.md) (which describes the middleware's old `getUser()` call; left unchanged, as ADRs are append-only), [0094](./0094-open-signup-with-admin-suspend.md) (suspension through `is_approved`)

## Context

The web middleware (`updateSession` in `apps/web/src/lib/supabase/middleware.ts`) called `supabase.auth.getUser()` on every request that carried an `sb-*` cookie. That is a network round-trip to Supabase Auth (`GET /auth/v1/user`). Each one writes an API-gateway log line and an Auth log line.

On drafto-dev over 24 hours (2026-11-22) the gateway served 124.5k requests. About 59k came from the middleware (`user-agent: Next.js Middleware`): 29.6k `GET /auth/v1/user` and 29.6k `GET /rest/v1/profiles`. Auth wrote about 33k log entries. About 70% of the requests came from GitHub Actions runners (CI E2E).

The Free plan's log-ingestion quota is 1 GB per organization per billing cycle. It is not enforced until early 2027. The org is at 1.11 GB, 98% of it from drafto-dev. Once the quota is enforced, an org over it can be restricted, and that would restrict prod too, since both projects share the org.

The project signs access tokens with ES256, and each token carries a `kid`. A token signed that way can be checked against the project's public keys without asking Auth.

## Decision

The middleware gets its user from `getVerifiedSessionUser(supabase.auth)` (`apps/web/src/lib/supabase/session-claims.ts`). It calls `supabase.auth.getClaims()` with no argument.

- `getClaims()` first runs `getSession()`. That refreshes a session that is about to expire and writes the new cookies through the same `setAll`, so refresh works as before.
- It then checks the access token's signature against the project's JWKS (`/auth/v1/.well-known/jwks.json`). auth-js caches the JWKS module-globally for 10 minutes, so a warm middleware instance makes no Auth call per request.
- The user id is the verified `sub` claim. The email is the `email` claim, or `""` when it is missing.

The user is signed out (`null`) when:

- there is no session, or the refresh failed;
- `getClaims()` returns any `AuthError`: a bad signature, an expired or malformed token, a JWKS fetch failure;
- `getClaims()` throws an error that isn't an auth error. auth-js re-throws those, and a tampered cookie can reach some: an unknown `alg` sent with a real `kid`, a header that isn't JSON, a key-type mismatch in `crypto.subtle.importKey`. The helper logs every such error with `console.error`, reports it to Sentry at most once a minute per instance (anyone can send such a cookie, so every one would use up the quota), and returns `null`, so the answer is signed out rather than a 500;
- `sub` isn't a non-empty string. (A legacy `service_role` or anon key is HS256-signed, so `getClaims()` asks Auth about it, and Auth rejects it before this check runs; the check is a second line of defence.)

Everything else in the middleware is unchanged: the public routes, the signed-out `/` landing rewrite, the 401 / `/login` answers, the `profiles.is_approved` query (still once per request), `/waiting-for-approval`, and the `x-verified-user-id` / `x-verified-user-email` headers.

## Consequences

- **Positive**: a warm instance verifies a session with no Auth call. For the dev numbers above, that removes about 29.6k `GET /auth/v1/user` requests a day, with their gateway and Auth log lines. The `profiles` query stays.
- **Positive**: middleware runs faster and uses less Vercel Active CPU, which Hobby caps.
- **Negative (revocation window)**: a session revoked on the server (sign-out on another device, a ban) keeps passing the middleware's token check until its access token expires. That is at most `jwt_expiry`, 3600 s in `supabase/config.toml`. The `profiles` query still runs on every request from a verified user to a route that isn't public, so a suspension (`is_approved = false`, ADR 0094) and a deleted account (no row, so `.single()` errors and the user goes to `/login`) still take effect at once. RLS still checks the token on every data query, that `profiles` query included.
- **Negative (silent fallback)**: `getClaims()` falls back to a `getUser(token)` network call when the token is HS-signed, has no `kid`, has a `kid` that isn't in the JWKS, or WebCrypto is unavailable. The result is still correct, but nothing is saved. If prod still signs with the legacy HS256 secret, prod takes this fallback: no regression, and no saving. A forged token with an unknown `kid` forces a JWKS refetch plus an Auth call, which is no more than what every request cost before.
- **Negative (JWKS cache)**: each middleware instance fetches `GET /auth/v1/.well-known/jwks.json` once per 10 minutes. A JWKS outage signs requests out, as an Auth outage did before. After a signing-key rotation, a revoked key stays trusted for up to 10 minutes from the cache.
- **Negative (stale email)**: the `email` claim can be up to an hour out of date after an email change. Only `getAuthenticatedUserFast` (`apps/web/src/lib/api/utils.ts`) reads `x-verified-user-email`, and none of its callers reads `user.email`. `(app)/layout.tsx` reads only the id. `authenticateAccountRequest` (`/api/account`) reads neither header.
- **Neutral (privacy)**: this doesn't change the auth or session-storage mechanism for the privacy policy. Sessions stay in the same `sb-*` cookies, written through the same `setAll`. There is no new processor: the JWKS is a public key from the same Supabase project, and the request carries no user data.

## Alternatives Considered

1. **Keep `getUser()`.** It costs an Auth call and two log lines per request, and keeps the org close to the log-ingestion quota. Rejected.
2. **`getClaims(jwt)` with the access token read from the cookie.** It verifies the same way, but skips `getSession()`, so an expiring session would never be refreshed. Rejected.
3. **Cache `getUser()` results per token in the middleware.** It needs state across instances, still makes a call per instance and token, and is more code than calling `getClaims()`. Rejected.
4. **Drop the `profiles` query too.** Out of scope: it is the approval and suspension gate.
5. **Move drafto-dev to its own Supabase org.** It would keep dev's logs off prod's quota, but it is a separate decision. Out of scope here.
