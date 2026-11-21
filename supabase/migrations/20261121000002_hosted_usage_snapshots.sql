-- Hosting usage the database can't measure: Vercel's and Supabase's own usage
-- figures, read from their dashboards once a week by the Mac mini's read-only
-- usage readout (ADR 0093) and posted to /api/cron/hosted-usage, which inserts
-- them here as the service role.
--
-- Why a readout: on the plans in use neither provider has an API for these
-- figures. Vercel Hobby answers its billing API with 404, and Supabase's
-- Management API has no egress figure (docs/features/product-metrics.md,
-- "Hosting usage").
--
-- Ground rules:
--   - Account-level aggregates only: no user, note or request data.
--   - Each reading is stored in the unit its dashboard shows (GB, a count or
--     CPU-hours), and each limit is in the same unit, so the percentage doesn't
--     depend on decimal vs binary gigabytes.
--   - The limits are constants in metrics_hosted_usage(), as in
--     metrics_platform_limits() (20261112000002_product_metrics.sql), with the
--     same levels: ok below 70%, warn from 70%, critical from 85%.
--   - service_role only (ADR 0075): RLS on with no policies, and no grants to
--     anon or authenticated.

-- =============================================================================
-- TABLE
-- =============================================================================

create table public.hosted_usage_snapshots (
  id uuid primary key default gen_random_uuid(),
  -- When the readout read the dashboards (the route's insert time).
  captured_at timestamptz not null default now(),
  -- One of the resources metrics_hosted_usage() knows; its unit and limit
  -- live there.
  resource text not null check (
    resource in (
      'vercel_fast_data_transfer',
      'vercel_cdn_requests',
      'vercel_function_invocations',
      'vercel_active_cpu',
      'supabase_egress',
      'supabase_cached_egress'
    )
  ),
  used numeric not null check (used >= 0),
  -- The usage window the dashboard showed, when it named one (Vercel: the last
  -- 30 days; Supabase: the billing cycle).
  period_from date,
  period_to date,
  check (period_from is null or period_to is null or period_from <= period_to)
);

comment on table public.hosted_usage_snapshots is
  'Weekly readings of Vercel and Supabase usage from their dashboards (ADR 0093); '
  'service_role only.';

create index hosted_usage_snapshots_resource_captured_idx
  on public.hosted_usage_snapshots (resource, captured_at desc);

alter table public.hosted_usage_snapshots enable row level security;

revoke all on table public.hosted_usage_snapshots from public, anon, authenticated;
grant select, insert on table public.hosted_usage_snapshots to service_role;

-- =============================================================================
-- METRIC
-- =============================================================================

-- The newest reading of each resource, against its plan limit, with the
-- percentage used (rounded to 0.1), a level and whether the reading is stale
-- (more than 8 days old: the readout runs weekly). A resource never read has
-- no row.
create or replace function public.metrics_hosted_usage()
returns table (
  provider text,
  resource text,
  unit text,
  used numeric,
  limit_value numeric,
  pct numeric,
  level text,
  period_from date,
  period_to date,
  captured_at timestamptz,
  stale boolean
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  -- Limits: Vercel Hobby, https://vercel.com/docs/plans/hobby, and Supabase
  -- Free, https://supabase.com/pricing (as of Nov 2026).
  with limits (provider, resource, unit, limit_value, sort) as (
    values
      ('vercel', 'vercel_fast_data_transfer', 'GB', 100::numeric, 1),
      ('vercel', 'vercel_cdn_requests', 'count', 1000000::numeric, 2),
      ('vercel', 'vercel_function_invocations', 'count', 1000000::numeric, 3),
      ('vercel', 'vercel_active_cpu', 'hours', 4::numeric, 4),
      ('supabase', 'supabase_egress', 'GB', 5::numeric, 5),
      ('supabase', 'supabase_cached_egress', 'GB', 5::numeric, 6)
  ),
  latest as (
    select distinct on (s.resource)
      s.resource, s.used, s.period_from, s.period_to, s.captured_at
    from public.hosted_usage_snapshots s
    order by s.resource, s.captured_at desc, s.id
  ),
  measured as (
    select
      l.provider, l.resource, l.unit, s.used, l.limit_value,
      100.0 * s.used / l.limit_value as pct,
      s.period_from, s.period_to, s.captured_at, l.sort
    from latest s
    join limits l on l.resource = s.resource
  )
  select
    m.provider,
    m.resource,
    m.unit,
    m.used,
    m.limit_value,
    round(m.pct, 1),
    case
      when m.pct >= 85 then 'critical'
      when m.pct >= 70 then 'warn'
      else 'ok'
    end,
    m.period_from,
    m.period_to,
    m.captured_at,
    m.captured_at < now() - interval '8 days'
  from measured m
  order by m.sort
$$;

comment on function public.metrics_hosted_usage() is
  'The newest Vercel and Supabase usage reading per resource against its plan limit, with '
  'levels and staleness (ADR 0093).';

revoke execute on function public.metrics_hosted_usage() from public, anon, authenticated;
grant execute on function public.metrics_hosted_usage() to service_role;
