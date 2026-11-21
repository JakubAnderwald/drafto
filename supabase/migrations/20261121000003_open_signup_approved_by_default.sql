-- =============================================================================
-- OPEN SIGNUP: NEW PROFILES START APPROVED (ADR 0094)
-- =============================================================================
-- Signup no longer waits for an admin. The per-user attachment quota (ADR 0072)
-- and note content quota (ADR 0090) now bound what one account can store, so
-- `is_approved` stops meaning "an admin let this account in" and becomes the
-- admin's suspend switch: RLS on every table and the attachments bucket still
-- gates on public.is_approved(), so an admin setting it to false (POST
-- /api/admin/suspend-user) locks the account out of its data on every platform.
--
-- handle_new_user() inserts only (id), so a new profile takes this default. No
-- existing row changes: a signup still pending when this runs stays pending until
-- an admin activates or deletes it on /admin. The privilege guard
-- (guard_profile_privilege_columns) fires on UPDATE only, so the default doesn't
-- touch it, and a user still can't change their own is_approved.
alter table public.profiles alter column is_approved set default true;

comment on column public.profiles.is_approved is
  'Whether the account may reach its data. True from signup (ADR 0094); an admin '
  'sets it to false to suspend the account and back to true to reactivate it. '
  'Every RLS policy and the attachments bucket gate on public.is_approved().';
