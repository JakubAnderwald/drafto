# 0064 — Revoke Sign in with Apple on Web, Android and macOS

- **Status**: Accepted
- **Date**: 2026-11-01
- **Authors**: Jakub Anderwald, with Claude Code

## Context

[ADR-0049](./0049-apple-token-revocation-on-account-deletion.md) made iOS revoke the user's Sign in with Apple tokens on account deletion: the native sheet returns a fresh authorization code, the app sends it with `DELETE /api/account`, and the server redeems and revokes it after the account is gone. Web, Android and macOS were deferred to [#705](https://github.com/JakubAnderwald/drafto/issues/705), because:

1. They sign in with Apple through Supabase's browser flow, which never hands the app an Apple code, and Supabase keeps no Apple refresh token. There is still nothing stored to revoke.
2. None of them has a native Apple sheet. A browser authorization needs a `redirect_uri` registered on the Services ID `eu.drafto.web.auth`, and Apple accepts no wildcards, so Vercel previews can never use it.
3. Apple's code must not leak. A code in a URL ends up in Vercel request logs, Sentry page URLs and browser history, and anyone holding it within 5 minutes can redeem it.
4. The app that starts the deletion must learn its outcome, so mobile and desktop can wipe their local data.

## Decision

**At deletion time each platform gets a fresh authorization code for the Services ID `eu.drafto.web.auth` and sends it in the existing body, `{ "apple": { authorizationCode, clientId } }`. The server redeems and revokes it after the deletion, exactly as for iOS. All three platforms share one return URL, `https://drafto.eu/auth/apple/revocation`, defined once in `@drafto/shared` (`APPLE_REVOCATION_REDIRECT_URI`).**

- **Web.** Sign in with Apple JS in popup mode (`usePopup: true`, no scopes). The result comes back to `/settings` by `postMessage` (`web_message`), so the code never appears in a drafto.eu URL. Apple posts the popup's result to the return URL's origin, so the step runs only on the `https://drafto.eu` origin; previews, localhost and other origins skip it and delete as before. The script (`appleid.auth.js` from `appleid.cdn-apple.com`) loads on demand, only when an Apple-linked user opens the delete dialog, and `signIn()` runs synchronously inside the click so popup blockers allow it.
- **Android.** The app opens Apple's authorize URL with `WebBrowser.openAuthSessionAsync` (`response_type=code`, `response_mode=form_post`, no scope, `state=android.<nonce>`). Apple POSTs the code to the relay, which answers `303` to `drafto://auth/apple-revocation?code=…&state=…`. Supabase's Apple sign-in on Android already ends with a server redirect to the scheme, so the pattern is known to work.
- **macOS.** The app opens the same URL with `Linking.openURL` (`state=macos.<nonce>`). The relay answers with a small HTML page that opens `eu.drafto.desktop://auth/apple-revocation?…`, because a redirect straight to the scheme freezes the tab ([ADR-0044](./0044-desktop-auth-web-handoff.md)). Closing the tab tells the app nothing, so the panel waits with **Continue without Apple** (deletes now, without revocation) and **Cancel** (deletes nothing). There is no timeout.
- **The relay** (`apps/web/src/app/auth/apple/revocation/route.ts`) is a public `POST` route. It validates `code`, `state` and `error` strictly and forwards only those three. It picks the scheme from the state's platform tag, never from input, so it cannot become an open redirect. The macOS page is sent with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` and a per-response CSP. It never logs or reports a field value. `form_post` keeps the code in a POST body, a `Location` header and an app deep link, never in a URL that Vercel or Sentry records.
- **The relay does not redeem the code.** The app sends it with the deletion request, and the server redeems it only after the account is deleted. That keeps ADR-0049's order (delete, then revoke) and holds no token between requests.
- **Server.** `revokeAppleSignIn` accepts `eu.drafto.web.auth` as well as `eu.drafto.mobile`. For a Services ID code it sends `redirect_uri: APPLE_REVOCATION_REDIRECT_URI` to `/auth/token`, as Apple requires; native codes still go without one.
- **Sentry.** `apps/web/src/lib/sentry/scrub-apple-grant.ts` drops `request.data` and `query_string` from server events for `/api/account` and `/auth/apple/revocation`. This covers the iOS code in the deletion body too.

## Consequences

- **Positive**:
  - All four platforms ask Apple to end Drafto's access on deletion, with no schema change, no stored token and no new paid service.
  - The code never appears in a URL that Vercel, Sentry or browser history records.
  - Deletion still never depends on Apple: a cancelled step, a missing script, an Apple error or a dead relay all still delete the account (on macOS, after **Continue without Apple**).
- **Negative**:
  - **Operator prerequisite.** Nothing is revoked until the domain `drafto.eu` and the return URL `https://drafto.eu/auth/apple/revocation` are registered on the Services ID `eu.drafto.web.auth`. Until then Apple rejects the authorize request and every platform deletes without revocation.
  - **Previews cannot test it end to end.** Apple accepts no wildcard return URLs, and the web step is gated to the drafto.eu origin. Only prod can prove revocation, with throwaway Apple-linked accounts.
  - **Deploy order.** The relay always runs on prod drafto.eu, so it must be live there before an Android or macOS build that uses it reaches testers. A pre-merge beta ([ADR-0030](./0030-in-test-scenarios-and-pre-merge-betas.md)) reaches a missing relay and falls back to deleting without revocation.
  - **Android process death.** If Android kills the app while Apple's page is open, the in-memory deletion is lost. The late deep link is swallowed, the account is not deleted, and the user retries.
  - **macOS needs an explicit choice.** The waiting state has no timeout, because an automatic timeout would delete the account with no one watching.
  - **Revocation might not clear the list.** Whether revoking a Services ID token removes Drafto from the Apple ID's "Sign in with Apple" list (iOS revokes a bundle-ID token) is unverified until the first prod deletion.
  - A third-party script from Apple loads on `/settings` for Apple-linked users who open the delete dialog on drafto.eu, so Apple receives their IP address and browser details. The privacy policy says so.
- **Neutral**:
  - `/auth/apple/revocation` is a new public route that anyone can POST to. Strict validation, escaping, a fixed scheme per platform tag and the CSP keep it from being an XSS or open-redirect vector.
  - The delete notice has three variants (`sheet`, `popup`, `browser`) from `appleDeletionNotice` in `@drafto/shared`.

## Alternatives Considered

- **Run the whole deletion on a drafto.eu page.** The app would open drafto.eu, the user would confirm with Apple there, and the page would delete. Rejected: the browser holds no Drafto session for a mobile or desktop user, and the app would never learn the outcome, so it could not wipe its local data.
- **Redeem the code in the relay.** Rejected: it would either revoke before the deletion, which ADR-0049 rejects, or hold a token between requests until the app sends the deletion.
- **Store Apple refresh tokens at sign-in.** It would let every platform revoke without re-authentication. Rejected, as in ADR-0049: it needs a schema change, a secret column and a provider-token capture on every sign-in path. Out of scope for #705.
- **`query` or `fragment` response modes.** They would need no relay route. Rejected: a code in the query reaches Vercel request logs, and a code in the fragment reaches the page, Sentry page URLs and browser history. `form_post` keeps it in a POST body.
