-- Activity days: usage_daily, its write path, its nightly rollup, and the
-- active-user and retention metrics (ADR 0077).
--
-- Weekly active users (users who opened Drafto on at least one day that week,
-- to read or to write) can't be read from the content tables: reading leaves
-- no trace there. So every client records the UTC days it was opened, one row
-- per user, day and client, and nothing else. Definitions, caveats and how to
-- run the metrics: docs/features/product-metrics.md. Why days instead of event
-- analytics: docs/adr/0077-activity-days-instead-of-event-analytics.md.
--
-- Ground rules:
--   - Days only. A row says that a user opened Drafto on a UTC day from one
--     kind of client; never which notes were opened or anything written.
--     content_changes is a count, filled in by the nightly rollup from
--     note_content_history and notes.created_at.
--   - client is one of the x-drafto-client tags (ADR 0023), the same list as
--     DRAFTO_CLIENT_TAGS in packages/shared/src/constants.ts. The list is
--     written out three times below, always in that order, and
--     packages/shared/__tests__/client-tags-drift.test.ts checks every copy.
--   - Clients write only through record_activity (SECURITY DEFINER, rows for
--     auth.uid() only). The MCP route authenticates by API key and queries as
--     service_role, where auth.uid() is null, so it upserts its own 'web-mcp'
--     row directly (apps/web/src/lib/api/record-mcp-activity.ts).
--   - The metrics follow the #820 rules (20261112000002_product_metrics.sql,
--     ADR 0075): SECURITY INVOKER, pinned search_path, service_role only, and
--     excluded accounts left out through metrics_excluded_user_ids().
--   - Rows are kept 13 months; deleting the account deletes them (on delete
--     cascade). Days and weeks are UTC; ISO weeks start on Monday.
--
-- The nightly pg_cron job lives in 20261113000002_usage_daily_cron.sql, so the
-- PGlite tests (scripts/__tests__/usage-daily.test.mjs) can run this file
-- verbatim.

-- =============================================================================
-- TABLE
-- =============================================================================

create table public.usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The UTC date the client was opened on.
  day date not null,
  -- The x-drafto-client tag of the client that was opened.
  client text not null,
  -- Content overwrites and new notes that day, set by rollup_usage_daily.
  content_changes int not null default 0,
  primary key (user_id, day, client),
  constraint usage_daily_client_check
    check (client in ('web', 'mobile-ios', 'mobile-android', 'desktop-macos', 'web-mcp'))
);

-- The metrics and the 13-month cleanup scan by day; the primary key leads with
-- user_id.
create index idx_usage_daily_day on public.usage_daily (day);

comment on table public.usage_daily is
  'Activity days: one row per user, UTC day and client tag the user opened Drafto on, with '
  'that day''s content changes (ADR 0077). Written by record_activity and the MCP route, '
  'kept 13 months. service_role only.';
comment on column public.usage_daily.day is 'UTC date the client was opened on.';
comment on column public.usage_daily.client is
  'x-drafto-client tag (ADR 0023), one of DRAFTO_CLIENT_TAGS in packages/shared.';
comment on column public.usage_daily.content_changes is
  'Content overwrites and new notes that day, set by the nightly rollup_usage_daily.';

-- No policies: clients write through record_activity (SECURITY DEFINER), and
-- only service_role, which bypasses RLS, reads or writes the table directly.
-- A signed-in user can't read the table, even their own rows.
alter table public.usage_daily enable row level security;

revoke all on table public.usage_daily from public, anon, authenticated;
grant select, insert, update, delete on table public.usage_daily to service_role;

-- =============================================================================
-- WRITE PATH
-- =============================================================================

-- Records that the signed-in user opened Drafto on p_days from client p_client.
-- A device sends every day it queued while offline, so: at most 31 days per
-- call; null elements, days after today (UTC), days more than 30 days back and
-- duplicates are dropped; a day already recorded is left alone. Returns how
-- many rows it added, so re-sending a day returns 0. SECURITY DEFINER because
-- authenticated has no privilege on the table; the rows are always the
-- caller's own (auth.uid()), whatever the arguments.
create or replace function public.record_activity(p_days date[], p_client text)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user uuid := auth.uid();
  v_today date := (now() at time zone 'UTC')::date;
  v_added int;
begin
  if v_user is null then
    raise exception 'record_activity needs a signed-in user'
      using errcode = '42501';
  end if;
  if p_client is null
    or not (p_client = any (array['web', 'mobile-ios', 'mobile-android', 'desktop-macos', 'web-mcp']))
  then
    raise exception 'unknown client tag: %', coalesce(p_client, 'null')
      using errcode = '22023';
  end if;
  if cardinality(p_days) > 31 then
    raise exception 'at most 31 days per call, got %', cardinality(p_days)
      using errcode = '22023';
  end if;
  if p_days is null or cardinality(p_days) = 0 then
    return 0;
  end if;

  insert into public.usage_daily (user_id, day, client)
  select distinct v_user, d.activity_day, p_client
  from unnest(p_days) as d(activity_day)
  where d.activity_day is not null
    and d.activity_day <= v_today
    and d.activity_day >= v_today - 30
  on conflict (user_id, day, client) do nothing;

  get diagnostics v_added = row_count;
  return v_added;
end;
$$;

comment on function public.record_activity(date[], text) is
  'Records the UTC days (at most 31, none in the future or more than 30 days back) the '
  'signed-in user opened Drafto from client p_client; returns the rows added (ADR 0077).';

revoke execute on function public.record_activity(date[], text) from public, anon, service_role;
grant execute on function public.record_activity(date[], text) to authenticated;

-- =============================================================================
-- NIGHTLY ROLLUP
-- =============================================================================

-- Fills content_changes for UTC day p_day (default: yesterday), run nightly by
-- pg_cron (20261113000002_usage_daily_cron.sql):
--   1. Every row of p_day goes back to 0, so a rerun sets the same numbers
--      instead of adding to them.
--   2. Content overwrites (note_content_history rows archived that day) tagged
--      with one of the five client tags count on that client's row. When that
--      client never pinged that day (an app version without the ping), the
--      row is created, for users that still exist.
--   3. Untagged work: overwrites with no tag or another tag (e.g. 'web-cron'),
--      plus notes created that day (inserts carry no tag). It is added to the
--      user's row for that day whose client comes first in the tag order web,
--      mobile-ios, mobile-android, desktop-macos, web-mcp, including a row
--      step 2 created. A user with no row that day has nowhere to put it, so
--      it is dropped.
--   4. Rows older than 13 months are deleted.
-- Returns how many of p_day's rows have content_changes > 0. Only p_day is
-- rolled up, and work is dated when the server receives it (archived_at and
-- created_at are server defaults; sync sends no created_at), so work done
-- offline counts on the day it syncs, never on an earlier day;
-- docs/features/product-metrics.md lists this and the other caveats.
-- SECURITY DEFINER because it writes every user's rows and pg_cron runs it.
create or replace function public.rollup_usage_daily(
  p_day date default ((now() at time zone 'UTC')::date - 1)
)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_tags constant text[] := array['web', 'mobile-ios', 'mobile-android', 'desktop-macos', 'web-mcp'];
  v_from timestamptz;
  v_to timestamptz;
  v_with_changes int;
begin
  if p_day is null then
    raise exception 'p_day must be a date, got null'
      using errcode = '22023';
  end if;
  v_from := p_day::timestamp at time zone 'UTC';
  v_to := (p_day + 1)::timestamp at time zone 'UTC';

  -- 1. Start from zero, so reruns converge.
  update public.usage_daily u
  set content_changes = 0
  where u.day = p_day
    and u.content_changes <> 0;

  -- 2. Tagged overwrites, per user and client.
  insert into public.usage_daily as u (user_id, day, client, content_changes)
  select h.user_id, p_day, h.archived_by, count(*)::int
  from public.note_content_history h
  where h.archived_at >= v_from
    and h.archived_at < v_to
    and h.archived_by = any (v_tags)
    and exists (select 1 from auth.users au where au.id = h.user_id)
  group by h.user_id, h.archived_by
  on conflict (user_id, day, client)
    do update set content_changes = excluded.content_changes;

  -- 3. Untagged work, on the user's first row of the day in tag order.
  with untagged as (
    select h.user_id, count(*)::int as n
    from public.note_content_history h
    where h.archived_at >= v_from
      and h.archived_at < v_to
      and (h.archived_by is null or not (h.archived_by = any (v_tags)))
    group by h.user_id
    union all
    select nt.user_id, count(*)::int
    from public.notes nt
    where nt.created_at >= v_from
      and nt.created_at < v_to
    group by nt.user_id
  ),
  per_user as (
    select t.user_id, sum(t.n)::int as n
    from untagged t
    group by t.user_id
  ),
  target as (
    select distinct on (r.user_id) r.user_id, r.client
    from public.usage_daily r
    where r.day = p_day
      and exists (select 1 from per_user pu where pu.user_id = r.user_id)
    order by r.user_id, array_position(v_tags, r.client)
  )
  update public.usage_daily u
  set content_changes = u.content_changes + pu.n
  from target t
  join per_user pu on pu.user_id = t.user_id
  where u.user_id = t.user_id
    and u.day = p_day
    and u.client = t.client;

  -- 4. Retention: 13 months.
  delete from public.usage_daily
  where day < ((now() at time zone 'UTC')::date - interval '13 months')::date;

  select count(*)::int into v_with_changes
  from public.usage_daily u
  where u.day = p_day
    and u.content_changes > 0;
  return v_with_changes;
end;
$$;

comment on function public.rollup_usage_daily(date) is
  'Sets usage_daily.content_changes for UTC day p_day (default yesterday) from '
  'note_content_history and new notes, then deletes rows older than 13 months; idempotent. '
  'Run nightly by pg_cron (ADR 0077).';

revoke execute on function public.rollup_usage_daily(date) from public, anon, authenticated;
grant execute on function public.rollup_usage_daily(date) to service_role;

-- =============================================================================
-- ACTIVATION, PER USER
-- =============================================================================

-- One row per user who signed up in the last p_weeks ISO weeks, excluded users
-- left out, with #820's activation flags (20261112000002_product_metrics.sql):
-- first_value when a note version of 50+ characters was saved within 14 days
-- of sign-up, activated when such versions were saved on 2+ distinct UTC days
-- in that window. A version is each overwritten one in note_content_history
-- (saved at content_updated_at) plus each note's current content (saved at
-- updated_at). The body is the one metrics_activation had; metrics_activation
-- now aggregates this, and metrics_retention reads it, so activation is
-- defined in one place. The flags carry none of the cohort-level nulls (the
-- 30-day history limit): metrics_activation applies those.
create or replace function public.metrics_cohort_activation(p_weeks int)
returns table (
  user_id uuid,
  week_start date,
  signed_up_at timestamptz,
  first_value boolean,
  activated boolean
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with weeks as (
    select w.week_start from public.metrics_week_starts(p_weeks) w
  ),
  excluded as materialized (
    select x.user_id from public.metrics_excluded_user_ids() x
  ),
  cohort as (
    select
      u.id as user_id,
      u.created_at as signed_up_at,
      date_trunc('week', u.created_at at time zone 'UTC')::date as week_start
    from auth.users u
    where u.created_at >= (select min(w.week_start) from weeks w)::timestamp at time zone 'UTC'
      and not exists (select 1 from excluded x where x.user_id = u.id)
  ),
  versions as (
    select c.user_id, h.content_updated_at as saved_at, h.content
    from cohort c
    join public.note_content_history h on h.user_id = c.user_id
    where h.content_updated_at >= c.signed_up_at
      and h.content_updated_at <= c.signed_up_at + interval '14 days'
    union all
    select c.user_id, n.updated_at, n.content
    from cohort c
    join public.notes n on n.user_id = c.user_id
    where n.updated_at >= c.signed_up_at
      and n.updated_at <= c.signed_up_at + interval '14 days'
  ),
  qualifying as (
    select v.user_id, count(distinct (v.saved_at at time zone 'UTC')::date)::int as days
    from versions v
    where public.note_text_chars(v.content) >= 50
    group by v.user_id
  )
  select
    c.user_id,
    c.week_start,
    c.signed_up_at,
    q.user_id is not null,
    coalesce(q.days >= 2, false)
  from cohort c
  left join qualifying q on q.user_id = c.user_id
  order by c.week_start, c.signed_up_at, c.user_id
$$;

comment on function public.metrics_cohort_activation(int) is
  'Per user signed up in the last p_weeks ISO weeks: sign-up week and time, first value and '
  'activated (50+ character versions on 2+ UTC days within 14 days of sign-up) (ADR 0077).';

revoke execute on function public.metrics_cohort_activation(int) from public, anon, authenticated;
grant execute on function public.metrics_cohort_activation(int) to service_role;

-- metrics_activation, re-created as an aggregate over metrics_cohort_activation
-- with the same columns and results as 20261112000002_product_metrics.sql.
-- Per sign-up-week cohort: how many signed up, reached first value and
-- activated. `activated` is null once the cohort's last 14-day window (week
-- start + 21 days) ended more than 30 days ago: the history is kept 30 days,
-- so a count would be short. window_complete is false while that window is
-- still open.
create or replace function public.metrics_activation(p_weeks int)
returns table (
  week_start date,
  iso_week text,
  signed_up int,
  first_value int,
  activated int,
  window_complete boolean
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select
    w.week_start,
    to_char(w.week_start, 'IYYY-"W"IW'),
    count(c.user_id)::int,
    (count(c.user_id) filter (where c.first_value))::int,
    case
      when (w.week_start::timestamp at time zone 'UTC') + interval '21 days'
        < now() - interval '30 days' then null
      else (count(c.user_id) filter (where c.activated))::int
    end,
    (w.week_start::timestamp at time zone 'UTC') + interval '21 days' <= now()
  from public.metrics_week_starts(p_weeks) w
  left join public.metrics_cohort_activation(p_weeks) c on c.week_start = w.week_start
  group by w.week_start
  order by w.week_start
$$;

comment on function public.metrics_activation(int) is
  'Per sign-up-week cohort: signed up, first value and activated (50+ character versions '
  'on 2+ UTC days within 14 days of sign-up) (ADR 0075).';

revoke execute on function public.metrics_activation(int) from public, anon, authenticated;
grant execute on function public.metrics_activation(int) to service_role;

-- =============================================================================
-- METRICS
-- =============================================================================

-- Per ISO week: active users (distinct users with a usage_daily row that
-- week), writers among them (a row with content_changes > 0 that week), and
-- active users per client. A user active on two clients counts once in
-- active_users and once under each client. week_complete is false until the
-- week has ended (UTC).
create or replace function public.metrics_active_users(p_weeks int)
returns table (
  week_start date,
  iso_week text,
  active_users int,
  writers int,
  by_client jsonb,
  week_complete boolean
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with weeks as (
    select w.week_start from public.metrics_week_starts(p_weeks) w
  ),
  excluded as materialized (
    select x.user_id from public.metrics_excluded_user_ids() x
  ),
  activity as (
    select
      date_trunc('week', u.day::timestamp)::date as week_start,
      u.user_id,
      u.client,
      u.content_changes
    from public.usage_daily u
    where u.day >= (select min(w.week_start) from weeks w)
      and u.day < (select max(w.week_start) from weeks w) + 7
      and not exists (select 1 from excluded x where x.user_id = u.user_id)
  ),
  per_week as (
    select
      a.week_start,
      count(distinct a.user_id)::int as active_users,
      (count(distinct a.user_id) filter (where a.content_changes > 0))::int as writers
    from activity a
    group by a.week_start
  ),
  per_client as (
    select pc.week_start, jsonb_object_agg(pc.client, pc.n) as by_client
    from (
      select a.week_start, a.client, count(distinct a.user_id)::int as n
      from activity a
      group by a.week_start, a.client
    ) pc
    group by pc.week_start
  )
  select
    w.week_start,
    to_char(w.week_start, 'IYYY-"W"IW'),
    coalesce(pw.active_users, 0),
    coalesce(pw.writers, 0),
    coalesce(pc.by_client, '{}'::jsonb),
    w.week_start + 7 <= (now() at time zone 'UTC')::date
  from weeks w
  left join per_week pw on pw.week_start = w.week_start
  left join per_client pc on pc.week_start = w.week_start
  order by w.week_start
$$;

comment on function public.metrics_active_users(int) is
  'Weekly active users per ISO week (UTC) from usage_daily: active users, writers among them '
  'and active users per client (ADR 0077).';

revoke execute on function public.metrics_active_users(int) from public, anon, authenticated;
grant execute on function public.metrics_active_users(int) to service_role;

-- Per sign-up-week cohort: its activated users (metrics_activation's
-- `activated`) and how many of them were active again (any usage_daily row)
-- in week 1 (days 7-13 after the UTC day they signed up) and in week 4 (days
-- 28-34), with the percentage of `activated`, rounded to one decimal.
-- active_weekN is null when activated is null, while the window is still
-- open for someone in the cohort (week 1: until week start + 20 days; week 4:
-- until week start + 41 days), and when the window started before tracking
-- did (its earliest start, week start + 7 or + 28 days, is before the oldest
-- usage_daily row, or there is none). pct_weekN is also null when activated
-- is 0.
create or replace function public.metrics_retention(p_weeks int)
returns table (
  week_start date,
  iso_week text,
  activated int,
  active_week1 int,
  pct_week1 numeric,
  active_week4 int,
  pct_week4 numeric
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with cohorts as (
    select a.week_start, a.iso_week, a.activated
    from public.metrics_activation(p_weeks) a
  ),
  activated_users as (
    select c.user_id, c.week_start, (c.signed_up_at at time zone 'UTC')::date as signup_day
    from public.metrics_cohort_activation(p_weeks) c
    where c.activated
  ),
  returned as (
    select
      au.week_start,
      (count(*) filter (
        where exists (
          select 1 from public.usage_daily u
          where u.user_id = au.user_id
            and u.day between au.signup_day + 7 and au.signup_day + 13
        )
      ))::int as week1,
      (count(*) filter (
        where exists (
          select 1 from public.usage_daily u
          where u.user_id = au.user_id
            and u.day between au.signup_day + 28 and au.signup_day + 34
        )
      ))::int as week4
    from activated_users au
    group by au.week_start
  ),
  tracking as (
    select min(u.day) as first_day, (now() at time zone 'UTC')::date as today
    from public.usage_daily u
  ),
  counted as (
    select
      co.week_start,
      co.iso_week,
      co.activated,
      case
        when co.activated is null
          or t.first_day is null
          or t.today < co.week_start + 20
          or co.week_start + 7 < t.first_day
          then null
        else coalesce(r.week1, 0)
      end as active_week1,
      case
        when co.activated is null
          or t.first_day is null
          or t.today < co.week_start + 41
          or co.week_start + 28 < t.first_day
          then null
        else coalesce(r.week4, 0)
      end as active_week4
    from cohorts co
    cross join tracking t
    left join returned r on r.week_start = co.week_start
  )
  select
    ct.week_start,
    ct.iso_week,
    ct.activated,
    ct.active_week1,
    round(100.0 * ct.active_week1 / nullif(ct.activated, 0), 1),
    ct.active_week4,
    round(100.0 * ct.active_week4 / nullif(ct.activated, 0), 1)
  from counted ct
  order by ct.week_start
$$;

comment on function public.metrics_retention(int) is
  'Per sign-up-week cohort: activated users and the share active again in week 1 (days 7-13) '
  'and week 4 (days 28-34) after sign-up, from usage_daily (ADR 0077).';

revoke execute on function public.metrics_retention(int) from public, anon, authenticated;
grant execute on function public.metrics_retention(int) to service_role;
