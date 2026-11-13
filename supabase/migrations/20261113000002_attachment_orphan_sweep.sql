-- Removing a deleted note's attachment files (issue #794 follow-up).
--
-- Deleting a note cascades its attachment rows, but nothing removed its objects
-- from the attachments bucket. Supabase doesn't let SQL delete storage objects
-- (only the Storage API removes the file itself), and the bucket's DELETE
-- policy only matches objects under a note the user still has, so once the note
-- is gone the user's own client can't remove them either. Every path that
-- deletes a note left its files behind:
--
--   * the trash cron's purge, cleanup_trashed_notes() (pg_cron, daily 03:00 UTC);
--   * deleting a notebook (web, MCP), which cascades its trashed notes;
--   * mobile and desktop permanent deletes, which sync push as row deletes.
--
-- So the web app now sweeps them with the service role: orphaned_attachment_objects()
-- lists the objects whose note no longer exists, and the server removes them
-- through the Storage API right after a web or MCP delete (that user only) and
-- daily from the Vercel cron at /api/cron/cleanup-trash (everyone), which covers
-- the purge and mobile/desktop deletes.
--
-- The storage policy's object term (storage_object_bytes) still skips objects
-- whose note is gone, so a user who frees space on mobile isn't refused while
-- their deleted notes' files wait for the daily sweep. What a client can store
-- by uploading, deleting and repeating is now bounded by a day, not unbounded.

-- Also: EXECUTE on cleanup_trashed_notes() was never revoked from anon or
-- authenticated, so anyone with the public anon key could run the 30-day purge
-- early. Only pg_cron (as postgres) and the cron route (now with the service
-- role) call it.

-- =============================================================================
-- ORPHAN LISTING (service role only)
-- =============================================================================

-- Names of attachment objects ({user}/{note}/{file}) whose note no longer exists,
-- for the server to remove through the Storage API. `only_user` limits it to one
-- user's folder; NULL lists everyone's. At most `max_rows` (capped at 1000, the
-- Storage API's limit for one remove request), oldest name first.
--
-- An object can only be uploaded under a note that exists (the INSERT policy, and
-- the upload-url route for signed uploads), and note ids are never reused, so an
-- object whose note is gone can't belong to anything any more.
create or replace function public.orphaned_attachment_objects(
  max_rows integer default 1000,
  only_user uuid default null
)
returns setof text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'attachments'
    -- A prefix match, so a per-user listing can use the (bucket_id, name) index.
    -- A uuid's text has no LIKE wildcards.
    and (only_user is null or o.name like only_user::text || '/%')
    and not exists (
      select 1 from public.notes n
      where n.user_id::text = split_part(o.name, '/', 1)
        and n.id::text = split_part(o.name, '/', 2)
    )
  order by o.name
  limit greatest(least(coalesce(max_rows, 1000), 1000), 0);
$$;

comment on function public.orphaned_attachment_objects(integer, uuid) is
  'Attachment object names whose note no longer exists, for the web app to remove '
  'with the service role. Service role only. See issue #794.';

revoke all on function public.orphaned_attachment_objects(integer, uuid) from public, anon, authenticated;
grant execute on function public.orphaned_attachment_objects(integer, uuid) to service_role;

-- =============================================================================
-- THE PURGE IS NOT AN API FUNCTION
-- =============================================================================

revoke all on function public.cleanup_trashed_notes() from public, anon, authenticated;
grant execute on function public.cleanup_trashed_notes() to service_role;
