# 0049 — Revoke Sign in with Apple Tokens on Account Deletion

- **Status**: Accepted
- **Date**: 2026-10-12
- **Authors**: Jakub Anderwald, with Claude Code

## Context

App Store Review Guideline 5.1.1(v) requires an app that offers Sign in with Apple to revoke the user's Apple tokens through `POST https://appleid.apple.com/auth/revoke` when the account is deleted. [ADR-0038](./0038-account-deletion-endpoint.md) shipped in-app deletion on every platform but left revocation as an open gap, because of three facts:

1. **No Apple token is stored anywhere.** iOS signs in by sending only the identity token to `supabase.auth.signInWithIdToken()` and discards the `authorizationCode`. The browser flows (web, macOS, Apple on Android) let Supabase redeem Apple's code itself, and Supabase keeps no Apple refresh token.
2. **The web API had no Apple key.** `/auth/token` and `/auth/revoke` both need a `client_secret` JWT signed with the Sign in with Apple `.p8` key. Until now only `scripts/apple-client-secret.mjs` signed one, by hand, for Supabase's Apple provider.
3. **App Review tests the iOS app.** The native `expo-apple-authentication` sheet can return a fresh authorization code at any time, without a browser. The browser flows cannot hand the app a code without a `redirect_uri` registered on the Services ID, and Apple accepts no wildcards, so Vercel previews could never test it.

## Decision

**At deletion time, iOS asks Apple for a fresh authorization code and sends it with `DELETE /api/account`. After the account is deleted, the server exchanges the code for a refresh token and revokes it. Revocation is best-effort and never changes the deletion's outcome.**

- **Client (iOS only).** `deleteAccount()` calls `requestAppleRevocationGrant(user)` (`apps/mobile/src/lib/apple-revocation.ts`). For a user with an Apple identity it opens `AppleAuthentication.signInAsync({ requestedScopes: [] })`. The result is `{ authorizationCode, clientId: <bundle ID> }`, or `null` on cancel, failure, Android or a non-Apple user. On `null` the deletion still goes ahead. The delete dialog warns Apple-linked iOS users beforehand that Apple will ask them to confirm, and that cancelling still deletes the account.
- **Wire format.** `requestAccountDeletion` sends the grant as the JSON body `{ "apple": { "authorizationCode", "clientId" } }`. Without a grant there is still no body. The body can never name an account; the user id still comes only from the verified credential.
- **Server.** `readAppleRevocationGrant` parses the body leniently. A malformed body is reported to Sentry without its contents and treated as no grant. Only after `deleteUserAccount` succeeds, `revokeAppleSignIn` (`apps/web/src/lib/apple/revoke.ts`) does the following:
  - skips with a Sentry warning when the key is missing, the client is not `eu.drafto.mobile`, or the account has no Apple identity;
  - signs a 5-minute ES256 client secret;
  - POSTs the code to `/auth/token`;
  - POSTs the refresh token to `/auth/revoke`;
  - compares the ID token's `sub` with the account's Apple identities, taken from the user verified at the start of the request. On a mismatch (a phone signed in to a different Apple ID) the token is still revoked, because Apple's sheet may have just authorized Drafto for that ID. The outcome is reported as a warning, since the account's own authorization stays.

  Each call has a 5-second timeout. The function never throws. Codes, tokens and the client secret are never sent to Sentry or logs.

- **Revoke after deleting, synchronously.** Revoking only once the account is gone means a failed deletion never leaves a live account with a revoked Apple sign-in. The call is awaited before the response, rather than deferred with `after()`, so Sentry reports flush inside the request and the tests stay deterministic. The cost is up to 10 seconds of extra latency when Apple is slow. The route exports `maxDuration = 60` and gives the revocation a deadline 5 seconds short of it. Each Apple call's timeout is cut to fit, and no call starts with less than a second left, so a slow deletion plus a slow Apple can never push a completed deletion past the platform's function limit.
- **One signer.** The ES256 signer moved to `apps/web/src/lib/apple/client-secret.mjs`, which is type-checked JavaScript so plain `node` can import it. `scripts/apple-client-secret.mjs` re-exports it. The client IDs are code constants, not variables: `APPLE_NATIVE_CLIENT_ID` in `@drafto/shared`, which the iOS app sends and the server checks, and `APPLE_SERVICES_ID` in `client-secret.mjs`, the script's default.
- **Configuration.** Three optional server-only variables hold the key: `APPLE_TEAM_ID`, `APPLE_SIGN_IN_KEY_ID` and `APPLE_SIGN_IN_PRIVATE_KEY`. The private key is a multi-line PEM, and literal `\n` escapes are accepted too. Revocation runs only when all three are set. They are set in Vercel for Production and Preview, and unset locally and in CI.
- **Web, Android and macOS are deferred** to [#705](https://github.com/JakubAnderwald/drafto/issues/705). Their deletion is unchanged. `/account/delete` tells their Apple-linked users how to remove Drafto from their Apple ID by hand.

## Consequences

- **Positive**:
  - The platform App Review tests meets 5.1.1(v), with no schema change, no stored Apple token and no new paid service. Apple's endpoints are free.
  - The flow never leaves behind an Apple authorization it created, even when the phone is signed in to a different Apple ID.
  - Deletion can never fail or be blocked because of Apple: missing keys, a cancelled sheet, Apple errors and timeouts all still delete the account.
  - The secret signer has one implementation for the rotation script and the server.
- **Negative**:
  - Apple-linked users on iOS see one more system sheet during deletion.
  - Revocation is not guaranteed. A cancelled sheet, an Apple outage or a missing key leaves the authorization in place, visible only in Sentry.
  - Web, Android and macOS do not revoke yet, which only the manual instructions on `/account/delete` mitigate.
  - The `.p8` key now lives in a second place (Vercel), so a new key must be updated there too.
  - A slow Apple can add up to 10 seconds to a successful deletion response.
  - On a phone signed in to a different Apple ID, that ID's Drafto authorization is revoked while the account's own stays. That ID only sees a fresh consent prompt at its next Apple sign-in.
- **Neutral**:
  - `DELETE /api/account` now reads an optional body. The user id still comes only from the credential.
  - `authenticateAccountRequest` returns the verified Supabase user instead of only its id, so the route can read its Apple identities before the user is deleted.
  - Sending user data to Apple is not new: Apple was already a processor for Sign in with Apple. The privacy policy now says deletion also asks Apple to revoke Drafto's access.

## Alternatives Considered

- **Store Apple refresh tokens at sign-in.** It would let every platform revoke without re-authentication. Rejected: it needs a schema change and a secret column, and it needs a provider-token capture on each platform's sign-in path. iOS would also have to start redeeming its code at sign-in. That is much more surface for a token used only once, at deletion.
- **Revoke before deleting.** Rejected: if the deletion then failed, the user would keep an account whose Apple authorization was gone.
- **Defer revocation with `after()`.** It would return the deletion response sooner. Rejected for now: events captured after the response may not flush before the function freezes, and the tests would need to drive the deferred work. Worth revisiting if Apple latency becomes a problem.
- **Skip revocation when the Apple ID does not match.** It would never touch an Apple ID the account was not linked to. Rejected: Apple's sheet may have just authorized Drafto for the phone's Apple ID, and skipping would leave that new authorization behind, the opposite of what the guideline asks. Revoking it costs that Apple ID only a consent prompt, and the person on the phone has just authenticated as it.
- **Sign in with Apple JS on the web, now.** The Services ID would need `drafto.eu` and a new return URL registered in the Apple Developer portal. That registration cannot cover Vercel previews, and the change would load a third-party script on `/settings`. Deferred to #705 with Android and macOS, which need the same registration.
- **Block deletion until revocation succeeds.** Rejected: Apple's availability would then decide whether a user can delete their account, and a user without the Apple ID at hand could never delete.
