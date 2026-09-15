# Authentication

**Status:** shipped **Updated:** 2026-09-14

## What it is

Email+password and OAuth (Google, Apple) sign-in backed by Supabase Auth, gated by an admin-approval step before a new user can reach the app. Row-Level Security (RLS) on every user-scoped table enforces that only approved users can read or write their own data.

## Current state

Available on all four platforms: web, iOS, Android, and macOS. The web app uses Next.js middleware for session refresh and the approval gate; the mobile and desktop apps use an `AuthProvider` context that checks `profiles.is_approved` on boot and refreshes on resume. Email confirmation is enabled in Supabase Auth; OAuth providers are configured for Google and Apple. The first admin (`jakub@anderwald.info`) is bootstrapped via migration; all other accounts start unapproved and land on a waiting-for-approval screen until an admin flips `profiles.is_approved`.

A signed-in user can permanently delete their own account from inside the app on every platform: web `/settings`, the mobile Settings tab, and the desktop sidebar's app menu (⋯). Each one asks the user to type `DELETE`, then calls `DELETE /api/account` on the web app, which removes the user's attachment files, auth user and every row. Mobile and desktop then wipe their local database. The public page [drafto.eu/account/delete](https://drafto.eu/account/delete) explains the same steps to signed-out visitors, with `support@drafto.eu` as the email fallback. Sign in with Apple token revocation is **not** implemented yet; see [Account deletion](#account-deletion).

## Code paths

| Concern                                                                                         | Path                                                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Next.js middleware entrypoint                                                                   | `apps/web/middleware.ts`                                            |
| Middleware session refresh + `is_approved` gate                                                 | `apps/web/src/lib/supabase/middleware.ts`                           |
| Web Supabase browser client                                                                     | `apps/web/src/lib/supabase/client.ts`                               |
| Web Supabase server client                                                                      | `apps/web/src/lib/supabase/server.ts`                               |
| Web Supabase admin (service-role) client                                                        | `apps/web/src/lib/supabase/admin.ts`                                |
| Login page (email+password, OAuth)                                                              | `apps/web/src/app/(auth)/login/page.tsx`                            |
| Signup page                                                                                     | `apps/web/src/app/(auth)/signup/page.tsx`                           |
| Forgot password                                                                                 | `apps/web/src/app/(auth)/forgot-password/page.tsx`                  |
| Reset password                                                                                  | `apps/web/src/app/(auth)/reset-password/page.tsx`                   |
| Waiting-for-approval landing                                                                    | `apps/web/src/app/(auth)/waiting-for-approval/page.tsx`             |
| OAuth callback (PKCE code exchange)                                                             | `apps/web/src/app/auth/callback/route.ts`                           |
| OAuth button component (web)                                                                    | `apps/web/src/components/auth/oauth-buttons.tsx`                    |
| OAuth button component (mobile)                                                                 | `apps/mobile/src/components/auth/oauth-buttons.tsx`                 |
| Admin approval UI                                                                               | `apps/web/src/app/(app)/admin/page.tsx`                             |
| Admin user list component                                                                       | `apps/web/src/app/(app)/admin/admin-user-list.tsx`                  |
| Admin flash message                                                                             | `apps/web/src/app/(app)/admin/admin-flash-message.tsx`              |
| Admin panel close button (click / Escape)                                                       | `apps/web/src/app/(app)/admin/admin-close-button.tsx`               |
| Admin panel Escape guard                                                                        | `apps/web/src/app/(app)/admin/should-close-on-escape.ts`            |
| Admin approve-user API                                                                          | `apps/web/src/app/api/admin/approve-user/route.ts`                  |
| Admin delete-pending-user API                                                                   | `apps/web/src/app/api/admin/delete-user/route.ts`                   |
| Self-service account deletion API (`DELETE /api/account`, last-admin guard)                     | `apps/web/src/app/api/account/route.ts`                             |
| Account route auth (session cookie or bearer token)                                             | `apps/web/src/lib/account/authenticate-account-request.ts`          |
| Shared account-deletion helper (`deleteUserAccount`)                                            | `apps/web/src/lib/account/delete-user.ts`                           |
| User attachment sweeps: strict `removeAllUserAttachments` + best-effort `removeUserAttachments` | `apps/web/src/lib/storage/remove-user-attachments.ts`               |
| Web settings "Delete account" section                                                           | `apps/web/src/components/settings/delete-account-section.tsx`       |
| Settings page (renders the section last)                                                        | `apps/web/src/app/settings/page.tsx`                                |
| Confirm dialog (`confirmDisabled` for type-to-confirm)                                          | `apps/web/src/components/ui/confirm-dialog.tsx`                     |
| "Your account has been deleted." notice on `/login?deleted=1`                                   | `apps/web/src/components/auth/account-deleted-notice.tsx`           |
| Public deletion explainer (`/account/delete`)                                                   | `apps/web/src/app/account/delete/page.tsx`                          |
| Client request + failure copy (`requestAccountDeletion`, `describeAccountDeletionFailure`)      | `packages/shared/src/account/request-account-deletion.ts`           |
| Confirmation word (`ACCOUNT_DELETE_CONFIRMATION`)                                               | `packages/shared/src/constants.ts`                                  |
| One-click approve (email link)                                                                  | `apps/web/src/app/api/admin/approve-user/one-click/route.ts`        |
| Signed approval token helper                                                                    | `apps/web/src/lib/approval-tokens.ts`                               |
| Mobile login screen                                                                             | `apps/mobile/app/(auth)/login.tsx`                                  |
| Mobile signup screen                                                                            | `apps/mobile/app/(auth)/signup.tsx`                                 |
| Mobile forgot password                                                                          | `apps/mobile/app/(auth)/forgot-password.tsx`                        |
| Mobile reset password                                                                           | `apps/mobile/app/(auth)/reset-password.tsx`                         |
| Mobile recovery deep-link parsing                                                               | `apps/mobile/src/lib/auth-recovery.ts`                              |
| Mobile route guard (recovery branch)                                                            | `apps/mobile/app/_layout.tsx`                                       |
| Mobile waiting-for-approval                                                                     | `apps/mobile/app/(auth)/waiting-for-approval.tsx`                   |
| Mobile auth provider (`signOut`, `deleteAccount`, shared `resetLocalSession`)                   | `apps/mobile/src/providers/auth-provider.tsx`                       |
| Mobile "Delete account" row (disabled offline)                                                  | `apps/mobile/app/(tabs)/settings.tsx`                               |
| Mobile type-`DELETE` dialog                                                                     | `apps/mobile/src/components/delete-account-dialog.tsx`              |
| Mobile web API origin (`extra.apiUrl`)                                                          | `apps/mobile/app.config.ts`                                         |
| Desktop login screen                                                                            | `apps/desktop/src/screens/login.tsx`                                |
| Desktop signup screen                                                                           | `apps/desktop/src/screens/signup.tsx`                               |
| Desktop forgot password                                                                         | `apps/desktop/src/screens/forgot-password.tsx`                      |
| Desktop reset password                                                                          | `apps/desktop/src/screens/reset-password.tsx`                       |
| Desktop recovery deep-link parsing                                                              | `apps/desktop/src/lib/auth-recovery.ts`                             |
| Desktop route switch (recovery branch)                                                          | `apps/desktop/src/navigation/app-navigator.tsx`                     |
| Desktop waiting-for-approval                                                                    | `apps/desktop/src/screens/waiting-for-approval.tsx`                 |
| Desktop auth provider (`signOut`, `deleteAccount`, shared `resetLocalSession`)                  | `apps/desktop/src/providers/auth-provider.tsx`                      |
| Desktop sidebar user section (email + app menu trigger; hosts the delete panel)                 | `apps/desktop/src/components/sidebar/notebooks-sidebar.tsx`         |
| Desktop app menu (⋯): "Sign out" / "Delete account…" (disabled offline)                         | `apps/desktop/src/components/sidebar/app-menu.tsx`                  |
| Desktop inline type-`DELETE` panel                                                              | `apps/desktop/src/components/sidebar/delete-account-panel.tsx`      |
| Desktop web API origin (`apiUrl` from `API_URL`)                                                | `apps/desktop/src/lib/config.ts`, `apps/desktop/src/types/env.d.ts` |
| Support agent: always escalate emailed deletion / data-rights requests                          | `scripts/support-agent-prompt.md` (step 5.5)                        |
| Initial schema + RLS + `profiles` table                                                         | `supabase/migrations/20260224000001_initial_schema.sql`             |
| RLS recursion fix                                                                               | `supabase/migrations/20260225000001_fix_rls_recursion.sql`          |
| Admin bootstrap (first approved user)                                                           | `supabase/migrations/20260420000001_admin_bootstrap.sql`            |

## Related ADRs

- [0001 — Data Model and RLS Strategy](../adr/0001-data-model-and-rls-strategy.md)
- [0018 — OAuth (Google + Apple)](../adr/0018-oauth-google-apple.md)
- [0019 — Email Infrastructure and Approval Flow](../adr/0019-email-infrastructure-and-approval-flow.md)
- [0034 — Password Recovery via Custom-Scheme Deep Links](../adr/0034-password-recovery-deep-links-on-mobile-and-desktop.md)
- [0038 — Account Deletion Endpoint for All Platforms](../adr/0038-account-deletion-endpoint.md)

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
- **Account deletion is the one auth flow where mobile and desktop call the web app.** Everything else they do goes straight to Supabase. Deleting an auth user needs the service role, which must never ship in a client, so the native apps send their Supabase access token to `DELETE /api/account` on the web origin (`EXPO_PUBLIC_API_URL` / `API_URL`, falling back to `https://drafto.eu`). See [Account deletion](#account-deletion) and [ADR-0038](../adr/0038-account-deletion-endpoint.md).
- **Shared invariant:** RLS in Postgres is the single source of truth. Every platform uses the same `profiles.is_approved` column and the same RLS policies — if a user bypasses a client check, the database still refuses the query.

## Account deletion

A signed-in user deletes their own account immediately and permanently. There is no soft delete, grace period or undo, and no export step inside the flow. The design is recorded in [ADR-0038](../adr/0038-account-deletion-endpoint.md).

### Flow per platform

Every platform uses the same copy: the "Delete account" label, the warning "This permanently deletes your Drafto account and all of your notebooks, notes and attachments. This cannot be undone.", the "Type DELETE to confirm" prompt, and `describeAccountDeletionFailure(result)` for errors. The confirm button is enabled only when `input.trim() === ACCOUNT_DELETE_CONFIRMATION` (case-sensitive) and no request is pending.

- **Web.** `DeleteAccountSection` is the last card on `/settings`. Its danger button opens an inline `ConfirmDialog` ("Delete your account?") that contains the warning and the confirmation `Input`, gated through `confirmDisabled`. Confirming calls `requestAccountDeletion({ baseUrl: "" })`, a same-origin request authenticated by the session cookie.
  - On `ok` it calls `createClient().auth.signOut({ scope: "local" })`. A sign-out error goes to Sentry (`delete-account-section:signOut`) and does not stop the flow. It then calls `router.replace("/login?deleted=1")`, where `AccountDeletedNotice` shows "Your account has been deleted."
  - Any other result shows the failure copy inside the dialog. Nothing is signed out, and the user can retry.
- **iOS and Android.** The Settings tab has a "Delete account" row (`delete-account-row`) below Sign Out. It opens `DeleteAccountDialog`, an RN `Modal` with `delete-account-input`, `delete-account-confirm` and `delete-account-cancel`, and passes `useAuth().deleteAccount` as `onConfirm`.
  - While `useNetworkStatus()` reports offline (`isConnected` is false, or `isInternetReachable` is explicitly false), the row is disabled and "Deleting your account needs an internet connection." is shown. Unknown reachability (`null`) keeps it enabled.
  - Failures are shown inline and the dialog stays open. On `ok` the provider clears the session, and the route guard in `apps/mobile/app/_layout.tsx` sends the user to login.
- **macOS.** Account actions sit behind the app menu, so they cannot be clicked by accident. The user section at the bottom of the sidebar (`notebooks-sidebar.tsx`) shows the email and a ⋯ button (`app-menu-trigger`, label "App menu"). It opens `AppMenu` (`app-menu.tsx`) upward, mirroring the web app menu but listing only what macOS has: "Sign out" (`logout-button`), a separator, and "Delete account…" (`delete-account-menu-item`). Theme stays in the native View ▸ Appearance menu. Choosing "Delete account…" closes the menu and opens `DeleteAccountPanel` inline in the user section, and its confirm button is the final click. The panel uses the same test IDs as mobile.
  - Choosing "Delete account…" only ever opens the panel, never toggles it. Closing goes through the panel's Cancel or Escape, which stay disabled while a request is pending, so the panel cannot unmount mid-request.
  - `AppMenu` hosts the whole sidebar through a render prop (`trigger`, `onAnchorLayout`) and renders its transparent backdrop and menu as the last children of that host, positioned from the user section's measured height. On react-native-macos a view laid out outside its parent's bounds is not reliably hit-testable, so nothing clickable may overflow its parent. The menu closes on the trigger, on choosing an item, on Escape (it takes keyboard focus when it opens), or on a click anywhere else in the sidebar. Its backdrop only covers the sidebar, so a click in the note list or editor leaves the menu open. Closing on those clicks would need a window-wide backdrop in `apps/desktop/src/screens/main.tsx`.
  - The panel and menu are inline rather than a `Modal`, because `Modal` is unproven on the react-native-macos fossil build.
  - Offline (same `isConnected` / `isInternetReachable === false` rule as mobile), "Delete account…" is disabled and the offline note is shown under it inside the menu, and the panel's confirm is disabled too. On `ok`, `app-navigator.tsx` renders the login screen once the session is null.
- **Public page.** `/account/delete` works signed out. It lists the in-app steps for each platform, what is deleted (account, notebooks, notes including trash and edit history, attachments, API keys), and what may be kept (aggregate web-app analytics only). It also gives the `support@drafto.eu` fallback for people who no longer have the app. `/support` and `/privacy` link to it from their footers.

### The endpoint and its authentication

`DELETE /api/account` (`apps/web/src/app/api/account/route.ts`) reads no body, no query string and no params. The user id comes only from a verified credential, through `authenticateAccountRequest(request)`:

- **An `Authorization` header is present** (mobile and desktop). It must be exactly `Bearer <Supabase access token>`, verified with `createAdminClient().auth.getUser(token)`. A header that is missing a token, uses another scheme, or carries an invalid token gets 401, with **no cookie fallback**. A Drafto MCP API key is not a Supabase access token, so it gets 401 as well.
- **No `Authorization` header** (web). The session cookie is verified with the server client from `@/lib/supabase/server` and `auth.getUser()`.

Both `/api/account` and `/account/delete` are in `PUBLIC_ROUTES` in `apps/web/src/lib/supabase/middleware.ts`. Native clients send no cookie, so without that entry middleware would answer 307 to `/login`, and `fetch` would follow it to a 200 HTML page. Being public makes the route responsible for its own authentication. On public routes, middleware passes client headers through untouched, so:

- The route **never** reads `x-verified-user-id` / `x-verified-user-email` and never uses `getAuthenticatedUserFast`, because a forged header would let anyone delete any account. `account-delete-api.test.ts` asserts that a forged header with no session gets 401.
- It does not use `getAuthenticatedUser` either. That helper requires approval, and an unapproved user may delete their own account.
- `isPublicRoute` matches by prefix, so any future route under `/api/account/*` or `/account/delete/*` is also public and must authenticate itself the same way.
- The only method is `DELETE`. It is not a CORS-simple method and Supabase SSR cookies are `SameSite=Lax`, so the cookie path is not CSRF-exposed. Never add a `GET` or form-post variant.

Success is 200 with `{ "success": true }`. Errors use `errorResponse`, so the body is `{ "error": <message>, "status": <code> }`:

| Status | `error` message                                                                       | When                                                                |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 401    | "Unauthorized"                                                                        | No valid bearer token or session                                    |
| 409    | "You are the only admin. Make another user an admin before deleting your account."    | Caller is an admin and the admin count is ≤ 1; nothing was deleted  |
| 500    | "Failed to delete your account. Please try again."                                    | Profile or admin-count lookup failed, or `deleteUser` failed        |
| 500    | "Failed to delete your attachments. Your account was not deleted — please try again." | Strict storage sweep failed; the account and its rows are untouched |

On the client, `requestAccountDeletion` maps 401 to `unauthorized` and 409 to `last-admin`. A thrown `fetch` becomes `network`. Only a 200 with a JSON body where `success === true` becomes `ok`. Everything else is `failed`, including a redirect that landed on an HTML page. If Supabase Auth is unreachable while a bearer token is being checked, the route fails closed with 401, and native clients show the "session expired" copy.

### Deletion order and retry

1. **Authenticate**, or return 401.
2. **Last-admin guard** (`rejectLastAdmin` in the route, service-role client). The route reads the caller's `profiles.is_admin`; a missing profile counts as not an admin. For an admin it counts `is_admin = true` rows, and a count ≤ 1 returns 409 with nothing touched. A lookup error or a null count goes to Sentry (`account-delete:profileLookup` / `account-delete:adminCount`) and returns 500.
3. **`deleteUserAccount(admin, userId)`** (`apps/web/src/lib/account/delete-user.ts`):
   1. **Strict storage sweep.** `removeAllUserAttachments` walks the user's `{userId}/` prefix in the `attachments` bucket (`BUCKET_NAME`) recursively. It pages `list()` 1,000 entries at a time, because the default page is only 100, and removes files in batches of up to 1,000. It throws on the first list or remove error. The helper reports that to Sentry (`delete-user-account:storage`) and returns `stage: "storage"`, which the route maps to 500. The auth user is untouched, and removal is idempotent, so a retry re-lists and finishes the job.
   2. **`admin.auth.admin.deleteUser(userId)`.** The `on delete cascade` foreign keys remove `profiles`, `notebooks`, `notes` (and `note_content_history` through `notes`), `attachments` rows and `api_keys`. An error goes to Sentry (`delete-user-account:deleteUser`) and returns `stage: "auth"`, which becomes 500.
   3. **Best-effort sweep.** `removeUserAttachments` catches an upload that landed between steps 1 and 2. Its errors go to Sentry (`remove-user-attachments:list` / `:remove`) and never fail the request.
4. Return `{ success: true }`.

**Why storage goes first.** The cascade never touches Storage, and Supabase does not allow deleting `storage.objects` with SQL, so files must be removed through the Storage API. If the auth user were deleted first and the sweep then failed, the files would be orphaned. The user could no longer sign in to retry, and no row would link the files back to them. Sweeping first keeps a failed deletion whole and retryable.

**Half state when step 3.2 fails.** Storage is already empty, but the account and its rows remain, so existing attachments show as broken until the user retries. A retry re-runs the sweep, which is cheap on an empty prefix, and then `deleteUser`. This trade-off is accepted, and the error copy asks the user to retry.

**Accepted race.** If two admins delete themselves at the same moment, both can pass the admin count and leave no admin. There is one admin today, and an admin can be restored by setting `profiles.is_admin` in the dashboard.

`/api/admin/delete-user` (pending signups only) runs the same helper after its own guards. There, a storage failure returns 500 "Failed to delete the user's attachments. The user was not deleted — please try again." and a `deleteUser` failure returns 500 "Failed to delete user".

### Local reset on mobile and desktop

`deleteAccount()` in each app's `auth-provider.tsx`:

1. Reads the session with `supabase.auth.getSession()` rather than React state, so the request carries a current access token. With no token it returns `{ status: "unauthorized" }` without sending anything.
2. Calls `requestAccountDeletion({ baseUrl: <web API origin>, accessToken })`.
3. **Any result other than `ok`** is returned as is. The session, the local WatermelonDB database and cached attachments are untouched, so the user stays signed in with their offline data.
4. **On `ok`**, there is **no pre-sign-out flush**. The account and every server row are already gone, so a sync would only fail and stall for up to `FINAL_SYNC_TIMEOUT_MS` (10 s). Unsynced local edits are discarded on purpose. The provider then calls `supabase.auth.signOut({ scope: "local" })` and runs the same reset as sign-out (#591): it clears session, approval and recovery state, then runs `clearCachedApproval`, `resetSyncState()`, `database.unsafeResetDatabase()` and `deleteAllLocalAttachments()`, each best-effort.

Both apps implement the reset as an internal `resetLocalSession(userId)` in their own `auth-provider.tsx`, shared with `signOut`. The Supabase sign-out call stays in each caller, because scope, flush and error handling differ. In `deleteAccount` the local-scope sign-out is wrapped in `try`/`catch`, so the wipe always runs once the server has confirmed the deletion. `signOut` is unchanged: it still flushes (bounded by the timeout) and still awaits the default-scope `signOut()`.

`scope: "local"` still calls Supabase's `/logout?scope=local`, which revokes the current session on the server. It does **not** keep a shared E2E user signed in. `apps/web/e2e/account-deletion.spec.ts` therefore mocks both `DELETE /api/account` and `**/auth/v1/logout**`, and any future native E2E that confirms a mocked deletion must do the same. Maestro flow `07-delete-account.yaml` only ever cancels.

### Web API origin for native apps

The canonical host is the apex `https://drafto.eu`, which serves `/api/*` directly (the MCP URL in `server.json` uses it too). Do not point the apps at `www`. A cross-host redirect makes `fetch` drop the `Authorization` header, and the request fails closed with 401.

- **Mobile:** `EXPO_PUBLIC_API_URL` → `extra.apiUrl` in `apps/mobile/app.config.ts`, read by `getApiUrl()` in the auth provider.
- **Desktop:** `API_URL` from `@env` → `apiUrl` in `apps/desktop/src/lib/config.ts`.

Both fall back to `https://drafto.eu` when the variable is unset. Supabase access tokens are project-specific, so an origin backed by the wrong Supabase project rejects the token with 401. For example, a dev build without the variable calls prod. Where to set the variables: [environments](../architecture/environments.md#web-api-origin-for-native-apps).

### Not an MCP tool

Account deletion is deliberately **not** exposed through `/api/mcp`. A destructive, irreversible action on the whole account must not be reachable with an API key. `/api/account` only accepts a Supabase session or access token, never a Drafto API key.

### Sign in with Apple token revocation — open gap

Apple requires apps that offer Sign in with Apple to revoke the user's Apple tokens (`POST https://appleid.apple.com/auth/revoke`) when the account is deleted. **Drafto does not do this yet.** The operator must decide how to handle it before App Store submission.

Why it was not implemented:

- **There is no Apple token to revoke.** On iOS, `signInWithAppleNative()` in `apps/mobile/src/lib/oauth.ts` passes only `credential.identityToken` to `supabase.auth.signInWithIdToken()`. The `authorizationCode` Apple returns is discarded. Supabase Auth does not keep an Apple refresh token for these identities. The OAuth redirect flows (web, Apple on Android, macOS) can at most see a provider token on the client session right after the code exchange, but nothing in the repo reads or stores `provider_refresh_token`, and persisting it would need a schema change.
- **There is no signing key.** `/auth/revoke` needs a `client_secret` JWT signed with the Sign in with Apple `.p8` key. `apps/web/src/env.ts` declares no `APPLE_*` secret.

**Feasible follow-up.**

1. Add the Apple key material (Team ID, Key ID, `.p8`, client ID) as new server secrets.
2. At deletion time on iOS, re-run `AppleAuthentication.signInAsync` for Apple-linked users to get a fresh `authorizationCode`, and send it with the deletion request.
3. The server exchanges the code for a refresh token and calls `/auth/revoke`, best-effort: failures go to Sentry and never block deletion.

Apple-linked users on the OAuth flows would need an equivalent re-authentication step.

**Cheapest decisive check** before choosing: on the **dev** project, inspect `auth.identities.identity_data` for an Apple-linked user, for example `select provider, identity_data from auth.identities where provider = 'apple' limit 1;`. This confirms that no Apple refresh token is stored.

### Emailed deletion requests (manual procedure)

People who no longer have the app, or cannot sign in, email `support@drafto.eu`. That is the only address published for this, on `/account/delete`, `/support`, `/privacy` and in `apps/mobile/store/metadata/privacy-policy.md`. Step 5.5 of `scripts/support-agent-prompt.md` always escalates these messages to `Drafto/Support/NeedsHuman` with the admin notification. It sends no reply and files no issue ([support agent → Account-deletion and data-rights requests](./support-agent.md#account-deletion-and-data-rights-requests)). The same rule escalates access, export, rectification, restriction and objection requests. Those are handled as that section describes, and never with the steps below. For a confirmed erasure or account-closure request, a person handles it **within 30 days**:

1. **Confirm the request.** `From` headers can be spoofed, so reply from Zoho to the email address registered on the Drafto account, and act only once that address confirms.
2. **Find the user in the right project.** Emailed requests almost always concern production (`tbmjbxxseonkciqovnpl`), not dev. This is a production data operation, so follow [production data safety](../operations/migrations.md). In the Supabase dashboard, open Authentication → Users, find the email and copy the user id.
3. **Never delete an admin from an emailed request.** If `profiles.is_admin` is true for that id, stop and handle it in person.
4. **Delete Storage first.** In Storage → `attachments`, delete the `{userId}/` folder with everything under it. The cascade does not touch files, and once the auth user is gone nothing links the files back to the account.
5. **Delete the auth user** in Authentication → Users. The foreign-key cascades remove the profile, notebooks, notes, attachment rows and API keys.
6. **Check** that no `{userId}/` folder has reappeared in `attachments`, in case an upload raced step 5, and remove anything found.
7. **Reply** to the requester, confirming the deletion.

Why not the admin page: `/api/admin/delete-user` only deletes **pending** users. It refuses approved users, admins and anyone who owns notebooks, notes or API keys (409). Deleting in the dashboard skips the last-admin guard and the strict sweep; steps 3, 4 and 6 stand in for them.

## Modifying safely

- **Invariants:**
  - The middleware in `apps/web/src/lib/supabase/middleware.ts` is the only server-side gate between unauthenticated / unapproved users and the app shell. Every new user-scoped route must pass through it (i.e., not be added to `PUBLIC_ROUTES` unless it is truly public).
  - `profiles.is_approved` defaults to `false` and is NOT user-writable. Only the service-role client (via `apps/web/src/lib/supabase/admin.ts`) should flip it.
  - RLS policies reference both `auth.uid()` and `is_approved` — never add a policy that only checks `auth.uid()` on user data tables.
  - `/api/admin/delete-user` permanently deletes **pending** users only. `auth.admin.deleteUser` cannot be undone, so every guard runs before it: caller is an admin, target is not the caller, target exists, and target is neither approved nor an admin (409). It also refuses (409) any account that already owns notebooks, notes or API keys, checked with the service-role client. A signup that was never approved cannot own any of those rows, because each table's insert policy requires approval. The actual deletion goes through the shared `deleteUserAccount` helper, the same one `/api/account` uses. It sweeps storage strictly first (a failure returns 500 and keeps the user), then deletes the auth user, which takes the profile and every user-owned row with it through `on delete cascade`, then runs a best-effort sweep.
  - `/api/account` is in `PUBLIC_ROUTES` and authenticates itself through `authenticateAccountRequest` only. Never switch it to `getAuthenticatedUserFast` or read `x-verified-*` headers (forgeable on public routes), and never accept a user id from the body, query or params. Any route added under `/api/account/*` or `/account/delete/*` is public by prefix match and needs the same care.
  - Account deletion order is strict storage sweep → `auth.admin.deleteUser` → best-effort sweep. Keep storage first. Never delete the auth user after a failed strict sweep.
  - The last-admin guard (409) runs before anything is deleted. The concurrent-admins race is accepted.
  - Native `deleteAccount()` touches local data **only** on `ok`, skips the pre-sign-out flush, and uses `signOut({ scope: "local" })`. `signOut()` keeps its flush and default scope. Both share one reset helper per app; do not fork it back into two copies.
  - `requestAccountDeletion` treats anything except a 200 JSON `{ success: true }` as failure. Do not loosen this, or a middleware redirect to an HTML page would read as a successful deletion and wipe the device.
  - Account deletion is not an MCP tool and must never accept an API key.
- **Tests that will catch regressions:**
  - `apps/web/__tests__/unit/middleware.test.ts` — covers public-route allowlist, unauthenticated redirect, unapproved redirect, approved pass-through, and the verified-user header injection.
  - `apps/web/__tests__/unit/auth-callback.test.ts` — PKCE code exchange and sanitized redirect.
  - `apps/web/__tests__/unit/admin-approve-user.test.ts` + `apps/web/__tests__/unit/approve-user-one-click.test.ts` — admin-only approval and signed-link flow.
  - `apps/web/__tests__/unit/admin-delete-user.test.ts` + `apps/web/__tests__/unit/remove-user-attachments.test.ts` — admin-only deletion of pending users (every rejection path asserts nothing was deleted) and the best-effort storage cleanup.
  - `apps/web/__tests__/unit/account-delete-api.test.ts` — every status path of `DELETE /api/account`: 401 with no session, a bad or empty bearer token, or a forged `x-verified-user-id`; 409 for the last admin; 500 on lookup, storage and `deleteUser` failures (a storage failure never calls `deleteUser`); 200 through both cookie and bearer auth; a user id in the body, query or headers is ignored.
  - `apps/web/__tests__/unit/authenticate-account-request.test.ts` — bearer vs cookie resolution, and no cookie fallback once an `Authorization` header is present.
  - `apps/web/__tests__/unit/delete-user-account.test.ts` — helper call order (strict sweep → `deleteUser` → best-effort sweep), stage results and Sentry tags. `remove-user-attachments.test.ts` also covers the strict sweep throwing, and paging and batching past one page.
  - `apps/web/__tests__/unit/middleware.test.ts` also covers `/api/account` and `/account/delete` being public, and a cookie-less bearer `DELETE /api/account` reaching the route instead of redirecting.
  - `packages/shared/__tests__/request-account-deletion.test.ts` — every `AccountDeletionResult` branch, including a redirected HTML 200 mapping to `failed`.
  - `apps/web/__tests__/integration/delete-account-section.test.tsx`, `ui/confirm-dialog.test.tsx` (`confirmDisabled`), `login.test.tsx` (the deleted notice), `settings.test.tsx` (section rendered last), `account-delete-page.test.tsx` and `legal-pages.test.tsx` (in-app flow first, `support@drafto.eu` only).
  - `apps/web/__tests__/integration/account-deletion.live.test.ts` — creates a real user on **dev** with a notebook, note, attachment row and object, and API key, runs `deleteUserAccount`, and asserts everything is gone. It **skips** unless `SUPABASE_SERVICE_ROLE_KEY` is exported and `NEXT_PUBLIC_SUPABASE_URL`'s host is exactly `huhzactreblzcogqkbsd.supabase.co`. Vitest does not load `.env.local`, so a plain `pnpm test` and CI skip it.
  - `apps/web/e2e/account-deletion.spec.ts` — Playwright: `/account/delete` loads signed out; in settings, typed-`DELETE` gating and cancel work; a mocked success (with the Supabase logout call mocked too) lands on `/login?deleted=1` with the notice. The shared E2E user is never really deleted.
  - `apps/mobile/__tests__/components/delete-account-dialog.test.tsx`, `apps/mobile/__tests__/screens/settings.test.tsx` and `apps/mobile/__tests__/providers/auth-provider.test.tsx` — confirm gating, the offline-disabled row, and `deleteAccount()` resetting only on `ok` with no flush and a local-scope sign-out, while `signOut()` keeps the default scope.
  - `apps/desktop/__tests__/components/delete-account-panel.test.tsx`, `apps/desktop/__tests__/components/notebooks-sidebar.test.tsx` and `apps/desktop/__tests__/providers/auth-provider.test.tsx` — the same guarantees for the inline panel and the sidebar entry point (account actions hidden until the app menu is opened, open-only panel, offline gating).
  - `apps/desktop/__tests__/components/app-menu.test.tsx` — the macOS app menu: closed by default, trigger toggles it, each item calls its action and closes, the backdrop and Escape close it, it takes keyboard focus once mounted, and "Delete account…" is disabled with the offline note while offline. `notebooks-sidebar.test.tsx` checks the menu opens just above the measured user section and that nothing renders below that section.
  - `apps/desktop/e2e/run-e2e.sh` — TEST 2 checks the "App menu" button is on screen and the account actions are hidden. TEST 2b opens the menu in the real app, chooses "Delete account…" and closes the panel with Escape (never confirming), then checks that Escape and a second click on the button close the menu.
  - `apps/mobile/e2e/07-delete-account.yaml` (also inlined as flow 07 in `ios-all.yaml` / `android-all.yaml`) — Maestro: opens the dialog, confirm stays disabled for wrong text, cancel, user still signed in. It must never tap an enabled confirm.
  - `apps/web/__tests__/integration/admin-user-list.test.tsx` — approve and delete flows on the admin page, including the confirm dialog and the pending count.
  - `apps/web/__tests__/unit/should-close-on-escape.test.ts` + `apps/web/__tests__/integration/admin-close-button.test.tsx` — closing the admin panel by click or Escape, and the cases where Escape is ignored (typing in an input, a pending delete confirmation, an open menu, focus outside the panel — including an overlay that closed on the same keypress).
  - `apps/web/e2e/admin.spec.ts` — Playwright: the close button and Escape return to `/` without a reload. Runs only when `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` and `SUPABASE_SERVICE_ROLE_KEY` are set (see [testing](../architecture/testing.md#playwright-web-e2e)).
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
  - Adding a table with a foreign key to `auth.users`: declare it `on delete cascade`. Otherwise `deleteUser` fails, and both `DELETE /api/account` and `/api/admin/delete-user` return 500 for any user who owns a row in it, after their storage has already been swept. If only approved users can insert into the table, also add it to `USER_OWNED_TABLES` in the admin route. List it under "What is deleted" on `/account/delete` if users would recognise it as their data.
  - Changing the attachments storage path layout (`{userId}/{noteId}/{fileName}`): both sweeps in `apps/web/src/lib/storage/remove-user-attachments.ts` (strict and best-effort share the walker) walk the `{userId}/` prefix. Update them, `remove-user-attachments.test.ts`, `account-deletion.live.test.ts`, and step 4 of the manual procedure in [Account deletion](#account-deletion), or account deletion will leave files behind.
  - Changing `DELETE /api/account` status codes or its success body: update `requestAccountDeletion` / `describeAccountDeletionFailure` in `packages/shared/src/account/request-account-deletion.ts` and its test. Both native apps and the web section act on that mapping.
  - Changing account-deletion copy or labels: web `delete-account-section.tsx`, mobile `delete-account-dialog.tsx` and `(tabs)/settings.tsx`, desktop `delete-account-panel.tsx`, `app-menu.tsx` and `notebooks-sidebar.tsx`, the per-platform steps on `apps/web/src/app/account/delete/page.tsx` and `apps/web/src/app/support/page.tsx`, the Maestro flow's text selectors, and the accessibility-label checks in `apps/desktop/e2e/run-e2e.sh` ("App menu", "Sign out", "Delete account", "Type DELETE to confirm", including TEST 3's `knownDescs`).
  - Changing the email fallback address: `/account/delete`, `/support`, `/privacy`, `apps/mobile/store/metadata/privacy-policy.md`, `scripts/support-agent-prompt.md` and [support-agent.md](./support-agent.md#account-deletion-and-data-rights-requests). The address must stay a mailbox the support agent polls.
  - Changing `AuthContextValue` on mobile or desktop (e.g. `deleteAccount`): update the provider, and every test that mocks `useAuth` (`notebooks-sidebar.test.tsx`, `screens/settings.test.tsx`).
  - Moving the macOS account actions (`app-menu.tsx` / `notebooks-sidebar.tsx`): update the Mac steps on `apps/web/src/app/account/delete/page.tsx` and `apps/web/src/app/support/page.tsx` (and `legal-pages.test.tsx` / `account-delete-page.test.tsx`), and the element checks in `apps/desktop/e2e/run-e2e.sh`.
  - Changing the web API origin variables: `apps/mobile/app.config.ts`, `apps/desktop/src/types/env.d.ts`, `apps/desktop/src/lib/config.ts`, and [environments](../architecture/environments.md#web-api-origin-for-native-apps).
  - Adding a new OAuth provider: update both `apps/web/src/components/auth/oauth-buttons.tsx` and `apps/mobile/src/components/auth/oauth-buttons.tsx`, plus the Supabase dashboard config for each environment.
  - Changing a recovery redirect URL: update `RECOVERY_REDIRECT_URL` in the platform's `auth-recovery.ts`, its `RECOVERY_PATHS` set, **and** the Redirect URLs allowlist in both Supabase projects. The desktop `handleOAuthCallback` defers to `isRecoveryUrl()` to avoid consuming the recovery code — keep the two path sets consistent or the OAuth handler will burn it.

## Verify

Run after any auth-related change. Start local and widen to platforms touched by the change.

```bash
# Web unit + integration
cd apps/web && pnpm test

# Shared request helper (account deletion result mapping)
cd packages/shared && pnpm test

# Account deletion against the real DEV project (skips unless both are set; refuses any other host)
NEXT_PUBLIC_SUPABASE_URL=https://huhzactreblzcogqkbsd.supabase.co SUPABASE_SERVICE_ROLE_KEY=<dev service-role key> \
  pnpm --filter @drafto/web exec vitest run __tests__/integration/account-deletion.live.test.ts

# Web E2E (requires E2E_TEST_EMAIL / E2E_TEST_PASSWORD in apps/web/.env.local)
set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e -- auth
set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e -- account-deletion

# Mobile unit
cd apps/mobile && pnpm test

# Mobile E2E (Android emulator + dev client running)
maestro test apps/mobile/e2e/ --platform android

# Desktop unit
cd apps/desktop && pnpm test

# Lint + typecheck across the monorepo
pnpm lint && pnpm typecheck
```
