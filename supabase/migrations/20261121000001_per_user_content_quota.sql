-- Per-user note content quota (ADR 0090).
--
-- ADR 0072 capped attachment storage per user. Note text had no cap, and the
-- Supabase free plan's 500 MB database is shared by every account, so one account
-- (scripted through PostgREST, an API key or MCP) could fill it. This is the
-- guardrail that lets signup stop needing a manual approval.
--
--   * profiles.content_quota_bytes: the quota. 25 MB by default, NULL = unlimited.
--     Every admin is set to NULL below. On 2026-11-21 the heaviest prod account held
--     1.5 MB of note content and the median 5 KB, so 25 MB is an abuse ceiling, not
--     a product limit. Admins raise it per user on the admin page.
--   * Usage is sum(pg_column_size(notes.content)) for the user, trashed notes
--     included, until the note is deleted permanently or the trash cron purges it.
--   * A BEFORE INSERT OR UPDATE OF content trigger on public.notes refuses a write
--     that grows the user's usage past the quota, with the message
--     `content_quota_exceeded` (CONTENT_QUOTA_EXCEEDED_CODE in packages/shared). A
--     write that doesn't grow the note (unchanged content, or shorter text) always
--     passes, so a user over the quota can still shrink, trash and delete notes.
--   * note_content_history is not counted: users can't delete it, so counting it
--     would refuse a heavy editor with no way to free space. It is capped instead:
--     archive_note_content() now drops the user's oldest versions once their
--     history exceeds their content quota (unlimited users keep 30 days of it all).
--   * guard_profile_privilege_columns() now guards content_quota_bytes too.
--
-- pg_column_size() of a stored value is its on-disk (possibly compressed) size; of
-- NEW in a BEFORE trigger it is the uncompressed size, as the row isn't stored yet.
-- So the check slightly overestimates the note being written, never the others.
--
-- As in 20261113000001_per_user_storage_quota.sql, helpers that take a user id are
-- revoked from the API roles; the API roles call no-argument wrappers only.

-- =============================================================================
-- COLUMN
-- =============================================================================

alter table public.profiles
  add column if not exists content_quota_bytes bigint default 26214400;

alter table public.profiles
  drop constraint if exists profiles_content_quota_bytes_nonnegative;
alter table public.profiles
  add constraint profiles_content_quota_bytes_nonnegative
  check (content_quota_bytes is null or content_quota_bytes >= 0);

comment on column public.profiles.content_quota_bytes is
  'Note content quota in bytes (sum of pg_column_size(notes.content)); NULL = '
  'unlimited. Default 26214400 (25 MB, DEFAULT_CONTENT_QUOTA_BYTES in '
  'packages/shared). Only admins may change it. See ADR 0090.';

-- Admins are unlimited. Runs as `postgres`, which the privilege guard doesn't gate.
update public.profiles
  set content_quota_bytes = null
  where is_admin = true;

-- =============================================================================
-- PRIVILEGE GUARD: content_quota_bytes joins the guarded columns
-- =============================================================================

-- Same function as 20261113000001_per_user_storage_quota.sql, with one more guarded
-- column. It MUST stay SECURITY INVOKER: under SECURITY DEFINER, current_user would
-- be the owner (`postgres`) and every caller would pass.
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
      or old.is_approved is distinct from new.is_approved
      or old.storage_quota_bytes is distinct from new.storage_quota_bytes
      or old.content_quota_bytes is distinct from new.content_quota_bytes)
     and current_user in ('authenticated', 'anon')
     and not public.is_admin() then
    raise exception 'profiles.is_admin / is_approved / storage_quota_bytes / content_quota_bytes can only be changed by an admin'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.guard_profile_privilege_columns() is
  'BEFORE UPDATE trigger on public.profiles. Rejects changes to is_admin, '
  'is_approved, storage_quota_bytes or content_quota_bytes from the '
  'authenticated/anon API roles unless public.is_admin(). Must stay SECURITY '
  'INVOKER. See issues #457 and #794, ADR 0090.';

-- =============================================================================
-- INTERNAL HELPER (not callable by the API roles)
-- =============================================================================

-- Bytes the user's note content takes. This is the quota's usage.
create or replace function public.content_usage_bytes(uid uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(sum(pg_column_size(n.content)), 0)::bigint
  from public.notes n
  where n.user_id = uid;
$$;

revoke all on function public.content_usage_bytes(uuid) from public, anon, authenticated;
grant execute on function public.content_usage_bytes(uuid) to service_role;

-- =============================================================================
-- NOTES TRIGGER
-- =============================================================================

create or replace function public.enforce_note_content_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  quota bigint;
  used bigint;
  new_size bigint := coalesce(pg_column_size(new.content), 0);
  old_size bigint := 0;
begin
  -- BEFORE triggers run before the policies' WITH CHECK. A row an API user files
  -- under someone else's user_id is refused by RLS; returning here keeps this
  -- trigger from answering with the other user's usage first.
  if auth.uid() is not null and new.user_id is distinct from auth.uid() then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Mobile and desktop send content with every note update (trash, rename,
    -- move), so an unchanged value must never be refused.
    if new.content is not distinct from old.content then
      return new;
    end if;
    -- A write that doesn't grow the note always passes, so a user over the quota
    -- can still edit down. Compare text with text: pg_column_size(old.content) is
    -- the stored, possibly compressed size, while NEW isn't stored yet.
    if octet_length(coalesce(new.content::text, '')) <= octet_length(coalesce(old.content::text, '')) then
      return new;
    end if;
    old_size := coalesce(pg_column_size(old.content), 0);
  else
    if new.content is null then
      return new;
    end if;
    -- A BEFORE INSERT trigger fires before ON CONFLICT resolves. When mobile or
    -- desktop re-send a note the server already has (the response to the first
    -- push was lost), the upsert turns into an UPDATE of that row, and this
    -- trigger checks it again on that path. Counting it here would count the
    -- note twice.
    if exists (select 1 from public.notes n where n.id = new.id) then
      return new;
    end if;
  end if;

  select p.content_quota_bytes into quota
  from public.profiles p
  where p.id = new.user_id;

  -- Unlimited (NULL), or no profile row (RLS refuses API users without one anyway).
  if quota is null then
    return new;
  end if;

  -- Serialise this user's growing writes, so two concurrent saves can't both pass
  -- a check that only one of them fits.
  perform pg_advisory_xact_lock(hashtextextended('drafto.content_quota:' || new.user_id::text, 0));

  -- On UPDATE the old content is still in the table and counted in usage.
  used := public.content_usage_bytes(new.user_id) - old_size;

  if used + new_size > quota then
    raise exception using
      errcode = 'P0001',
      message = 'content_quota_exceeded',
      detail = format('used_bytes=%s quota_bytes=%s note_bytes=%s', used, quota, new_size),
      hint = 'Delete notes you no longer need and empty the trash to free space.';
  end if;

  return new;
end;
$$;

comment on function public.enforce_note_content_quota() is
  'BEFORE INSERT OR UPDATE OF content trigger on public.notes. Raises '
  'content_quota_exceeded when a write that grows a note would take the user''s '
  'content usage over profiles.content_quota_bytes. See ADR 0090.';

-- A trigger's function needs no EXECUTE grant to fire.
revoke all on function public.enforce_note_content_quota() from public, anon, authenticated;

-- Triggers on one event fire in name order: this one sorts before
-- on_notes_content_archive, so a refused update never archives anything.
drop trigger if exists enforce_note_content_quota on public.notes;
create trigger enforce_note_content_quota
  before insert or update of content on public.notes
  for each row
  execute function public.enforce_note_content_quota();

-- =============================================================================
-- HISTORY CAP: archive_note_content() prunes the user's oldest versions
-- =============================================================================

-- The cap walks one user's history newest first.
create index if not exists idx_note_content_history_user_archived
  on public.note_content_history (user_id, archived_at desc, id desc);

-- Same function as 20260425000001_note_content_history.sql (ADR 0022), plus the
-- cap. History isn't counted in the quota, so without a cap one account could fill
-- the database by rewriting a large note in a loop. The cap equals the user's
-- content quota; unlimited users keep all 30 days.
create or replace function public.archive_note_content()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  cap bigint;
begin
  insert into public.note_content_history
    (note_id, user_id, content, content_updated_at, archived_by)
  values
    (
      old.id,
      old.user_id,
      old.content,
      old.updated_at,
      nullif(current_setting('app.client', true), '')
    );

  select p.content_quota_bytes into cap
  from public.profiles p
  where p.id = old.user_id;

  if cap is not null
     and (select coalesce(sum(pg_column_size(x.content)), 0)
          from public.note_content_history x
          where x.user_id = old.user_id) > cap then
    -- Keep the newest versions that fit in the cap; drop the rest.
    delete from public.note_content_history h
    where h.id in (
      select t.id
      from (
        select x.id,
               sum(pg_column_size(x.content)) over (
                 order by x.archived_at desc, x.id desc
               ) as kept_bytes
        from public.note_content_history x
        where x.user_id = old.user_id
      ) t
      where t.kept_bytes > cap
    );
  end if;

  return new;
end;
$$;

comment on function public.archive_note_content() is
  'BEFORE UPDATE trigger on public.notes (when content changes). Archives the '
  'prior content into note_content_history, then drops the user''s oldest versions '
  'beyond their content quota. See ADR 0022 and ADR 0090.';

-- =============================================================================
-- READ RPCS
-- =============================================================================

-- The caller's own content usage and quota, for the settings screens. Same row
-- shape as get_my_storage_usage(). One row; none when signed out.
create or replace function public.get_my_content_usage()
returns table (used_bytes bigint, quota_bytes bigint)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select public.content_usage_bytes(p.id) as used_bytes,
         p.content_quota_bytes as quota_bytes
  from public.profiles p
  where p.id = auth.uid();
$$;

comment on function public.get_my_content_usage() is
  'The caller''s note content usage and quota (NULL = unlimited). See ADR 0090.';

revoke all on function public.get_my_content_usage() from public, anon;
grant execute on function public.get_my_content_usage() to authenticated, service_role;

-- Every user's content usage and quota, for the admin page. Admins only. Same row
-- shape as admin_storage_usage().
create or replace function public.admin_content_usage()
returns table (user_id uuid, used_bytes bigint, quota_bytes bigint)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_content_usage can only be called by an admin'
      using errcode = '42501';
  end if;

  return query
    select p.id,
           coalesce(u.used, 0)::bigint,
           p.content_quota_bytes
    from public.profiles p
    left join (
      select n.user_id as owner_id, sum(pg_column_size(n.content))::bigint as used
      from public.notes n
      group by n.user_id
    ) u on u.owner_id = p.id
    order by p.created_at;
end;
$$;

comment on function public.admin_content_usage() is
  'Every user''s note content usage and quota. Raises 42501 unless '
  'public.is_admin(). See ADR 0090.';

revoke all on function public.admin_content_usage() from public, anon;
grant execute on function public.admin_content_usage() to authenticated, service_role;

-- =============================================================================
-- STORAGE OVERRUN REPORT (ADR 0072's accepted signed-URL gap)
-- =============================================================================

-- Users whose stored attachment objects (under notes they still have) exceed their
-- storage quota plus one maximum-size file. Only signed upload URLs created ahead
-- of use and never confirmed can get a user there (ADR 0072, "Negative"). The daily
-- cleanup cron reports them to Sentry so an admin can suspend the account; the gap
-- itself stays accepted.
create or replace function public.storage_quota_overruns()
returns table (user_id uuid, object_bytes bigint, quota_bytes bigint)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p.id, b.object_bytes, p.storage_quota_bytes
  from public.profiles p
  cross join lateral (select public.storage_object_bytes(p.id) as object_bytes) b
  where p.storage_quota_bytes is not null
    and b.object_bytes > p.storage_quota_bytes + 52428800;
$$;

comment on function public.storage_quota_overruns() is
  'Users whose attachment objects exceed storage quota + 50 MB. service_role only; '
  'called by the daily cleanup cron. See ADR 0072 / ADR 0090.';

revoke all on function public.storage_quota_overruns() from public, anon, authenticated;
grant execute on function public.storage_quota_overruns() to service_role;
