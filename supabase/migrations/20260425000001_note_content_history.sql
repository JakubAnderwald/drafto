-- Per-note content history with 30-day retention.
--
-- Captures the prior `notes.content` jsonb on every UPDATE that actually
-- changes content, via a BEFORE-UPDATE trigger. Lets us recover from
-- accidental overwrites (incident 2026-04-24, PR #323) without depending
-- on Supabase backups — production is on the Free tier, which provides
-- neither daily backups nor PITR.
--
-- Retention is enforced by a nightly pg_cron job that deletes rows older
-- than 30 days. Mirrors the existing trash cleanup pattern in
-- 20260302000001_trash_auto_cleanup.sql.
--
-- See ADR 0022 (docs/adr/0022-note-content-history.md) for context.

-- =============================================================================
-- TABLE
-- =============================================================================

create table public.note_content_history (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  -- Copied from notes.user_id at archive time. No FK to auth.users — the
  -- referencing notes row already has that constraint, and we want history
  -- to survive briefly even if a user is deleted (cascade from notes.id
  -- still cleans up).
  user_id uuid not null,
  -- The PRIOR content (what's about to be overwritten).
  content jsonb,
  -- OLD.updated_at at capture time, so we can tell when that version was
  -- actually written by the client.
  content_updated_at timestamptz not null,
  archived_at timestamptz not null default now(),
  -- Best-effort client tag from current_setting('app.client', true).
  -- Clients aren't required to set it; null is acceptable.
  archived_by text
);

create index idx_note_content_history_note_id
  on public.note_content_history(note_id, archived_at desc);
create index idx_note_content_history_user_id
  on public.note_content_history(user_id);
create index idx_note_content_history_archived_at
  on public.note_content_history(archived_at);

-- =============================================================================
-- RLS
-- =============================================================================

alter table public.note_content_history enable row level security;

create policy "Users can read own note content history"
  on public.note_content_history for select
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
  );

-- No insert/update/delete policies. Writes happen exclusively via the
-- SECURITY DEFINER trigger below; cleanup happens via the SECURITY DEFINER
-- pg_cron job. Both bypass RLS by design.

-- =============================================================================
-- TRIGGER: archive prior content on update
-- =============================================================================

create or replace function public.archive_note_content()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
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
  return new;
end;
$$;

-- The IS DISTINCT FROM guard lives on the trigger so plain title /
-- is_trashed / notebook_id updates skip the SECURITY DEFINER call entirely.
create trigger on_notes_content_archive
  before update on public.notes
  for each row
  when (old.content is distinct from new.content)
  execute function public.archive_note_content();

-- =============================================================================
-- CLEANUP FUNCTION (30-day retention)
-- =============================================================================

create or replace function public.cleanup_note_content_history()
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  deleted_count integer;
begin
  delete from public.note_content_history
  where archived_at < now() - interval '30 days';

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- =============================================================================
-- SCHEDULE DAILY CRON JOB
-- =============================================================================

-- pg_cron is already enabled by 20260302000001_trash_auto_cleanup.sql, but
-- include the create-extension here so this migration is self-contained if
-- ever applied to a fresh project.
create extension if not exists pg_cron with schema pg_catalog;

-- Idempotent re-apply: drop the job if it already exists.
do $$
begin
  perform cron.unschedule('cleanup-note-content-history');
exception when others then
  null;
end;
$$;

-- Run daily at 03:15 UTC (15 min after the trash cleanup so they don't
-- start in the same instant).
select cron.schedule(
  'cleanup-note-content-history',
  '15 3 * * *',
  $$select public.cleanup_note_content_history()$$
);
