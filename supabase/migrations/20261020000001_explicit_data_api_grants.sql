-- Explicit Data API grants for every public table.
--
-- From 2026-10-30 Supabase stops auto-granting anon / authenticated / service_role on
-- new tables in `public` (an ALTER DEFAULT PRIVILEGES revoke). Tables that already
-- exist keep the grants they got at creation, so on prod and dev this migration is a
-- no-op. It exists so that replaying the migrations into a fresh database (a new
-- project, `supabase db reset --linked` on dev, disaster recovery) yields tables the
-- app can reach: none of the earlier migrations grants anything.
--
-- RLS still decides which rows a role sees; these grants only let the Data API reach
-- the table. anon gets nothing: no signed-out code path reads or writes a table
-- directly (the cron route only calls the SECURITY DEFINER cleanup_trashed_notes).
--
-- See ADR 0052 (docs/adr/0052-explicit-data-api-grants.md).

grant select, insert, update, delete on table
  public.notebooks,
  public.notes,
  public.attachments,
  public.api_keys
  to authenticated, service_role;

-- Profile rows come only from the SECURITY DEFINER handle_new_user trigger, and no
-- policy lets a user insert or delete one. UPDATE stays table-wide because admins
-- approve users through their own session (approve-user route). Stopping users from
-- setting their own is_admin / is_approved is the job of a guard trigger (#457), not
-- of grants.
grant select, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.profiles to service_role;

-- Written only by the SECURITY DEFINER trigger and pg_cron job; API roles only read it.
grant select on table public.note_content_history to authenticated, service_role;
