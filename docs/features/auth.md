# Authentication

**Status:** shipped **Updated:** 2026-04-21

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
| Mobile waiting-for-approval                     | `apps/mobile/app/(auth)/waiting-for-approval.tsx`            |
| Mobile auth provider                            | `apps/mobile/src/providers/auth-provider.tsx`                |
| Desktop login screen                            | `apps/desktop/src/screens/login.tsx`                         |
| Desktop signup screen                           | `apps/desktop/src/screens/signup.tsx`                        |
| Desktop waiting-for-approval                    | `apps/desktop/src/screens/waiting-for-approval.tsx`          |
| Desktop auth provider                           | `apps/desktop/src/providers/auth-provider.tsx`               |
| Initial schema + RLS + `profiles` table         | `supabase/migrations/20260224000001_initial_schema.sql`      |
| RLS recursion fix                               | `supabase/migrations/20260225000001_fix_rls_recursion.sql`   |
| Admin bootstrap (first approved user)           | `supabase/migrations/20260420000001_admin_bootstrap.sql`     |

## Related ADRs

- [0001 — Data Model and RLS Strategy](../adr/0001-data-model-and-rls-strategy.md)
- [0018 — OAuth (Google + Apple)](../adr/0018-oauth-google-apple.md)
- [0019 — Email Infrastructure and Approval Flow](../adr/0019-email-infrastructure-and-approval-flow.md)

## Cross-platform notes

- **Web** is the only platform with a session-refresh middleware; it also enforces the `is_approved` gate server-side before any page renders. This is the canonical gate — it cannot be bypassed by client-side tampering.
- **Mobile and desktop** run in an offline-first model and cannot rely on a middleware. They check `profiles.is_approved` via `AuthProvider` on sign-in, app resume, and pull-to-refresh. A cached approval flag (`approval-cache`) lets the app continue to work offline once a user has been approved at least once.
- **OAuth redirects** go through the web callback (`/auth/callback`) on all platforms; mobile and desktop open the provider flow in a system browser and hand the code back to the app via deep link.
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
- **Files that must change together:**
  - Adding a new public route: update `PUBLIC_ROUTES` in `apps/web/src/lib/supabase/middleware.ts` **and** add a test case in `middleware.test.ts`.
  - Changing the `profiles` shape: update `apps/web/src/lib/supabase/database.types.ts`, the RLS policies, and every `AuthProvider` (web middleware, mobile provider, desktop provider) that reads the column.
  - Adding a new OAuth provider: update both `apps/web/src/components/auth/oauth-buttons.tsx` and `apps/mobile/src/components/auth/oauth-buttons.tsx`, plus the Supabase dashboard config for each environment.

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
