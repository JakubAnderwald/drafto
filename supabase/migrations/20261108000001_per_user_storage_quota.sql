-- Per-user attachment storage quota (issue #794, ADR 0069).
--
-- Until now the only limit was per file (50 MB, the bucket's file_size_limit).
-- Nothing capped an account's total, so one account could fill the Supabase free
-- plan's 1 GB of storage. Uploads reach storage by two routes: the web API
-- (upload-url → signed upload → confirm) and mobile/desktop, which upload with
-- supabase-js and upsert the attachments row themselves. So the quota is enforced
-- here, in the database, where both routes meet:
--
--   * profiles.storage_quota_bytes: the quota. 50 MB by default, NULL = unlimited.
--     Every admin is set to NULL below. Someone promoted to admin later keeps 50 MB
--     until an admin picks Unlimited on the admin page: the column is the only
--     source of truth.
--   * Usage is sum(attachments.file_size) for the user. Attachments on trashed
--     notes count until the trash cron purges the note.
--   * A BEFORE INSERT trigger on public.attachments refuses a row that would take
--     usage over the quota, with the message `storage_quota_exceeded`
--     (STORAGE_QUOTA_EXCEEDED_CODE in packages/shared). Landing exactly on the
--     quota is allowed.
--   * The storage.objects INSERT and UPDATE policies for the bucket also refuse once
--     the user is at or over the quota, so a client that skips the row insert can't
--     keep adding objects (see can_store_attachment()).
--   * guard_profile_privilege_columns() now also stops a user from changing their
--     own quota (e.g. PATCHing it to NULL with the anon key, the hole #457 closed
--     for is_admin / is_approved).
--
-- The internal helpers take a user id, so EXECUTE on them is revoked from the API
-- roles: granted to `authenticated`, they would let any user read anyone's usage.
-- What the API roles call takes no user id: can_store_attachment(),
-- get_my_storage_usage() (the caller only) and admin_storage_usage() (admins only).
--
-- Functions are not tables, so the Data API grants rule of `pnpm migration:check`
-- doesn't apply to them; the grants below are explicit anyway, because Supabase's
-- default privileges grant EXECUTE on new public functions to anon and
-- authenticated.

-- =============================================================================
-- COLUMN
-- =============================================================================

alter table public.profiles
  add column if not exists storage_quota_bytes bigint default 52428800;

alter table public.profiles
  add constraint profiles_storage_quota_bytes_nonnegative
  check (storage_quota_bytes is null or storage_quota_bytes >= 0);

comment on column public.profiles.storage_quota_bytes is
  'Attachment storage quota in bytes; NULL = unlimited. Default 52428800 (50 MB, '
  'DEFAULT_STORAGE_QUOTA_BYTES in packages/shared). Only admins may change it. '
  'See issue #794 / ADR 0069.';

-- Admins are unlimited. Runs as `postgres`, which the privilege guard doesn't gate.
update public.profiles
  set storage_quota_bytes = null
  where is_admin = true;

-- A negative file_size would make usage negative and let every later row through.
-- NOT VALID: enforced for new rows without scanning (or failing on) existing ones.
alter table public.attachments
  add constraint attachments_file_size_nonnegative
  check (file_size >= 0) not valid;

-- =============================================================================
-- PRIVILEGE GUARD: storage_quota_bytes joins is_admin / is_approved
-- =============================================================================

-- Same function as 20260922000001_guard_profile_privilege_columns.sql, with one
-- more guarded column. It MUST stay SECURITY INVOKER: under SECURITY DEFINER,
-- current_user would be the owner (`postgres`) and every caller would pass.
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
      or old.storage_quota_bytes is distinct from new.storage_quota_bytes)
     and current_user in ('authenticated', 'anon')
     and not public.is_admin() then
    raise exception 'profiles.is_admin / is_approved / storage_quota_bytes can only be changed by an admin'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.guard_profile_privilege_columns() is
  'BEFORE UPDATE trigger on public.profiles. Rejects changes to is_admin, '
  'is_approved or storage_quota_bytes from the authenticated/anon API roles unless '
  'public.is_admin(). Must stay SECURITY INVOKER. See issues #457 and #794.';

-- =============================================================================
-- INTERNAL HELPERS (not callable by the API roles)
-- =============================================================================

-- Bytes the user's attachment rows account for. This is the quota's usage.
create or replace function public.storage_usage_bytes(uid uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(sum(a.file_size), 0)::bigint
  from public.attachments a
  where a.user_id = uid;
$$;

-- Bytes of the user's objects in the attachments bucket, counting only objects
-- under a note the user still has ({uid}/{note_id}/{file}). Deleting a note
-- (the trash cron's purge, a mobile/desktop permanent delete) cascades its
-- attachment rows but leaves its objects behind, and Supabase doesn't let SQL
-- delete storage objects. Counting those orphans would refuse uploads from a
-- user who just emptied their trash. The cost: a client that skips the row
-- insert and then deletes the note escapes this term. It is defence in depth;
-- the attachments trigger is the quota.
create or replace function public.storage_object_bytes(uid uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(sum(
    case when (o.metadata ->> 'size') ~ '^[0-9]+$'
      then (o.metadata ->> 'size')::bigint
    end
  ), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'attachments'
    and split_part(o.name, '/', 1) = uid::text
    and exists (
      select 1 from public.notes n
      where n.user_id = uid
        and n.id::text = split_part(o.name, '/', 2)
    );
$$;

revoke all on function public.storage_usage_bytes(uuid) from public, anon, authenticated;
revoke all on function public.storage_object_bytes(uuid) from public, anon, authenticated;
grant execute on function public.storage_usage_bytes(uuid) to service_role;
grant execute on function public.storage_object_bytes(uuid) to service_role;

-- =============================================================================
-- ATTACHMENTS TRIGGER
-- =============================================================================

create or replace function public.enforce_attachment_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  quota bigint;
  used bigint;
  object_size bigint;
begin
  -- BEFORE triggers run before the insert policy's WITH CHECK. A row an API user
  -- files under someone else's user_id is refused by that policy; returning here
  -- keeps this trigger from answering with the other user's usage first.
  if auth.uid() is not null and new.user_id is distinct from auth.uid() then
    return new;
  end if;

  select p.storage_quota_bytes into quota
  from public.profiles p
  where p.id = new.user_id;

  -- Unlimited (NULL), or no profile row (the insert policy refuses API users
  -- without one anyway).
  if quota is null then
    return new;
  end if;

  -- Serialise this user's inserts, so two concurrent uploads can't both pass a
  -- check that only one of them fits.
  perform pg_advisory_xact_lock(hashtextextended('drafto.storage_quota:' || new.user_id::text, 0));

  -- A BEFORE INSERT trigger fires before ON CONFLICT resolves. The mobile/desktop
  -- retry after a partial success upserts a row that already exists
  -- (ON CONFLICT DO NOTHING inserts nothing), and that row already counts in
  -- usage, so neither count it twice nor refuse it.
  if exists (select 1 from public.attachments a where a.id = new.id) then
    return new;
  end if;

  -- file_size comes from the client. Both upload flows store the object before
  -- the row, so count the stored object's real size when it is larger.
  select case when (o.metadata ->> 'size') ~ '^[0-9]+$'
           then (o.metadata ->> 'size')::bigint
         end
    into object_size
  from storage.objects o
  where o.bucket_id = 'attachments'
    and o.name = new.file_path;

  if object_size is not null and object_size > new.file_size then
    new.file_size := object_size;
  end if;

  used := public.storage_usage_bytes(new.user_id);

  if used + coalesce(new.file_size, 0) > quota then
    raise exception using
      errcode = 'P0001',
      message = 'storage_quota_exceeded',
      detail = format('used_bytes=%s quota_bytes=%s file_size=%s', used, quota, new.file_size),
      hint = 'Delete attachments or empty the trash to free space.';
  end if;

  return new;
end;
$$;

comment on function public.enforce_attachment_storage_quota() is
  'BEFORE INSERT trigger on public.attachments. Raises storage_quota_exceeded when '
  'the user''s usage plus the new file_size would exceed profiles.storage_quota_bytes. '
  'See issue #794 / ADR 0069.';

-- A trigger's function needs no EXECUTE grant to fire.
revoke all on function public.enforce_attachment_storage_quota() from public, anon, authenticated;

drop trigger if exists enforce_attachment_storage_quota on public.attachments;
create trigger enforce_attachment_storage_quota
  before insert on public.attachments
  for each row
  execute function public.enforce_attachment_storage_quota();

-- =============================================================================
-- STORAGE POLICIES
-- =============================================================================

-- True while the caller may add bytes to the attachments bucket. False once their
-- rows already reach the quota, or their objects (under notes they still have)
-- reach the quota plus one maximum-size file (MAX_FILE_SIZE, 50 MB). Usage defined
-- as sum(file_size) never grows for a client that skips the row insert, so the
-- object term is what stops one. The one-file slack keeps the retry after a
-- partial success (object landed, row insert failed) from being refused: an RLS
-- WITH CHECK runs before the duplicate-object check, so that retry meets this
-- policy before its 409.
create or replace function public.can_store_attachment()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  uid uuid := auth.uid();
  quota bigint;
begin
  if uid is null then
    return false;
  end if;

  select p.storage_quota_bytes into quota
  from public.profiles p
  where p.id = uid;

  if not found then
    return false;
  end if;

  if quota is null then
    return true;
  end if;

  if public.storage_usage_bytes(uid) >= quota then
    return false;
  end if;

  return public.storage_object_bytes(uid) < quota + 52428800;
end;
$$;

comment on function public.can_store_attachment() is
  'Used by the attachments bucket''s INSERT and UPDATE policies on storage.objects. '
  'False once the caller''s usage reaches their storage quota. See issue #794 / ADR 0069.';

revoke all on function public.can_store_attachment() from public, anon;
grant execute on function public.can_store_attachment() to authenticated, service_role;

-- ALTER POLICY replaces the WITH CHECK expression, so the existing conditions from
-- 20260302000002_storage_attachments_bucket.sql are restated in full.
alter policy "Users can upload own attachments"
on storage.objects
with check (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
  and array_length(storage.foldername(name), 1) = 2
  and exists (
    select 1 from public.notes n
    where n.id::text = (storage.foldername(name))[2]
      and n.user_id = auth.uid()
  )
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_approved = true
  )
  and public.can_store_attachment()
);

-- The UPDATE policy (storage upserts) had only a USING clause, which also served as
-- its check. Without the quota here, a client could insert tiny objects and then
-- overwrite each with a 50 MB one. No Drafto client updates objects (every upload
-- passes upsert: false), so this refuses nothing they do.
alter policy "Users can update own attachments"
on storage.objects
with check (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
  and array_length(storage.foldername(name), 1) = 2
  and exists (
    select 1 from public.notes n
    where n.id::text = (storage.foldername(name))[2]
      and n.user_id = auth.uid()
  )
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_approved = true
  )
  and public.can_store_attachment()
);

-- =============================================================================
-- READ RPCS
-- =============================================================================

-- The caller's own usage and quota, for the settings screens and the clients'
-- pre-checks. One row; none when signed out.
create or replace function public.get_my_storage_usage()
returns table (used_bytes bigint, quota_bytes bigint)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select public.storage_usage_bytes(p.id) as used_bytes,
         p.storage_quota_bytes as quota_bytes
  from public.profiles p
  where p.id = auth.uid();
$$;

comment on function public.get_my_storage_usage() is
  'The caller''s attachment storage usage and quota (NULL = unlimited). See issue #794.';

revoke all on function public.get_my_storage_usage() from public, anon;
grant execute on function public.get_my_storage_usage() to authenticated, service_role;

-- Every user's usage and quota, for the admin page. Admins only.
create or replace function public.admin_storage_usage()
returns table (user_id uuid, used_bytes bigint, quota_bytes bigint)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_storage_usage can only be called by an admin'
      using errcode = '42501';
  end if;

  return query
    select p.id,
           coalesce(u.used, 0)::bigint,
           p.storage_quota_bytes
    from public.profiles p
    left join (
      select a.user_id as owner_id, sum(a.file_size)::bigint as used
      from public.attachments a
      group by a.user_id
    ) u on u.owner_id = p.id
    order by p.created_at;
end;
$$;

comment on function public.admin_storage_usage() is
  'Every user''s attachment storage usage and quota. Raises 42501 unless '
  'public.is_admin(). See issue #794.';

revoke all on function public.admin_storage_usage() from public, anon;
grant execute on function public.admin_storage_usage() to authenticated, service_role;
