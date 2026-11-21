# 0091 — Weekly Hosting-Usage Readout from the Vercel and Supabase Dashboards

- **Status**: Accepted
- **Date**: 2026-11-21
- **Authors**: Jakub Anderwald (with Claude Code)
- **Amends**: [0051](./0051-factory-browser-runner.md) (the browser runner may open two exact dashboard URLs, read-only), [0075](./0075-product-metrics-as-service-role-sql-functions.md) (a seventh metric, fed from outside the database)

## Context

The `/admin/stats` page (#822) shows the Supabase database and storage limits, which Postgres can measure. The other Free and Hobby quotas it can't measure:

- Supabase egress: 5 GB uncached and 5 GB cached a month.
- Vercel's fast data transfer, CDN requests, function invocations and active CPU.

These matter more than their size suggests. The free plans don't bill an overage: they switch the feature off until the window resets. On Nov 21, 2026, the Vercel dashboard showed Fluid Active CPU at 2h 17m of the 4 CPU-hours Hobby allows (57%), and nothing in Drafto warned about it.

On the plans in use, no API returns these figures:

- **Vercel Hobby:** `vercel usage` (CLI 66.6) answers "Billing cost data is unavailable … the team has no active subscription". The REST billing endpoint `/api/v2/billing/costs` returns 404.
- **Vercel's dashboard** shows the figures, but loads them through its own app's server actions with the signed-in browser session, not through a public API.
- **Vercel tokens:** none is read-only.
- **Supabase:** the Management API has read-only scoped tokens, but returns request counts only, no egress.

So a person can read the figures, and a program can't fetch them.

## Decision

Once a week, Sunday at 20:00 on the Mac mini, a read-only Claude in Chrome session reads both usage dashboards and posts the figures to Drafto. Drafto stores them and shows them next to the other limits, with the same thresholds.

1. **Storage** (`20261121000002_hosted_usage_snapshots.sql`).
   - `public.hosted_usage_snapshots` holds one row per reading: resource, amount, the dashboard's usage period, and when it was read. RLS is on with no policies, and only `service_role` may select or insert.
   - `metrics_hosted_usage()` returns the newest reading per resource against its plan limit, with `pct` and a `level`: `ok` below 70%, `warn` from 70%, `critical` from 85%, as in `metrics_platform_limits()`. It also marks a reading older than 8 days `stale`.
   - Readings and limits are kept in the dashboard's own unit (GB, a count, CPU-hours), so the percentage doesn't depend on decimal vs binary gigabytes.
   - The function follows ADR 0075: `SECURITY INVOKER`, a pinned `search_path`, and service role only.
2. **Ingest** (`POST /api/cron/hosted-usage`).
   - Its own bearer secret, `HOSTED_USAGE_SECRET`, compared in constant time. That secret can do nothing else: not `CRON_SECRET`, and no service-role key on the Mac mini for prod.
   - A strict zod body: known resources only, each once, with plausibility bounds per unit and no extra fields.
   - The route only inserts.
3. **Display.**
   - `loadProductMetrics()` reads the function: `/admin/stats` shows the readings as bars under Platform limits, with their age, and the Monday email (#823) gets them through the same loader.
   - Needs attention flags a reading at `warn` or `critical`, and a stale readout.
   - The links to both usage pages stay, as the source and the fallback.
4. **The readout** (shipped separately, in the scripts PR):
   - It is a new `usage` kind of the factory's browser runner (ADR 0051), on the Mac mini's existing Chrome profile, scheduled by its own launchd job.
   - That profile is signed in to Vercel, and Vercel Hobby can't add a read-only member, so the **guard is the safety boundary**. For this kind only:
     - navigation is allowed to two exact URLs, the Vercel team's usage page and the Supabase org's usage page;
     - no click, typing, key, form input or page JavaScript;
     - a tab that leaves those URLs is quarantined;
     - the session never signs in. A login wall ends the run as `unavailable`.
   - `vercel.com` stays forbidden for every other kind, and `drafto.eu` for all kinds.
   - The run prints the figures as shown. A node parser turns them into numbers deterministically, scans the output for secrets, and posts the readout. Nothing goes to GitHub.
   - A failure emails the operator through the factory's existing health path.

## Consequences

- **Positive**:
  - The quotas that can switch Drafto off are visible every week, next to the database and storage limits, with no new service, no paid plan and no long-lived write token anywhere.
  - Active CPU, the one closest to its limit, now gets the same 70% / 85% treatment.
- **Negative**:
  - The figures are up to a week old, and the Monday email reads Sunday's.
  - Scraping a dashboard is brittle: a redesign can break the readout. The page then shows the reading as stale, and the operator gets an email.
  - An unattended session now opens a page on `vercel.com` in a profile with full control of the Vercel account. The guard's read-only mode is what stands between it and a destructive click. The guard's tests pin that profile, and any change to it needs review.
- **Neutral**:
  - A new web-only, service-role table that isn't in the shared `Database` type: the route casts its table name, as the loader casts RPC names.
  - The privacy policy doesn't change: the readings are account-level aggregates from providers that are already processors.

## Alternatives Considered

- **Provider APIs with a token.** Vercel Hobby has no usage API, and no Vercel token is read-only. Supabase's API has no egress figure. Revisit if either changes (`docs/features/product-metrics.md`, "Hosting usage").
- **Upgrade to Vercel Pro** for the billing API: a new monthly cost, just to read a number.
- **An on-demand interactive skill** that reads the dashboards when asked: safer, but nothing would warn before a limit is hit.
- **Alert-only, without storing anything in Drafto:** smaller, but the page and the Monday email would still say nothing about these quotas.
- **A dedicated Chrome profile signed in to Vercel and Supabase only** (ADR 0051's upgrade path): stronger isolation, but it needs a second profile and extension on the Mac mini. Rejected for now in favour of the guard's read-only mode. It remains the next step if the guard ever has to allow more.
