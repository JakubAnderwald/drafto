-- Product metrics as service-role SQL functions (ADR 0075).
--
-- Every number Drafto reports about its own use is computed here, once, and
-- read by `pnpm users:stats` (scripts/user-stats.mjs) today and by the admin
-- stats page and the weekly email later. Definitions, caveats and how to run
-- them: docs/features/product-metrics.md.
--
-- Ground rules:
--   - Metadata only. The functions read timestamps, character counts
--     (note_text_chars, 20261112000001) and client tags; none returns note
--     text, titles or notebook names.
--   - Writes (metrics_write_events, behind writers and depth) are counted
--     from note_content_history (one row per content overwrite, tagged with
--     the writing client, ADR 0023), never from notes.updated_at, which also
--     moves on title, trash and notebook changes. Activation, by its
--     definition, dates note versions by updated_at / content_updated_at.
--   - Admins (profiles.is_admin) and the users in metrics_excluded_users are
--     left out of every per-user metric, through metrics_excluded_user_ids().
--   - All functions are SECURITY INVOKER with a pinned search_path, and only
--     service_role may execute them. service_role bypasses RLS, so they see
--     every user's rows; nothing here needs SECURITY DEFINER.
--   - ISO weeks start on Monday 00:00 UTC; dates are UTC dates.

-- =============================================================================
-- EXCLUDED ACCOUNTS
-- =============================================================================

create table public.metrics_excluded_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reason text
);

comment on table public.metrics_excluded_users is
  'Accounts left out of the product metrics, on top of admins (ADR 0075). '
  'service_role only.';

-- No policies: only service_role, which bypasses RLS, reads or writes it.
alter table public.metrics_excluded_users enable row level security;

revoke all on table public.metrics_excluded_users from public, anon, authenticated;
grant select, insert, update, delete on table public.metrics_excluded_users to service_role;

-- The shared test and store-review accounts, by email, in whichever project
-- has them. An address with no account is skipped.
insert into public.metrics_excluded_users (user_id, reason)
select u.id, t.reason
from (
  values
    ('e2e-test@drafto.eu', 'test account: web and native E2E runs'),
    ('googleplay-test@drafto.eu', 'test account: Google Play review'),
    ('appreview@drafto.eu', 'test account: App Store review')
) as t(email, reason)
join auth.users u on lower(u.email) = t.email
on conflict (user_id) do nothing;

-- =============================================================================
-- auth.users: the three columns the sign-up metrics read
-- =============================================================================
-- metrics_signups and metrics_activation read auth.users as service_role, since
-- they are SECURITY INVOKER. Grant just those columns (a no-op where
-- service_role already reads the table). If this role can't grant on
-- auth.users, warn instead of failing the migration: those two functions then
-- fail with permission denied, and `pnpm test:live:supabase -- --only metrics`
-- reports it.
do $$
begin
  begin
    grant select (id, created_at, raw_app_meta_data) on auth.users to service_role;
  exception when insufficient_privilege then
    null;
  end;
  if not (
    has_schema_privilege('service_role', 'auth', 'usage')
    and has_column_privilege('service_role', 'auth.users', 'id', 'select')
    and has_column_privilege('service_role', 'auth.users', 'created_at', 'select')
    and has_column_privilege('service_role', 'auth.users', 'raw_app_meta_data', 'select')
  ) then
    raise warning 'product metrics: service_role cannot read auth.users (id, created_at, '
      'raw_app_meta_data), so metrics_signups and metrics_activation will fail with '
      'permission denied. See docs/features/product-metrics.md.';
  end if;
end;
$$;

-- =============================================================================
-- HELPERS
-- =============================================================================

-- The one exclusion rule: admins plus metrics_excluded_users.
create or replace function public.metrics_excluded_user_ids()
returns table (user_id uuid)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select p.id from public.profiles p where p.is_admin
  union
  select e.user_id from public.metrics_excluded_users e
$$;

comment on function public.metrics_excluded_user_ids() is
  'Users every product metric leaves out: admins and metrics_excluded_users (ADR 0075).';

revoke execute on function public.metrics_excluded_user_ids() from public, anon, authenticated;
grant execute on function public.metrics_excluded_user_ids() to service_role;

-- The Mondays (UTC) of the last p_weeks ISO weeks, oldest first, ending with
-- the current week.
create or replace function public.metrics_week_starts(p_weeks int)
returns table (week_start date)
language plpgsql
stable
security invoker
set search_path = public, pg_catalog
as $$
begin
  if p_weeks is null or p_weeks < 1 or p_weeks > 520 then
    raise exception 'p_weeks must be between 1 and 520, got %', coalesce(p_weeks::text, 'null')
      using errcode = '22023';
  end if;
  return query
    select (date_trunc('week', now() at time zone 'UTC') - make_interval(weeks => g.n))::date
    from generate_series(p_weeks - 1, 0, -1) as g(n);
end;
$$;

comment on function public.metrics_week_starts(int) is
  'Mondays (UTC) of the last p_weeks ISO weeks, oldest first (ADR 0075).';

revoke execute on function public.metrics_week_starts(int) from public, anon, authenticated;
grant execute on function public.metrics_week_starts(int) to service_role;

-- What counts as a write, in [p_from, p_to), excluded users left out:
--   - a content overwrite: a note_content_history row, at its archived_at, by
--     its archived_by client ('untagged' when the request carried no tag);
--   - a new note whose first version holds 50 or more characters, at its
--     created_at. Inserts carry no client tag, so these are 'untagged'. The
--     first version is the note's oldest history row, or its current content
--     when it was never overwritten.
create or replace function public.metrics_write_events(p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, written_at timestamptz, client text)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with excluded as materialized (
    select x.user_id from public.metrics_excluded_user_ids() x
  )
  select h.user_id, h.archived_at, coalesce(h.archived_by, 'untagged')
  from public.note_content_history h
  where h.archived_at >= p_from
    and h.archived_at < p_to
    and not exists (select 1 from excluded x where x.user_id = h.user_id)
  union all
  select n.user_id, n.created_at, 'untagged'
  from public.notes n
  left join lateral (
    select h.id, h.content
    from public.note_content_history h
    where h.note_id = n.id
    order by h.archived_at, h.content_updated_at, h.id
    limit 1
  ) first_version on true
  where n.created_at >= p_from
    and n.created_at < p_to
    and not exists (select 1 from excluded x where x.user_id = n.user_id)
    and public.note_text_chars(
      case when first_version.id is null then n.content else first_version.content end
    ) >= 50
$$;

comment on function public.metrics_write_events(timestamptz, timestamptz) is
  'Content overwrites and new notes of 50+ characters in [p_from, p_to), by user and '
  'client tag, excluded users left out (ADR 0075).';

revoke execute on function public.metrics_write_events(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.metrics_write_events(timestamptz, timestamptz) to service_role;

-- =============================================================================
-- METRICS
-- =============================================================================

-- New accounts per ISO week, split by auth provider (app_metadata.provider:
-- 'email', 'google', 'apple', ...; 'unknown' when it is missing).
create or replace function public.metrics_signups(p_weeks int)
returns table (week_start date, iso_week text, signups int, by_provider jsonb)
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
  per_provider as (
    select
      date_trunc('week', u.created_at at time zone 'UTC')::date as week_start,
      coalesce(nullif(u.raw_app_meta_data ->> 'provider', ''), 'unknown') as provider,
      count(*)::int as n
    from auth.users u
    where u.created_at >= (select min(w.week_start) from weeks w)::timestamp at time zone 'UTC'
      and not exists (select 1 from excluded x where x.user_id = u.id)
    group by 1, 2
  )
  select
    w.week_start,
    to_char(w.week_start, 'IYYY-"W"IW'),
    coalesce(sum(p.n), 0)::int,
    coalesce(jsonb_object_agg(p.provider, p.n) filter (where p.provider is not null), '{}'::jsonb)
  from weeks w
  left join per_provider p on p.week_start = w.week_start
  group by w.week_start
  order by w.week_start
$$;

comment on function public.metrics_signups(int) is
  'New accounts per ISO week (UTC) for the last p_weeks weeks, split by auth provider (ADR 0075).';

revoke execute on function public.metrics_signups(int) from public, anon, authenticated;
grant execute on function public.metrics_signups(int) to service_role;

-- Per sign-up-week cohort: how many signed up, how many reached first value (a
-- note version of 50+ characters saved within 14 days of sign-up) and how many
-- activated (such versions saved on 2+ distinct UTC days within those 14 days).
-- A version is each overwritten one in note_content_history (saved at
-- content_updated_at) plus each note's current content (saved at updated_at).
-- `activated` is null once the cohort's last 14-day window (week start + 21
-- days) ended more than 30 days ago: the history is kept 30 days, so a count
-- would be short. window_complete is false while that window is still open.
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
    w.week_start,
    to_char(w.week_start, 'IYYY-"W"IW'),
    count(c.user_id)::int,
    count(q.user_id)::int,
    case
      when (w.week_start::timestamp at time zone 'UTC') + interval '21 days'
        < now() - interval '30 days' then null
      else (count(q.user_id) filter (where q.days >= 2))::int
    end,
    (w.week_start::timestamp at time zone 'UTC') + interval '21 days' <= now()
  from weeks w
  left join cohort c on c.week_start = w.week_start
  left join qualifying q on q.user_id = c.user_id
  group by w.week_start
  order by w.week_start
$$;

comment on function public.metrics_activation(int) is
  'Per sign-up-week cohort: signed up, first value and activated (50+ character versions '
  'on 2+ UTC days within 14 days of sign-up) (ADR 0075).';

revoke execute on function public.metrics_activation(int) from public, anon, authenticated;
grant execute on function public.metrics_activation(int) to service_role;

-- Per ISO week: distinct users with a write (metrics_write_events), and the
-- same count per client tag. A user who wrote from two clients counts once in
-- `writers` and once under each client. history_complete is false for weeks
-- that started more than 30 days ago, whose overwrites the retention job has
-- partly deleted.
create or replace function public.metrics_writers(p_weeks int)
returns table (
  week_start date,
  iso_week text,
  writers int,
  by_client jsonb,
  history_complete boolean
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with weeks as (
    select w.week_start from public.metrics_week_starts(p_weeks) w
  ),
  events as (
    select date_trunc('week', e.written_at at time zone 'UTC')::date as week_start, e.user_id, e.client
    from public.metrics_write_events(
      (select min(w.week_start) from weeks w)::timestamp at time zone 'UTC',
      ((select max(w.week_start) from weeks w) + 7)::timestamp at time zone 'UTC'
    ) e
  ),
  per_week as (
    select ev.week_start, count(distinct ev.user_id)::int as n
    from events ev
    group by ev.week_start
  ),
  per_client as (
    select ev.week_start, jsonb_object_agg(ev.client, ev.n) as by_client
    from (
      select e.week_start, e.client, count(distinct e.user_id)::int as n
      from events e
      group by e.week_start, e.client
    ) ev
    group by ev.week_start
  )
  select
    w.week_start,
    to_char(w.week_start, 'IYYY-"W"IW'),
    coalesce(pw.n, 0),
    coalesce(pc.by_client, '{}'::jsonb),
    (w.week_start::timestamp at time zone 'UTC') >= now() - interval '30 days'
  from weeks w
  left join per_week pw on pw.week_start = w.week_start
  left join per_client pc on pc.week_start = w.week_start
  order by w.week_start
$$;

comment on function public.metrics_writers(int) is
  'Distinct writers per ISO week (UTC), overall and per client tag (ADR 0075).';

revoke execute on function public.metrics_writers(int) from public, anon, authenticated;
grant execute on function public.metrics_writers(int) to service_role;

-- The silent-emptying detector: live (untrashed) notes whose text is empty now,
-- and whose last version with any text (their newest history row with text)
-- held 200+ characters. The save that replaced that version, at its
-- archived_at and by its archived_by client, is the one that emptied the note;
-- every version since has had no text. Reported once that save is at least 24
-- hours old at p_as_of, and when it happened at or after p_since. p_as_of is
-- for tests, which can't backdate a save; leave it out to use now(). The
-- note's state is always read as of now: refilled or trashed means not listed.
create or replace function public.metrics_emptied_notes(
  p_since timestamptz,
  p_as_of timestamptz default now()
)
returns table (note_id uuid, user_id uuid, emptied_at timestamptz, client text, chars_before int)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with excluded as materialized (
    select x.user_id from public.metrics_excluded_user_ids() x
  ),
  empty_notes as (
    select n.id, n.user_id
    from public.notes n
    where not n.is_trashed
      and public.note_text_chars(n.content) = 0
      and not exists (select 1 from excluded x where x.user_id = n.user_id)
  ),
  history as (
    select
      h.note_id,
      h.archived_at,
      h.archived_by,
      h.content_updated_at,
      h.id,
      public.note_text_chars(h.content) as chars
    from public.note_content_history h
    join empty_notes e on e.id = h.note_id
  ),
  last_with_text as (
    select distinct on (h.note_id) h.note_id, h.archived_at, h.archived_by, h.chars
    from history h
    where h.chars > 0
    order by h.note_id, h.archived_at desc, h.content_updated_at desc, h.id desc
  )
  select e.id, e.user_id, l.archived_at, coalesce(l.archived_by, 'untagged'), l.chars
  from empty_notes e
  join last_with_text l on l.note_id = e.id
  where l.chars >= 200
    and l.archived_at >= p_since
    and l.archived_at <= p_as_of - interval '24 hours'
  order by l.archived_at, e.id
$$;

comment on function public.metrics_emptied_notes(timestamptz, timestamptz) is
  'Untrashed notes a single save took from 200+ characters to none, still empty 24h later '
  '(ADR 0075).';

revoke execute on function public.metrics_emptied_notes(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.metrics_emptied_notes(timestamptz, timestamptz) to service_role;

-- One row about the users who wrote in the last 30 days (metrics_write_events):
-- the median and maximum of their live (untrashed) notes, notebooks and
-- attachment MB (attachments.file_size, MB = 1024 * 1024 bytes), and the
-- percentage of them with any attachment, with an unrevoked API key, with an
-- MCP write (a 'web-mcp' overwrite) and with overwrites from 2+ tagged clients.
create or replace function public.metrics_depth()
returns table (
  writers int,
  live_notes_median numeric,
  live_notes_max int,
  notebooks_median numeric,
  notebooks_max int,
  attachment_mb_median numeric,
  attachment_mb_max numeric,
  pct_with_attachment numeric,
  pct_with_api_key numeric,
  pct_with_mcp_write numeric,
  pct_multi_client numeric
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with writers as (
    select
      e.user_id,
      count(distinct e.client) filter (where e.client <> 'untagged') as tagged_clients,
      bool_or(e.client = 'web-mcp') as mcp_write
    from public.metrics_write_events(now() - interval '30 days', 'infinity'::timestamptz) e
    group by e.user_id
  ),
  per_user as (
    select
      w.user_id,
      w.tagged_clients,
      w.mcp_write,
      (select count(*) from public.notes n where n.user_id = w.user_id and not n.is_trashed)::int
        as live_notes,
      (select count(*) from public.notebooks b where b.user_id = w.user_id)::int as notebooks,
      (select coalesce(sum(a.file_size), 0) from public.attachments a where a.user_id = w.user_id)
        / 1048576.0 as attachment_mb,
      exists (select 1 from public.attachments a where a.user_id = w.user_id) as has_attachment,
      exists (
        select 1 from public.api_keys k where k.user_id = w.user_id and k.revoked_at is null
      ) as has_api_key
    from writers w
  )
  select
    count(*)::int,
    round((percentile_cont(0.5) within group (order by p.live_notes))::numeric, 1),
    max(p.live_notes),
    round((percentile_cont(0.5) within group (order by p.notebooks))::numeric, 1),
    max(p.notebooks),
    round((percentile_cont(0.5) within group (order by p.attachment_mb))::numeric, 2),
    round(max(p.attachment_mb), 2),
    round(100.0 * count(*) filter (where p.has_attachment) / nullif(count(*), 0), 1),
    round(100.0 * count(*) filter (where p.has_api_key) / nullif(count(*), 0), 1),
    round(100.0 * count(*) filter (where p.mcp_write) / nullif(count(*), 0), 1),
    round(100.0 * count(*) filter (where p.tagged_clients >= 2) / nullif(count(*), 0), 1)
  from per_user p
$$;

comment on function public.metrics_depth() is
  'Usage depth of the last 30 days'' writers: notes, notebooks, attachment MB, attachment / '
  'API key / MCP / multi-client shares (ADR 0075).';

revoke execute on function public.metrics_depth() from public, anon, authenticated;
grant execute on function public.metrics_depth() to service_role;

-- The project's Free-plan quotas: database size against 500 MB and the
-- attachments bucket against 1 GB of file storage, with the percentage used
-- and a level: ok below 70%, warn from 70%, critical from 85%. Project-wide,
-- so no account is excluded. MB and GB are binary (1024-based). Objects
-- without a numeric metadata.size count as 0.
create or replace function public.metrics_platform_limits()
returns table (resource text, used_bytes bigint, limit_bytes bigint, pct numeric, level text)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  -- Limits: Supabase Free plan, https://supabase.com/pricing
  -- (500 MB database size, 1 GB file storage per project).
  with usage as (
    select
      'database'::text as resource,
      pg_database_size(current_database())::bigint as used_bytes,
      (500::bigint * 1024 * 1024) as limit_bytes
    union all
    select
      'storage',
      coalesce(
        sum(
          case
            when o.metadata ->> 'size' ~ '^[0-9]+$' then (o.metadata ->> 'size')::bigint
            else 0
          end
        ),
        0
      )::bigint,
      (1024::bigint * 1024 * 1024)
    from storage.objects o
    where o.bucket_id = 'attachments'
  ),
  measured as (
    select u.resource, u.used_bytes, u.limit_bytes, 100.0 * u.used_bytes / u.limit_bytes as pct
    from usage u
  )
  select
    m.resource,
    m.used_bytes,
    m.limit_bytes,
    round(m.pct, 1),
    case
      when m.pct >= 85 then 'critical'
      when m.pct >= 70 then 'warn'
      else 'ok'
    end
  from measured m
  order by m.resource
$$;

comment on function public.metrics_platform_limits() is
  'Database size and attachment storage against the Supabase Free plan quotas, with levels '
  '(ADR 0075).';

revoke execute on function public.metrics_platform_limits() from public, anon, authenticated;
grant execute on function public.metrics_platform_limits() to service_role;
