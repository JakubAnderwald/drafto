# Authentication

**Status:** shipped **Updated:** 2026-09-11

## What it is

Email+password and OAuth (Google, Apple) sign-in backed by Supabase Auth, gated by an admin-approval step before a new user can reach the app. Row-Level Security (RLS) on every user-scoped table enforces that only approved users can read or write their own data.

## Current state

Available on all four platforms: web, iOS, Android, and macOS. The web app uses Next.js middleware for session refresh and the approval gate; the mobile and desktop apps use an `AuthProvider` context that checks `profiles.is_approved` on boot and refreshes on resume. Email confirmation is enabled in Supabase Auth; OAuth providers are configured for Google and Apple. The first admin (`jakub@anderwald.info`) is bootstrapped via migration; all other accounts start unapproved and land on a waiting-for-approval screen until an admin flips `profiles.is_approved`.

## Code paths

| Concern                                         | Path                                                         |
| ----------------------------------------------- | ------------------------------------------------------------ |
| Next.js middleware entrypoint                   | `apps/web/middleware.ts`                                     |
| Middleware session refresh + `is_approved` gate | `apps/web/src/lib/supabase/middleware.ts`                    |
| Web Supabase browser client                     | `apps/web/src/lib/supabase/client.ts`                        |
| Web Supabase server client                      | `apps/web/src/lib/supabase/server.ts`                        |
| Web Supabase admin (service-role) client        | `apps/web/src/lib/supabase/admin.ts`                         |
| Login page (email+password, OAuth)              | `apps/web/src/app/(auth)/login/page.tsx`                     |
| Signup page                                     | `apps/web/src/app/(auth)/signup/page.tsx`                    |
| Forgot password                                 | `apps/web/src/app/(auth)/forgot-password/page.tsx`           |
| Reset password                                  | `apps/web/src/app/(auth)/reset-password/page.tsx`            |
| Waiting-for-approval landing                    | `apps/web/src/app/(auth)/waiting-for-approval/page.tsx`      |
| OAuth callback (PKCE code exchange)             | `apps/web/src/app/auth/callback/route.ts`                    |
| OAuth button component (web)                    | `apps/web/src/components/auth/oauth-buttons.tsx`             |
| OAuth button component (mobile)                 | `apps/mobile/src/components/auth/oauth-buttons.tsx`          |
| Admin approval UI                               | `apps/web/src/app/(app)/admin/page.tsx`                      |
| Admin user list component                       | `apps/web/src/app/(app)/admin/admin-user-list.tsx`           |
| Admin flash message                             | `apps/web/src/app/(app)/admin/admin-flash-message.tsx`       |
| Admin approve-user API                          | `apps/web/src/app/api/admin/approve-user/route.ts`           |
| One-click approve (email link)                  | `apps/web/src/app/api/admin/approve-user/one-click/route.ts` |
| Signed approval token helper                    | `apps/web/src/lib/approval-tokens.ts`                        |
| Mobile login screen                             | `apps/mobile/app/(auth)/login.tsx`                           |
| Mobile signup screen                            | `apps/mobile/app/(auth)/signup.tsx`                          |
| Mobile forgot password                          | `apps/mobile/app/(auth)/forgot-password.tsx`                 |
| Mobile reset password                           | `apps/mobile/app/(auth)/reset-password.tsx`                  |
| Mobile recovery deep-link parsing               | `apps/mobile/src/lib/auth-recovery.ts`                       |
| Mobile route guard (recovery branch)            | `apps/mobile/app/_layout.tsx`                                |
| Mobile waiting-for-approval                     | `apps/mobile/app/(auth)/waiting-for-approval.tsx`            |
| Mobile auth provider                            | `apps/mobile/src/providers/auth-provider.tsx`                |
| Desktop login screen                            | `apps/desktop/src/screens/login.tsx`                         |
| Desktop signup screen                           | `apps/desktop/src/screens/signup.tsx`                        |
| Desktop forgot password                         | `apps/desktop/src/screens/forgot-password.tsx`               |
| Desktop reset password                          | `apps/desktop/src/screens/reset-password.tsx`                |
| Desktop recovery deep-link parsing              | `apps/desktop/src/lib/auth-recovery.ts`                      |
| Desktop route switch (recovery branch)          | `apps/desktop/src/navigation/app-navigator.tsx`              |
| Desktop waiting-for-approval                    | `apps/desktop/src/screens/waiting-for-approval.tsx`          |
| Desktop auth provider                           | `apps/desktop/src/providers/auth-provider.tsx`               |
| Initial schema + RLS + `profiles` table         | `supabase/migrations/20260224000001_initial_schema.sql`      |
| RLS recursion fix                               | `supabase/migrations/20260225000001_fix_rls_recursion.sql`   |
| Admin bootstrap (first approved user)           | `supabase/migrations/20260420000001_admin_bootstrap.sql`     |

## Related ADRs

- [0001 — Data Model and RLS Strategy](../adr/0001-data-model-and-rls-strategy.md)
- [0018 — OAuth (Google + Apple)](../adr/0018-oauth-google-apple.md)
- [0019 — Email Infrastructure and Approval Flow](../adr/0019-email-infrastructure-and-approval-flow.md)
- [0034 — Password Recovery via Custom-Scheme Deep Links](../adr/0034-password-recovery-deep-links-on-mobile-and-desktop.md)

## Cross-platform notes

- **Web** is the only platform with a session-refresh middleware; it also enforces the `is_approved` gate server-side before any page renders. This is the canonical gate — it cannot be bypassed by client-side tampering.
- **Mobile and desktop** run in an offline-first model and cannot rely on a middleware. They check `profiles.is_approved` via `AuthProvider` on sign-in, app resume, and pull-to-refresh. A cached approval flag (`approval-cache`) lets the app continue to work offline once a user has been approved at least once.
- **OAuth flows differ per platform and provider** — the web `/auth/callback` route is used by the **web app only**:
  - **Web (both providers)** — `signInWithOAuth()` PKCE redirect, returning to `/auth/callback`, which calls `exchangeCodeForSession()`.
  - **Google on iOS and Android** — the native Google Sign-In SDK; the returned ID token goes straight to `supabase.auth.signInWithIdToken()` (`apps/mobile/src/lib/oauth.ts`). No `expo-web-browser` session and no `/auth/callback` route — but the two platforms differ underneath: on **Android** the flow is fully native (the Play services account picker), while on **iOS** `GIDSignIn` still presents Google's own system web sheet and returns through the reversed-client-ID URL scheme (`EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME`, registered by the config plugin in `apps/mobile/app.config.ts` — it is load-bearing, not dead config). The Android leg additionally requires an Android-type OAuth client registered by package name + signing-cert SHA-1 — see [builds and releases](../operations/builds-and-releases.md#google-sign-in-android-oauth-client).
  - **Apple on iOS** — `expo-apple-authentication`'s system sheet, then `signInWithIdToken()`. Genuinely web-free: no browser and no web sheet at any point.
  - **Apple on Android** — `signInWithOAuth()` opened via `expo-web-browser`, handed back to the app through the `drafto://auth/callback` deep link and exchanged in-app.
  - **macOS (both providers)** — `signInWithOAuth()` opened in the system browser, handed back through the `eu.drafto.desktop://auth/callback` deep link (`apps/desktop/src/lib/oauth.ts`) and exchanged in-app.
- **Password recovery is deep-linked on mobile and desktop** ([ADR-0034](../adr/0034-password-recovery-deep-links-on-mobile-and-desktop.md)). Web redirects to `/auth/callback?next=/reset-password`; the apps cannot, so `resetPasswordForEmail` targets a custom scheme instead — `drafto://reset-password` (mobile) and `eu.drafto.desktop://auth/recovery` (desktop). Both URLs must be present in **Supabase Auth → URL Configuration → Redirect URLs** for the dev (`huhzactreblzcogqkbsd`) _and_ prod (`tbmjbxxseonkciqovnpl`) projects, or every recovery link is rejected. The flows also differ in shape: mobile runs the implicit flow (fragment tokens), desktop runs PKCE, so a desktop reset link only completes on the Mac that requested it.
- **A recovery session is a real session**, which is why both apps carry an `isRecovering` flag on `AuthProvider`. It is checked _before_ the approval gate and before the signed-in redirect, or the reset screen is unreachable. `PASSWORD_RECOVERY` is not emitted here — supabase-js only raises it when it parses the URL itself (`detectSessionInUrl`, web-only) — so the flag is set by the deep-link handler.
- **Shared invariant:** RLS in Postgres is the single source of truth. Every platform uses the same `profiles.is_approved` column and the same RLS policies — if a user bypasses a client check, the database still refuses the query.

## Modifying safely

- **Invariants:**
  - The middleware in `apps/web/src/lib/supabase/middleware.ts` is the only server-side gate between unauthenticated / unapproved users and the app shell. Every new user-scoped route must pass through it (i.e., not be added to `PUBLIC_ROUTES` unless it is truly public).
  - `profiles.is_approved` defaults to `false` and is NOT user-writable. Only the service-role client (via `apps/web/src/lib/supabase/admin.ts`) should flip it.
  - RLS policies reference both `auth.uid()` and `is_approved` — never add a policy that only checks `auth.uid()` on user data tables.
- **Tests that will catch regressions:**
  - `apps/web/__tests__/unit/middleware.test.ts` — covers public-route allowlist, unauthenticated redirect, unapproved redirect, approved pass-through, and the verified-user header injection.
  - `apps/web/__tests__/unit/auth-callback.test.ts` — PKCE code exchange and sanitized redirect.
  - `apps/web/__tests__/unit/admin-approve-user.test.ts` + `apps/web/__tests__/unit/approve-user-one-click.test.ts` — admin-only approval and signed-link flow.
  - `apps/web/__tests__/unit/approval-tokens.test.ts` — HMAC signing and TTL.
  - `apps/web/__tests__/integration/login.test.tsx`, `signup.test.tsx`, `waiting-for-approval.test.tsx` — UI flow.
  - `apps/web/e2e/auth.spec.ts` — Playwright end-to-end sign-in.
  - `apps/{mobile,desktop}/__tests__/lib/auth-recovery.test.ts` — recovery-URL parsing, OAuth/recovery disambiguation, expired-link handling.
  - `apps/mobile/__tests__/screens/route-guard.test.tsx` + `apps/desktop/__tests__/navigation/app-navigator.test.tsx` — a recovery session reaches the reset screen instead of the main app or the approval screen. This is the regression the `isRecovering` flag exists to prevent.
  - `apps/{mobile,desktop}/__tests__/screens/{forgot-password,reset-password}.test.tsx` — request, confirmation, validation, expired-link and offline-retry states.
  - `apps/mobile/e2e/06-forgot-password.yaml` — Maestro: the recovery deep link opens in-app rather than bouncing to the website.
- **Files that must change together:**
  - Adding a new public route: update `PUBLIC_ROUTES` in `apps/web/src/lib/supabase/middleware.ts` **and** add a test case in `middleware.test.ts`.
  - Changing the `profiles` shape: update `apps/web/src/lib/supabase/database.types.ts`, the RLS policies, and every `AuthProvider` (web middleware, mobile provider, desktop provider) that reads the column.
  - Adding a new OAuth provider: update both `apps/web/src/components/auth/oauth-buttons.tsx` and `apps/mobile/src/components/auth/oauth-buttons.tsx`, plus the Supabase dashboard config for each environment.
  - Changing a recovery redirect URL: update `RECOVERY_REDIRECT_URL` in the platform's `auth-recovery.ts`, its `RECOVERY_PATHS` set, **and** the Redirect URLs allowlist in both Supabase projects. The desktop `handleOAuthCallback` defers to `isRecoveryUrl()` to avoid consuming the recovery code — keep the two path sets consistent or the OAuth handler will burn it.

## Verify

Run after any auth-related change. Start local and widen to platforms touched by the change.

```bash
# Web unit + integration
cd apps/web && pnpm test

# Web E2E (requires E2E_TEST_EMAIL / E2E_TEST_PASSWORD in apps/web/.env.local)
set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e -- auth

# Mobile unit
cd apps/mobile && pnpm test

# Mobile E2E (Android emulator + dev client running)
maestro test apps/mobile/e2e/ --platform android

# Desktop unit
cd apps/desktop && pnpm test

# Lint + typecheck across the monorepo
pnpm lint && pnpm typecheck
```
