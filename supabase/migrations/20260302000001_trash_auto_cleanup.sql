-- Trash auto-cleanup: permanently delete notes trashed > 30 days ago
-- Runs daily via pg_cron at 3:00 AM UTC.

-- =============================================================================
-- CLEANUP FUNCTION (SECURITY DEFINER — bypasses RLS to clean all users)
-- =============================================================================

create or replace function public.cleanup_trashed_notes()
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  deleted_count integer;
begin
  delete from public.notes
  where is_trashed = true
    and trashed_at < now() - interval '30 days';

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- =============================================================================
-- SCHEDULE DAILY CRON JOB
-- =============================================================================

-- Enable pg_cron extension for scheduled jobs
create extension if not exists pg_cron with schema pg_catalog;

-- Schedule cleanup to run daily at 3:00 AM UTC
select cron.schedule(
  'cleanup-trashed-notes',
  '0 3 * * *',
  $$select public.cleanup_trashed_notes()$$
);
