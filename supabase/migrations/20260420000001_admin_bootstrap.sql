-- =============================================================================
-- ADMIN BOOTSTRAP
-- =============================================================================
-- Make jakub@anderwald.info an admin and mark them approved so the account
-- approval flow can be bootstrapped without needing manual dashboard edits.
--
-- Idempotent: if the row is already admin/approved, this is a no-op.
-- Safe if the auth.users row doesn't exist yet (NULL subquery → 0 rows updated).
-- =============================================================================

update public.profiles
set is_admin = true,
    is_approved = true
where id = (
  select id from auth.users where email = 'jakub@anderwald.info' limit 1
);
