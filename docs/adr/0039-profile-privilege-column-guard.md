# 0039 — Trigger Guard on Profile Privilege Columns

- **Status**: Accepted
- **Date**: 2026-09-22
- **Authors**: Drafto dark factory (issue [#457](https://github.com/JakubAnderwald/drafto/issues/457))

## Context

`public.profiles` holds two privilege flags: `is_approved` (the invite-only approval gate) and `is_admin`. The "Users can update own profile" policy in `20260224000001_initial_schema.sql` says in a comment that users cannot change either one, but the policy only checks row ownership (`using (auth.uid() = id) with check (auth.uid() = id)`). Supabase grants the `authenticated` role table-level `UPDATE` on public tables by default. So any signed-in user, approved or not, could send `PATCH /rest/v1/profiles?id=eq.<own-id>` with `{"is_approved": true, "is_admin": true}`, using only the public anon key and their own JWT. That bypassed the approval gate and made them an admin.

Four facts shaped the fix:

- A Postgres RLS policy filters rows, not columns. It cannot say "this row, but not these columns".
- Admins approve users in two ways. `/api/admin/approve-user` uses the admin's own session, so it runs as the same `authenticated` role as the attacker. `/api/admin/approve-user/one-click` uses the service-role client.
- Operators change the flags as `postgres`: the `20260420000001_admin_bootstrap.sql` migration, its manual re-run, and restoring an admin in the dashboard.
- Migrations are append-only, so the original policy cannot be edited in place.

## Decision

Add a `BEFORE UPDATE ... FOR EACH ROW` trigger on `public.profiles` (`supabase/migrations/20260922000001_guard_profile_privilege_columns.sql`). The trigger raises `42501` (`insufficient_privilege`, HTTP 403 from PostgREST) when all three of these are true:

1. `is_admin` or `is_approved` changes, compared with `IS DISTINCT FROM`.
2. `current_user` is one of the API roles, `authenticated` or `anon`.
3. `public.is_admin()` is false for the caller.

The trigger function is `SECURITY INVOKER`, so `current_user` is the caller's role. Under `SECURITY DEFINER` it would be the function owner (`postgres`), and the guard would let every caller through. A static test in `scripts/__tests__/profile-privilege-guard.test.mjs` pins this. An opt-in live test (`profile-privilege-guard.live.test.mjs`) checks the real behaviour on the dev project.

## Consequences

- **Positive**: Users can no longer approve themselves or make themselves admins. No app code changed: both approval routes, the admin bootstrap and self-edits of `display_name` keep working. Because of `IS DISTINCT FROM`, a full-row `PATCH` that sends the flags back unchanged still succeeds.
- **Negative**: Any code running as `postgres` or `service_role` skips the guard. That includes the SQL editor, the dashboard, and any future `SECURITY DEFINER` function that writes `profiles`. This is deliberate, but a future definer function that updates `profiles` on a user's behalf must check permissions itself. The role check is a denylist (`authenticated`, `anon`), so a new API-facing role would not be gated until it is added.
- **Neutral**: The guard covers `UPDATE` only. `INSERT` is already closed, because `profiles` has no insert policy and rows come only from the `handle_new_user` definer trigger. A new privilege column must be added to the guard in a new migration.

## Alternatives Considered

- **Column privileges** (`revoke update on public.profiles from authenticated; grant update (display_name) ...`). This is the idiomatic Postgres answer, but it would also block admins, whose interactive approval runs as `authenticated`. The approve-user route would have to move to the service-role client, which is an app change and loses the RLS check on the admin's own session.
- **A `WITH CHECK` that compares each flag with the stored row** (`with check (is_admin = (select p.is_admin from profiles p where p.id = auth.uid()) and ...)`). This would work, because the permissive "Admins can update all profiles" policy still lets admins through. But policies cannot see `OLD`, so it depends on a subquery inside a `profiles` policy reading the pre-update row. That is the self-referencing pattern `20260225000001_fix_rls_recursion.sql` replaced with helper functions. It is also harder to reason about and test than a trigger with one explicit condition, and the issue named the trigger as the preferred fix.
- **Move the flags to a separate table with no user write policy.** This is the cleanest separation, but it changes the schema every client reads (web middleware and the mobile and desktop `AuthProvider`s) for a fix that needs none of that.
