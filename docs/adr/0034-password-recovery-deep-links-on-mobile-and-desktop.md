# 0034 — Password Recovery via Custom-Scheme Deep Links on Mobile and Desktop

- **Status**: Accepted
- **Date**: 2026-09-11
- **Authors**: Drafto dark factory (issue [#537](https://github.com/JakubAnderwald/drafto/issues/537))

## Context

Forgot-password existed only on the web app. A user who forgot their password on iOS, Android, or macOS was locked out until they switched to a browser.

Porting the two web screens is the easy half. The hard half is that **a Supabase recovery session is an ordinary authenticated session**. The moment the recovery link is consumed, `user` is set and `is_approved` resolves — at which point:

- `apps/mobile/app/_layout.tsx`'s `RouteGuard` redirects any authenticated user out of the `(auth)` group into `/(tabs)`, and
- `apps/desktop/src/navigation/app-navigator.tsx` renders `MainScreen` on `user && isApproved`, or `WaitingForApprovalScreen` on `user && !isApproved`.

Either way the reset screen is unreachable and the user lands in the app holding a password they never set. The screens were never the defect surface; the route guards were.

Three further constraints shaped the design:

1. **`PASSWORD_RECOVERY` never fires on these platforms.** supabase-js emits it only when it parses the recovery URL itself via `detectSessionInUrl`, which is `Platform.OS === "web"` on mobile and hard-`false` on desktop. Deriving the flag from that event would have produced a flag that is never set.
2. **Universal Links / App Links do not verify.** `apps/web/public/.well-known/apple-app-site-association` still carries `REPLACE_WITH_TEAM_ID` and `assetlinks.json` carries `REPLACE_WITH_SHA256_FINGERPRINT`, so an `https://drafto.eu/...` recovery link would open the website, not the app.
3. **The two clients run different OAuth flows.** Mobile leaves `flowType` unset (supabase-js defaults to implicit → fragment tokens); desktop sets `flowType: "pkce"` (→ a `code`, with the verifier in that install's AsyncStorage).

## Decision

**Route recovery over each platform's already-registered custom scheme, and gate it on an explicit `isRecovering` flag owned by `AuthProvider` and checked ahead of every other routing branch.**

- Redirect targets: `drafto://reset-password` (mobile) and `eu.drafto.desktop://auth/recovery` (desktop). The mobile path is deliberately the Expo Router path of `app/(auth)/reset-password.tsx` — route groups are absent from the URL — so a cold start lands on the reset screen natively instead of Expo Router's "Unmatched route" fallback. Desktop uses a path distinct from `auth/callback` so the OAuth handler can tell them apart.
- A per-platform `src/lib/auth-recovery.ts` owns recognition (`isRecoveryUrl`), parsing (`parseRecoveryLink`), and session establishment (`completeRecoveryFromUrl`). It accepts both credential shapes, so a future `flowType` change does not break either platform.
- `AuthProvider` installs the `Linking` listener and exposes `isRecovering`, `recoveryError`, and `endRecovery`. `isRecovering` flips **synchronously** on recognition, before the network round-trip, so no frame of the main app is ever shown. `PASSWORD_RECOVERY` is still handled, purely as a backstop against a future client-config change.
- Desktop's `handleOAuthCallback` defers to `isRecoveryUrl()` and returns early. Both handlers listen on the same scheme; without this the OAuth handler would spend the single-use recovery code and drop the user into a plain signed-in session.
- On success the session is kept and the user lands in the app, matching web's `router.push("/")`. Backing out of a _live_ recovery session signs out, so an abandoned recovery never leaves a silently-authenticated user. Dismissing a _failed_ link does not: that link never replaced anything, so signing out would evict a user who was simply holding a stale email.

Parsing is hand-rolled string handling rather than `URL` / `URLSearchParams`: React Native ships partial implementations of both, and WHATWG parsing treats the first path segment of a custom scheme as the host.

**Operator prerequisite (not code):** both redirect URLs must be added to **Supabase Auth → URL Configuration → Redirect URLs** for the dev (`huhzactreblzcogqkbsd`) _and_ prod (`tbmjbxxseonkciqovnpl`) projects. Until they are, every recovery link is rejected by Supabase.

## Consequences

- **Positive**: feature parity with web on all four platforms. The `isRecovering` flag is a single, testable choke point — the guard tests (`route-guard.test.tsx`, `app-navigator.test.tsx`) assert that a recovery session reaches the reset screen instead of the main app or the approval screen, which is the regression class this design exists to prevent. Recovery and OAuth callbacks are disjoint by path, so neither consumes the other's code.
- **Negative**: a desktop reset link only completes on the Mac that requested it, because PKCE keeps the `code_verifier` local to that install. The request screen says so rather than leaving a user to discover it. Custom-scheme links are also less polished than Universal Links — some email clients render them as plain text — and they add a hard operator prerequisite that silently breaks the flow if skipped.
- **Neutral**: two more platform-mirrored files (`auth-recovery.ts` on mobile and desktop) to keep in sync, in the same style as `src/db/`. The flag lives on `AuthProvider` on both platforms but is consumed by two very different navigation models — Expo Router segments vs. a `useState` switch — so each platform's path must be verified independently.

## Alternatives Considered

- **Universal Links / App Links (`https://drafto.eu/reset-password`).** Nicer in email clients and no scheme registration. Rejected: the association files are unfilled placeholders, so the OS would not claim the link and the user would land on the website — exactly the bug being fixed. Worth revisiting once those files are real; `RECOVERY_PATHS` accepts an alternate path partly to smooth that migration.
- **Deriving `isRecovering` from the `PASSWORD_RECOVERY` auth event alone.** The obvious approach, and the one originally planned. Rejected once the client config was read: the event is only emitted under `detectSessionInUrl`, which is off on both platforms, so the flag would never have been set and the reset screen would never have rendered.
- **Enabling `detectSessionInUrl` on mobile/desktop.** Would restore the event, but it is a web-oriented switch that inspects `window.location`; there is no such thing in a React Native runtime.
- **Bouncing the user to the website to reset.** Zero app code, but it is the status quo the issue exists to remove.
- **Handling recovery inside the existing `oauth.ts` on desktop.** Fewer files, and it is what the approved plan sketched. Rejected on SRP grounds and for parity: recovery and OAuth sign-in are different concerns with different session semantics, and mirroring mobile's `auth-recovery.ts` keeps the two platforms legible side by side. `oauth.ts` still changed — it now recognises recovery URLs and declines them.
- **Reusing the web `/auth/callback` route as an intermediate hop.** Would centralise the exchange, but it requires a verified app link to hand control back to the app, so it reduces to the Universal Links option above.
