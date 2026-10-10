# 0044 — Desktop Auth Returns Through drafto.eu Hand-off Pages

- **Status**: Accepted
- **Date**: 2026-10-10
- **Authors**: Jakub Anderwald, Claude

## Context

The macOS app finishes two auth flows in the user's default browser, and both used to end on the app's custom scheme:

- **OAuth sign-in (Google, Apple).** [ADR-0018](./0018-oauth-google-apple.md) has the app open `signInWithOAuth()`'s URL with `Linking.openURL`, using `redirectTo: eu.drafto.desktop://auth/callback`.
- **Password reset.** [ADR-0034](./0034-password-recovery-deep-links-on-mobile-and-desktop.md) has the reset email point at Supabase's `/auth/v1/verify`, with `redirect_to: eu.drafto.desktop://auth/recovery`.

In both cases Supabase answers the last hop with a `302` straight to `eu.drafto.desktop://…`. The browser hands that URL to Drafto, so sign-in and reset work, but it never commits a new page:

- After the account click, Google's account chooser freezes in its greyed-out "in progress" state. Apple's page does the same.
- A reset email link leaves a blank tab that keeps loading.
- A reset link opened on a device without the app (a phone, say) does nothing at all. PKCE means the reset can only finish on the Mac that asked for it, but nothing tells the user that.

The Google chooser also says "continue to `tbmjbxxseonkciqovnpl.supabase.co`". That is a separate problem, Google brand verification. It is recorded in [builds and releases](../operations/builds-and-releases.md#google-oauth-branding) and is not decided here.

## Decision

**End both redirect chains on a real page at `https://drafto.eu/auth/desktop/<flow>`. The page forwards the result to `eu.drafto.desktop://auth/<flow>` and tells the user what happens next.**

- **Flows.** `<flow>` is `callback` (OAuth) or `recovery` (password reset), mirroring the paths the app already routes on.
  - `apps/web/src/app/(auth)/auth/desktop/[flow]/page.tsx` pre-renders exactly those two, and anything else is a 404. It sits in the `(auth)` route group, so it shares the sign-in pages' frame and footer.
  - The desktop app passes `${apiUrl}/auth/desktop/callback` and `${apiUrl}/auth/desktop/recovery` as `redirectTo`. `apiUrl` resolves to `https://drafto.eu`.
  - The URL the app receives is the same `eu.drafto.desktop://auth/<flow>?code=…` as before, so routing between `handleOAuthCallback` and `auth-recovery.ts` is unchanged.
- **Hand-off.** The client component `apps/web/src/components/auth/desktop-handoff.tsx` does the work in the browser:
  - It reads `location.search` **and** `location.hash`. Supabase can put a reset-link error in the fragment, which never reaches the server.
  - It builds the deep link with `buildDesktopDeepLink` (`apps/web/src/lib/auth/desktop-deep-link.ts`).
  - It clears the URL with `history.replaceState`, keeping the history entry's state for Next's router.
  - It navigates to the deep link once, and only when there is a `code` **and** the browser is a Mac desktop (`isMacDesktop`, which excludes an iPad in desktop mode). On any other device a reset link says plainly that it has to be opened on the Mac that asked for it.
  - It never renders Supabase's error text, because anyone can put text in that URL. Each flow shows fixed copy instead ("This reset link has expired or was already used."), and the "Open Drafto" button still forwards the error params to the app.
  - Success copy does not claim success, because the app has not exchanged the code yet ("Finishing sign-in in Drafto"). An empty hand-off offers no button.
- **The app accepts a code once.** The page opens the app automatically and also offers "Open Drafto" with the same link, so the app receives it twice in the normal case.
  - `handleOAuthCallback` remembers exchanged codes for the app run.
  - `createRecoveryLinkHandler` remembers every link it has handled.
  - Re-exchanging a spent code would fail with "PKCE code verifier not found" and replace a working reset form with an error.
- **The app ignores session tokens in the URL.** Desktop runs `flowType: "pkce"`, so only a `code` that this install's `code_verifier` can redeem is a credential. Any website can open `eu.drafto.desktop://…#access_token=…&refresh_token=…`, and the old implicit-flow `setSession` branches would have signed the app into the attacker's account. Both handlers' branches are gone (see the ADR-0034 amendment). The page forwarding only `code`, `error`, `error_code` and `error_description` is hygiene on top of that, not the boundary.
- **The page never exchanges the code.** It creates no Supabase client: the PKCE verifier lives in the app, and only the app can redeem the code.
- **The code can be recorded by web monitoring.** The page is part of drafto.eu, so Sentry performance tracing and Session Replay can record its address, including `?code=`. That is acceptable for three reasons:
  - The code is PKCE-bound: it is useless without the `code_verifier`, which only the app's AsyncStorage holds.
  - It is single-use and short-lived.
  - The privacy policy already discloses that request addresses are recorded. It now also names this page.

  `PostHogPageView` drops the query string for every `/auth/*` path (`apps/web/src/lib/posthog/pageview-url.ts`). That is defence in depth only, because PostHog is not enabled.

- **The route is public.** `/auth/desktop` is in the middleware's `PUBLIC_ROUTES`, because the browser that lands there is signed out.

**Operator prerequisite (not code).** The Supabase Auth Redirect URLs for the dev (`huhzactreblzcogqkbsd`) _and_ prod (`tbmjbxxseonkciqovnpl`) projects must cover both `https://drafto.eu/auth/desktop/*` URLs. If one is missing, Supabase silently falls back to the Site URL and the flow breaks. Both hosted projects already allow `https://drafto.eu/**`, which covers them. Both also keep the old `eu.drafto.desktop://auth/callback` and `eu.drafto.desktop://auth/recovery` entries, because already-installed builds still send them.

## Consequences

- **Positive**:
  - The browser tab always ends on a page that says what happens next: sign-in finishing in the app, reset in progress, or an error.
  - A reset link opened on the wrong device now explains the same-Mac limit instead of doing nothing.
  - The same approach covers Google, Apple and password reset.
  - There is no new native code in the fossil desktop build ([ADR-0027](./0027-desktop-react-version-locked-to-react-native-macos.md)).
- **Negative**:
  - Desktop auth now depends on drafto.eu being up, in addition to Supabase.
  - The tab stays open, because a page cannot close a tab the user opened.
  - Browsers ask "Open Drafto?" once for the drafto.eu origin. Previously they asked for the Supabase origin.
  - **Deploy order matters.** drafto.eu must serve the hand-off pages before any desktop build that uses them reaches a tester. A build pointing at a missing page would 404 every sign-in and reset. So this change gets no pre-merge factory desktop beta ([ADR-0030](./0030-in-test-scenarios-and-pre-merge-betas.md)). The desktop beta ships only after the merge has deployed the web app.
  - The hand-off URL, one-time code included, can appear in Sentry traces and replays (see the Decision for why that is acceptable).
- **Neutral**:
  - The web app now hosts pages that serve only the macOS app.
  - The redirect allowlist gains two HTTPS entries per Supabase project.

## Alternatives Considered

- **Keep redirecting straight to the custom scheme (status quo).** No web code. Rejected because it causes exactly the frozen and blank tabs this ADR fixes.
- **`ASWebAuthenticationSession` native module.** It shows an in-app auth sheet that closes itself on the callback, which is the iOS-style UX. Rejected for three reasons:
  - It means new Objective-C in the fossil desktop build, which is only verifiable on a TestFlight build.
  - It uses its own cookie jar, so users sign in to Google again instead of reusing their browser session.
  - It cannot catch a reset link clicked in an email client.
- **Universal Links for `https://drafto.eu/auth/desktop/*`.** The OS would hand the link to the app with no page in between. Rejected, as in ADR-0034: the association files are placeholders, and the hand-off page needs no OS-level association, because a page can open the custom scheme itself.
- **Supabase custom domain (`auth.drafto.eu`).** This would fix the chooser's app name, not the frozen tab, and it is a paid add-on on top of the Pro plan. Not adopted; brand verification is the free route.
