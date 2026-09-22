-- Guard the privilege columns on public.profiles (issue #457).
--
-- The "Users can update own profile" policy in 20260224000001_initial_schema.sql
-- says "(but not is_approved or is_admin)" in its comment, but it only checks
-- row ownership:
--
--   for update using (auth.uid() = id) with check (auth.uid() = id)
--
-- RLS policies cannot restrict columns, and Supabase grants the `authenticated`
-- role table-level UPDATE on public tables by default. So any signed-in user,
-- approved or not, could PATCH their own row with
-- {"is_approved": true, "is_admin": true} using the public anon key and their
-- own JWT. That defeated the approval gate and made them an admin. Old
-- migrations are append-only, so the fix lives here.
--
-- The trigger below rejects any change to is_admin or is_approved made through
-- the API roles (`authenticated`, `anon`) unless the caller is an admin.
-- Everything else keeps working:
--   * Self-edits of other columns such as display_name. The guard only compares
--     the two flags, and IS DISTINCT FROM lets a full-row PATCH re-send them
--     unchanged.
--   * Interactive approval (/api/admin/approve-user) runs as `authenticated`
--     with public.is_admin() true.
--   * One-click approval (/api/admin/approve-user/one-click) runs as
--     `service_role`, which is not gated.
--   * Migrations, the SQL editor and the dashboard run as `postgres`, which is
--     not gated. That covers the manual re-run hinted at in
--     20260420000001_admin_bootstrap.sql and restoring an admin by hand.
--
-- Column privileges (`revoke update` plus `grant update (display_name)`) were
-- rejected: they would also block admins, who approve users through the same
-- `authenticated` role.
--
-- The function MUST stay SECURITY INVOKER. Under SECURITY DEFINER,
-- current_user would be the function owner (`postgres`) and the role check
-- would let every caller through.

-- =============================================================================
-- GUARD FUNCTION
-- =============================================================================

create or replace function public.guard_profile_privilege_columns()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  -- The row change being guarded is not yet visible to public.is_admin() in a
  -- BEFORE trigger, so a user cannot pass the check with their own is_admin grant.
  if (old.is_admin is distinct from new.is_admin
      or old.is_approved is distinct from new.is_approved)
     and current_user in ('authenticated', 'anon')
     and not public.is_admin() then
    raise exception 'profiles.is_admin / is_approved can only be changed by an admin'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.guard_profile_privilege_columns() is
  'BEFORE UPDATE trigger on public.profiles. Rejects changes to is_admin or '
  'is_approved from the authenticated/anon API roles unless public.is_admin(). '
  'Must stay SECURITY INVOKER. See issue #457.';

-- =============================================================================
-- TRIGGER
-- =============================================================================

drop trigger if exists guard_profile_privilege_columns on public.profiles;
create trigger guard_profile_privilege_columns
  before update on public.profiles
  for each row
  execute function public.guard_profile_privilege_columns();
