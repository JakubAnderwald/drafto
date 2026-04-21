-- =============================================================================
-- ADMIN BOOTSTRAP
-- =============================================================================
-- Make jakub@anderwald.info an admin and mark them approved so the account
-- approval flow can be bootstrapped without needing manual dashboard edits.
--
-- If the user doesn't exist yet, emits a NOTICE instead of failing so a fresh
-- project can be bootstrapped by running migrations → signing up → manually
-- setting is_admin on the profile, or by re-running this migration after the
-- first signup.
-- =============================================================================

do $$
declare
  target_id uuid;
begin
  select id into target_id
  from auth.users
  where email = 'jakub@anderwald.info'
  limit 1;

  if target_id is null then
    raise notice 'admin_bootstrap: no auth user with email jakub@anderwald.info found — no admin set. Sign up that account, then run: update public.profiles set is_admin = true, is_approved = true where id = (select id from auth.users where email = ''jakub@anderwald.info'');';
    return;
  end if;

  update public.profiles
  set is_admin = true,
      is_approved = true
  where id = target_id;

  if not found then
    raise notice 'admin_bootstrap: auth user % exists but has no public.profiles row. Check the handle_new_user trigger.', target_id;
  end if;
end $$;
