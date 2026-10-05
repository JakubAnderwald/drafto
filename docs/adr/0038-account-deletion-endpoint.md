# 0038 — Account Deletion Endpoint for All Platforms

- **Status**: Accepted
- **Date**: 2026-09-14
- **Authors**: Drafto dark factory (issue [#623](https://github.com/JakubAnderwald/drafto/issues/623))

## Context

Apple App Store Review Guideline 5.1.1(v) requires any app that supports account creation to let users start account deletion inside the app. Google Play's User Data policy requires the same, plus a public web URL. Until now, the only way to delete a Drafto account was to email an address that had no mailbox. That blocks public store distribution on iOS, Android and macOS.

Four facts shaped the design:

1. **The database already cascades, but Storage does not.** Every user-scoped table references `auth.users(id) on delete cascade`: `profiles`, `notebooks`, `notes`, `attachments` and `api_keys`, and `note_content_history` cascades through `notes`. Deleting the auth user therefore removes every row, with no schema change. Attachment files in the `attachments` bucket are not removed by the cascade, and Supabase does not allow deleting `storage.objects` with SQL. They must be removed through the Storage API with the service role.
2. **Deleting an auth user needs the service role**, which must never ship in a client. Mobile and desktop talk directly to Supabase and have never called the web API, so the deletion has to run on a server that native clients can reach.
3. **Middleware trusts headers it sets itself.** `apps/web/src/lib/supabase/middleware.ts` injects `x-verified-user-id` / `x-verified-user-email` for authenticated requests, and `getAuthenticatedUserFast` reads them. On routes in `PUBLIC_ROUTES`, client headers pass through untouched, so those headers can be forged there. A cookie-less native request to a non-public route gets a 307 to `/login`, which `fetch` silently follows to a 200 HTML page.
4. **#622 (admins deleting pending signups, merged as #633)** already had a "delete the auth user, then clean storage best-effort" sequence. Two copies of irreversible deletion logic would drift.

## Decision

**Add one Next.js route, `DELETE /api/account`, that deletes only the caller's own account. It is the first web API route that native clients call with a Supabase bearer token.**

- **Authentication** lives in `apps/web/src/lib/account/authenticate-account-request.ts`.
  - If an `Authorization` header is present, it must be `Bearer <Supabase access token>`, verified with `createAdminClient().auth.getUser(token)`. Any other or invalid header is 401, with no cookie fallback.
  - With no header, the web session cookie is verified with the server client's `auth.getUser()`.
  - The route reads no body, query or params, so the user id comes only from the verified credential. Approval is not required: an unapproved user may delete their own account.
- **Public route, but no fast-path auth.** `/api/account` (and the explainer page `/account/delete`) are added to `PUBLIC_ROUTES`, so bearer clients reach the route instead of a login redirect. The route must therefore authenticate itself. It never uses `getAuthenticatedUserFast` or the `x-verified-*` headers, which are forgeable on public routes. It also never uses `getAuthenticatedUser`, which requires approval. Only `DELETE` is exported; there is no `GET` or form variant.
- **Last-admin guard.** If the caller is an admin and there are ≤ 1 admins, the route returns 409 and deletes nothing, so nobody is left unable to approve signups.
- **One shared helper, storage first.** `deleteUserAccount(admin, userId)` in `apps/web/src/lib/account/delete-user.ts` runs three steps:
  1. A strict storage sweep (`removeAllUserAttachments`): paged, recursive, batched, and throwing on any error.
  2. `auth.admin.deleteUser`, whose foreign-key cascades remove every row.
  3. A best-effort sweep (`removeUserAttachments`) for uploads that raced step 2.

  It reports its own failures to Sentry and returns `{ ok: false, stage: "storage" | "auth" }`, which callers map to a 500. A storage failure leaves the account intact, and a retry is safe because removal is idempotent. Both `/api/account` and `/api/admin/delete-user` use the helper. It takes the service-role client as a parameter and performs no authorization itself.

- **A Next.js route rather than a Supabase Edge Function.** The route reuses `createAdminClient`, the existing Sentry wiring, the storage walker in `remove-user-attachments.ts` and the vitest suite. It adds no deploy target, no function secrets and no second place to look during an incident.
- **Thin shared client.** `requestAccountDeletion` in `packages/shared` sends the request and reduces the response to `ok | unauthorized | last-admin | failed | network`. It returns `ok` only for a 200 JSON body with `success === true`, so a redirect that landed on an HTML page is never mistaken for success. `describeAccountDeletionFailure` gives every platform the same error copy.
- **Native local reset.** Only on `ok`, mobile and desktop skip the pre-sign-out sync flush and call `supabase.auth.signOut({ scope: "local" })`. They then run the existing #591 local reset, now shared with `signOut` in one helper per app. Any other result leaves the session and the local database untouched.
- **Web API origin.** The native apps find the web API through `EXPO_PUBLIC_API_URL` (mobile) and `API_URL` (desktop), which fall back to the apex `https://drafto.eu`. The apex is used rather than `www`, because a cross-host redirect would drop the `Authorization` header.
- **Not an MCP tool.** Account deletion is irreversible and must not be callable with an API key. The route accepts only a Supabase session or access token.

## Consequences

- **Positive**:
  - In-app deletion on all four platforms, plus a public explainer page, meets the Apple and Google requirements that blocked store distribution. It needs no schema change and no new paid infrastructure.
  - Self-deletion and admin deletion of pending signups share one tested sequence. The admin route also gains the strict storage sweep, so it no longer deletes a user whose files it failed to remove.
  - Failures fail closed and stay retryable. A storage error keeps the account. A token for the wrong Supabase project, or an origin that redirects, gets 401 and deletes nothing.
- **Negative**:
  - **Half state.** If `deleteUser` fails after a successful sweep, the account and rows remain but their files are gone, so attachments show as broken until the user retries.
  - **Last-admin race.** Two admins deleting themselves at the same moment could both pass the count. This is accepted while there is one admin.
  - **Public-route exposure.** `/api/account` is exempt from middleware authentication, and by prefix match so is anything later added under it. Its safety rests on the route's own checks and on the rule never to use the `x-verified-*` fast path there.
  - **New native dependency on the web app.** Mobile and desktop now depend on the web deployment being up for this one action, and need a new env variable per app. Unsynced local edits are discarded when a deletion succeeds.
  - **Sign in with Apple token revocation is not implemented.** Supabase keeps no Apple refresh token, and the web app holds no Apple signing key. The gap and a feasible follow-up are recorded in [`docs/features/auth.md`](../features/auth.md#sign-in-with-apple-token-revocation--open-gap), and the operator must decide on it before App Store submission.
- **Neutral**:
  - Emailed deletion requests to `support@drafto.eu` stay manual. The support agent always escalates them to a person, who confirms by replying and deletes through the dashboard, storage first, within 30 days.
  - `signOut` behaves as before. The only change is that its reset code now sits in a helper shared with `deleteAccount`.

## Alternatives Considered

- **Supabase Edge Function.** It would sit next to the database and could also verify a bearer token. Rejected: it would duplicate the storage walker, Sentry setup and test harness in a Deno runtime, add a second deploy target and function-level secrets, and still need a web page for Google Play's URL requirement.
- **Client-side deletion.** Deleting through the Admin API from the client is impossible without shipping the service-role key, which would give every user full database access. A `security definer` RPC could delete the `auth.users` row from SQL, but it cannot remove the user's Storage objects, because SQL deletes on `storage.objects` are not allowed. It would also need a migration, and it would move the last-admin guard and Sentry reporting into PL/pgSQL.
- **Delete the auth user first, then sweep storage best-effort.** This was the shape of the original #622 admin route. Rejected for self-service deletion: a failed sweep would leave orphaned files that no row links back to, and the user could no longer sign in to retry. The best-effort sweep is kept only as a final pass after `deleteUser`.
- **Soft delete or a grace period.** It would allow an undo, but it adds a schema change, a scheduled purge job and a user state that every RLS policy would need to respect. Out of scope for #623, which calls for immediate, permanent deletion.
- **Reuse `getAuthenticatedUserFast` and keep the route behind middleware.** Rejected: bearer clients would be redirected to `/login`, and making the route public while still reading the `x-verified-*` headers would let anyone delete any account with a forged header.
- **Expose deletion as an MCP tool.** Rejected: a leaked or over-scoped API key must never be able to destroy the whole account.
