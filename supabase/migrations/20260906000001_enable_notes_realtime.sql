-- Enable Supabase Realtime (postgres_changes) for public.notes so the web app can
-- detect edits made from mobile, desktop, or another browser tab while a note is open.
--
-- Both steps are guarded. `alter publication ... add table` raises SQLSTATE 42710
-- ("relation is already member of publication") on a second run, which would break
-- migration replay and shadow-database diffing.

-- The supabase_realtime publication ships with the Supabase platform image, but a
-- bare Postgres (shadow DB, migration replay elsewhere) has no such publication.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

-- pg_publication_tables (rather than pg_publication_rel) is used deliberately so a
-- FOR ALL TABLES publication also short-circuits correctly.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notes'
  ) then
    alter publication supabase_realtime add table public.notes;
  end if;
end
$$;

-- Deliberately NOT `alter table public.notes replica identity full`.
--
-- notes.content is jsonb that TOASTs past ~2 KB, and REPLICA IDENTITY FULL logs the
-- entire old row into the WAL on every UPDATE -- i.e. on every autosave -- which is a
-- large, permanent write-amplification cost on a free-tier Postgres. It also buys
-- nothing here: `id` is the primary key and therefore already the default replica
-- identity, so a `filter: id=eq.<uuid>` subscription still matches DELETE events, and
-- RLS causes the DELETE old_record to be reduced to the primary key regardless.
