-- Supabase log ingestion joins the weekly hosting-usage readout (ADR 0093).
--
-- The Supabase org Usage page shows "Log Ingestion": the log data Supabase
-- ingests across all of the org's projects in the billing cycle, against 1 GB
-- on the Free plan. In November 2026 it stood at 1.02 GB (102%). Supabase says
-- billing for it starts after a grace period that ends in early 2027, so it is
-- tracked now, before it can cost anything.
--
-- What changes (everything else is as in 20261121000002_hosted_usage_snapshots.sql):
--   - hosted_usage_snapshots accepts the new resource, supabase_log_ingestion.
--   - metrics_hosted_usage() knows its limit: 1 GB, in the unit the dashboard
--     shows, sorted after cached egress.
-- The route's resource list (apps/web/src/lib/metrics/hosted-usage-readout.ts)
-- and the readout's fields (scripts/lib/usage-readout.mjs) change with it.

-- =============================================================================
-- TABLE
-- =============================================================================

-- One statement, so the table always has a resource check.
alter table public.hosted_usage_snapshots
  drop constraint hosted_usage_snapshots_resource_check,
  add constraint hosted_usage_snapshots_resource_check check (
    resource in (
      'vercel_fast_data_transfer',
      'vercel_cdn_requests',
      'vercel_function_invocations',
      'vercel_active_cpu',
      'supabase_egress',
      'supabase_cached_egress',
      'supabase_log_ingestion'
    )
  );

-- =============================================================================
-- METRIC
-- =============================================================================

-- Same signature and body as before, with one more limit.
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
      ('supabase', 'supabase_cached_egress', 'GB', 5::numeric, 6),
      ('supabase', 'supabase_log_ingestion', 'GB', 1::numeric, 7)
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

-- create or replace keeps the grants; restated so this file stands alone.
revoke execute on function public.metrics_hosted_usage() from public, anon, authenticated;
grant execute on function public.metrics_hosted_usage() to service_role;
