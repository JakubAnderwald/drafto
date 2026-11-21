# 0094 — Open Signup with Admin Suspend

- **Status**: Accepted
- **Date**: 2026-11-21
- **Authors**: Jakub Anderwald

## Context

Since [ADR-0019](./0019-email-infrastructure-and-approval-flow.md) every signup has waited for an admin to approve it. The admin got an email with a signed one-click approve link (`/api/admin/approve-user/one-click`, HMAC with `APPROVAL_LINK_SECRET`, 72 h), and the new user sat on `/waiting-for-approval` until someone clicked it. Every RLS policy and the attachments bucket gate on `public.is_approved()`.

Approval was doing one job: keeping an unknown account from using up resources every account shares. Drafto runs on free tiers, so a single account could fill the 1 GB storage bucket or the 500 MB database. Two decisions now bound that per account:

- [ADR-0072](./0072-per-user-attachment-storage-quota.md) caps attachment storage (50 MB by default).
- [ADR-0090](./0090-per-user-note-content-quota.md) caps note content (25 MB by default) and note history. Its daily cron also reports ADR-0072's signed-URL overrun gap to Sentry.

On 2026-11-21 production had 39 accounts and none pending, so the gate was delaying real users without catching anyone. Each signup also waited on a person.

Email confirmation stays on, and Supabase rate-limits auth per IP (`sign_in_sign_ups = 30` per 5 minutes).

## Decision

Signup is open. `profiles.is_approved` stays, and becomes the admin's suspend switch.

- **New accounts start active.** `supabase/migrations/20261121000003_open_signup_approved_by_default.sql` sets `alter table public.profiles alter column is_approved set default true`. `handle_new_user()` inserts only `(id)`, so every new profile takes the default. No existing row changes: a signup still pending when it runs stays pending until an admin activates or deletes it.
- **Suspend and reactivate on `/admin`.** The page lists every account in two sections.
  - _Inactive_ accounts (suspended, or pending from before this change) get **Activate** (`POST /api/admin/approve-user`, which now sends "Your Drafto account is active") and **Delete** (`POST /api/admin/delete-user`, unchanged: only accounts that own nothing).
  - _Active_ accounts get **Suspend**: `POST /api/admin/suspend-user`, after a confirmation, sets `is_approved = false`. It uses the admin's own session, so `guard_profile_privilege_columns` and the admins-update policy apply. It refuses the requesting admin and, through an `is_admin = false` filter on the update itself, any admin. It deletes nothing and sends no email.
  - RLS already gates on `is_approved`, so a suspension cuts the account's data access on its next request on every platform. The web middleware sends its next page load to the inactive screen. Mobile and desktop move there at the next launch, sign-in or "Check again", and, for a session that is already open, at the hourly token refresh: an approved user's refresh now runs a quiet re-check (`recheckApproval` in both `auth-provider.tsx`) that never puts the approval gate in flight, so the open note isn't disturbed, and acts only on a definite "not active" from the server.
- **The signup email becomes a notice.** `/api/webhooks/new-signup` still emails every admin, now saying the account is already active and linking to `/admin`. The one-click route, `apps/web/src/lib/approval-tokens.ts` and `APPROVAL_LINK_SECRET` are removed, along with the `/admin` flash banner that only showed one-click results. A one-click link already in someone's inbox now answers 404.
- **One message for an inactive account.** Web `/waiting-for-approval`, mobile `(auth)/waiting-for-approval` and desktop `WaitingForApprovalScreen` keep their routes and gating logic but show the shared text from `packages/shared/src/constants.ts` (`ACCOUNT_INACTIVE_TITLE`, `ACCOUNT_INACTIVE_MESSAGE`, …): "Account not active … contact support@drafto.eu". The button becomes "Check again". Web signup that returns a session now pushes to `/`, not to the waiting page.
- **Copy.** The landing page no longer says accounts are approved by hand. The privacy policy's "Account approval" section becomes "Account review": anyone can sign up, the admin gets a notice per signup, and an account used for spam or abuse may be suspended.
- **No captcha.** Supabase's captcha protection is project-wide. It needs a token on password sign-in and password reset too, so turning it on would lock every shipped mobile and desktop build out of password sign-in. It would also need a Turnstile WebView on React Native macOS. The quotas, email confirmation, the auth rate limits, the per-signup notice and Suspend cover bots for now.

## Consequences

- **Positive**:
  - New users start using Drafto as soon as they confirm their email, with no admin in the loop.
  - The admin can act on any account, not only new ones. Suspending is instant, everywhere, and reversible, and it deletes nothing.
  - One less secret to keep (`APPROVAL_LINK_SECRET`), and no signed links to expire or leak.
- **Negative**:
  - A spammer's account works until an admin notices the signup notice or a Sentry overrun report and suspends it. The quotas bound what it can store meanwhile.
  - A suspended user with mobile or desktop open keeps seeing their local notes for up to an hour, until the next token refresh. Nothing they do in that time syncs, because RLS refuses it.
  - `/admin` now lists every account. It reads emails with one paged `auth.admin.listUsers` call (`apps/web/src/lib/auth/list-user-emails.ts`) rather than one lookup per account, but the list itself isn't paginated yet.
  - Mobile and desktop builds from before this change show the old "Awaiting Approval" copy to a suspended account. Gating is unchanged, so only the wording is stale.
  - The desktop In-Test scenario `458-sync-gating.sh` can no longer rely on a fresh signup being pending. It now suspends the account by SQL right after signup, and fails fast if prod ever stops requiring email confirmation, because then the account would sync before it could be suspended.
- **Neutral**:
  - The column keeps its name `is_approved`, and the route its name `/waiting-for-approval`, to avoid churn across RLS, middleware, both native navigators and the approval caches. They now mean "active".
  - A suspended account with notes can't be deleted from `/admin`: the delete route still refuses any account that owns data, and its confirmation says so. Deleting one stays a manual, explicit operation.
  - Activate is idempotent: the update matches only an inactive row, so activating an account that is already active succeeds without a second email.

## Alternatives Considered

- **Keep manual approval.** Rejected: with both quotas in place it protects nothing the quotas don't, and it makes every real user wait for a person.
- **Auto-approve with a delay, or approve after N hours unless an admin rejects.** Rejected: it adds a scheduled job and a third account state for no extra protection over immediate approval plus Suspend.
- **Turnstile captcha on signup.** Rejected for now; see Decision. Revisit if bot signups show up in the notices.
- **A separate `suspended_at` column.** It would tell "pending from before open signup" apart from "suspended". Rejected: the old pending signups are a one-off that the admin clears once, and a second flag would need its own guard, RLS and client changes.
