-- Nightly rollup of usage_daily (ADR 0078): at 00:30 UTC, fill yesterday's
-- content_changes and delete rows older than 13 months, through
-- public.rollup_usage_daily() (20261113000003_usage_daily.sql). Thirty minutes
-- after midnight leaves room for the day's last saves to commit, and runs well
-- before the 03:15 history cleanup, which only deletes rows older than 30
-- days anyway.
--
-- A file of its own so the PGlite tests, which have no pg_cron, can run the
-- main migration verbatim. Mirrors 20260302000001_trash_auto_cleanup.sql and
-- 20260425000001_note_content_history.sql.

-- pg_cron is already enabled by 20260302000001_trash_auto_cleanup.sql; the
-- create-extension keeps this migration self-contained on a fresh project.
create extension if not exists pg_cron with schema pg_catalog;

-- Idempotent re-apply: drop the job if it already exists.
do $$
begin
  perform cron.unschedule('rollup-usage-daily');
exception when others then
  null; -- No such job yet.
end;
$$;

select cron.schedule(
  'rollup-usage-daily',
  '30 0 * * *',
  $$select public.rollup_usage_daily()$$
);
