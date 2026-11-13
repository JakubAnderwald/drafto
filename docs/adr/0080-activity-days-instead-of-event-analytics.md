# 0080 — Activity Days Instead of Event Analytics

- **Status**: Accepted
- **Date**: 2026-11-13
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

Weekly active users (WAU) is Drafto's north-star metric: the people who opened Drafto on at least one day that week, to read or to write. Step 1 of the product-metrics rollout ([ADR-0075](./0075-product-metrics-as-service-role-sql-functions.md)) counts writers from `note_content_history`. A note app is also used to look things up, though, and a reader leaves no record anywhere the metrics can see:

- **Reads on mobile and desktop are local.** The iOS, Android and macOS apps read notes from WatermelonDB ([ADR-0010](./0010-offline-sync-strategy.md)). Opening a note never reaches the server, and a sync pull doesn't say who opened the app or when.
- **Request logs don't last and can't be counted per user.** Supabase keeps API request logs for one day on the Free plan, and Vercel's request logs on its free tier are short-lived as well. Neither gives a per-user history that weeks can be counted from.
- **Sentry runs on web only, and its spans carry no user id.** The native apps have no Sentry SDK, and on web Sentry is never told who the user is (no `setUser`, `sendDefaultPii` left at its default, off).
- **PostHog ships but is switched off.** `posthog-js` / `posthog-node` are in `apps/web`, but no key is set, and the privacy policy says so ([privacy policy](../features/privacy-policy.md)).

WAU needs one fact per user per day: they opened Drafto. It doesn't need which notes, screens or buttons. Drafto runs on free tiers, so the answer must not add a paid service or a new processor of user data.

## Decision

Record **activity days**: one row per user, UTC day and client, written by every client and by the MCP route, and count WAU and retention from them in SQL.

- **Table `public.usage_daily`** `(user_id, day, client, content_changes)`, primary key `(user_id, day, client)`, `user_id` referencing `auth.users` with `on delete cascade`. `client` is one of the five `x-drafto-client` tags ([ADR-0023](./0023-per-request-client-tagging.md)): `web`, `mobile-ios`, `mobile-android`, `desktop-macos`, `web-mcp`. The list is `DRAFTO_CLIENT_TAGS` in `packages/shared/src/constants.ts`, mirrored in the table's check constraint, and a drift test keeps the two in step. RLS is on with no policies, `anon` and `authenticated` have no privileges, and `service_role` has all of them ([ADR-0052](./0052-explicit-data-api-grants.md)). A user can't read the table, not even their own rows.
- **One write path for signed-in clients: `public.record_activity(p_days date[], p_client text)`.** `SECURITY DEFINER` with a pinned `search_path`, executable by `authenticated` only. It inserts `(auth.uid(), day, p_client)` for each day, `on conflict do nothing`, so a user can only ever write their own rows. It rejects an unknown tag and more than 31 days per call, and drops days in the future (UTC) or more than 30 days back.
- **Every client pings:**
  - **Web**: the signed-in app shell calls `record_activity([today], 'web')` once per browser session per UTC day, fire-and-forget, after render. It checks again when the tab comes back to the front, so a tab left open past midnight counts the new day.
  - **iOS, Android, macOS**: the sync code keeps a queue of the UTC days the app was opened (at most 30) in WatermelonDB's `localStorage`, and sends it after each successful sync. Days opened offline wait in the queue. A failed ping never fails the sync and is retried by the next one. The queue is cleared with the local database on sign-out and account switch, so one user's days are never sent under another user's session.
  - **MCP**: the route authenticates by API key and queries as `service_role`, so `auth.uid()` is null there and the RPC can't be used. On each authenticated call, after the response is sent (Next's `after()`), it upserts `(user, today, 'web-mcp')` itself, ignoring duplicates.

  The day logic (UTC day, queue, tag list, one `recordActivity` wrapper) lives once, in `packages/shared/src/activity/`.

- **A nightly rollup fills `content_changes`.** `public.rollup_usage_daily(p_day)`, run by pg_cron at 00:30 UTC for the previous UTC day, counts that day's content overwrites per user and client tag from `note_content_history`, plus the notes created that day. It sets the counts rather than adding to them, so a rerun gives the same result. It also deletes rows older than 13 months.
- **Two metrics**, with the same rules as ADR-0075 (`SECURITY INVOKER`, `STABLE`, pinned `search_path`, service role only, excluded accounts through `metrics_excluded_user_ids()`):
  - `metrics_active_users(p_weeks)`: per ISO week, the users with an activity day, the writers among them (`content_changes > 0`), and both split by client.
  - `metrics_retention(p_weeks)`: per sign-up-week cohort of activated users (ADR-0075's definition), how many were active again in week 1 (days 7–13 after sign-up) and in week 4 (days 28–34).

  Activation stays defined once: a per-user helper, `metrics_cohort_activation(p_weeks)`, takes over the body of `metrics_activation`, which is re-created over it with the same columns and results, and `metrics_retention` reads the same helper. `pnpm users:stats` prints both new metrics.

- **Days only.** No note id, title, screen, action or duration is recorded. The privacy policy says what is recorded, why, and that it is kept 13 months and deleted with the account.

Definitions and caveats: [`docs/features/product-metrics.md`](../features/product-metrics.md).

## Consequences

- **Positive**:
  - WAU counts readers as well as writers, on every platform, including people who only use Drafto through an AI assistant over MCP.
  - No new service, SDK, processor or monthly cost. The data stays in the Supabase project that already holds the notes.
  - The data is tiny and bounded: at most five rows per user per day, kept 13 months.
  - The metrics read the same SQL as ADR-0075's, so the `/admin/stats` page ([#822](https://github.com/JakubAnderwald/drafto/issues/822)) and the Monday email reuse them as they are.
  - The writes are idempotent everywhere: a repeated ping, a second tab or an MCP call per request adds nothing after the first row of the day.
- **Negative**:
  - **Counting starts the day this ships.** There is no backfill: weeks before it show no active users, and retention windows that started before the first row are null.
  - **The native apps are counted only once users update them.** Older builds don't ping. Their users appear only on days they save a change to an existing note, because the rollup creates a client's row for a tagged overwrite when no ping arrived that day.
  - **The rollup's attribution is a definition choice.** Work that carries no known tag (new notes, and overwrites with no tag or another tag such as `web-cron`) counts on the user's existing row for that day that comes first in the tag order, and is dropped when the user has none. Only the previous UTC day is rolled up, and work is dated when the server receives it, so work done offline counts on the day it syncs, never on an earlier day. The current week's writers lag by a day.
  - **Week-4 retention can be read for only about 10 days per cohort.** Its window completes 41 days after the cohort's week start, and `activated` turns null 51 days after it, once the 30-day history no longer covers the activation window.
  - **Days are UTC days**, not the user's local days, and the client tag is self-reported. A user can write only their own rows, but could claim any of the five tags, so `by_client` describes usage rather than proving it (like `archived_by` in ADR-0023).
  - **Store disclosures change.** The App Store Connect privacy details (iOS and macOS) and the Play Console Data safety form must declare the usage data. They're edited by hand, so the PR lists them as an operator follow-up.
  - **The migration needs the `migration-approved` label**, like every change under `supabase/migrations/`. The web E2E calls the real RPC on dev, so it fails until the migration is pushed to dev.
  - A failed ping costs a little noise: on web a Sentry warning at most once per page load; on native a console warning only, because the native apps have no Sentry SDK.
- **Neutral**:
  - A third pg_cron job (`rollup-usage-daily`), in its own migration so the PGlite tests can run the main one verbatim.
  - One more function callable by signed-in users (`record_activity`), and four more service-role-only functions in `public`.
  - `metrics_activation` is re-created; its columns and results don't change, and ADR-0075's PGlite cases run against the new definition.

## Alternatives Considered

- **PostHog, or any event-analytics SDK.** Rejected. It would make a third party a processor of event-level data (pages, clicks, device details), add a consent burden, need SDKs on all three native apps, and cost money past its free tier, all to learn one bit per user per day. PostHog stays off.
- **Supabase or Vercel request logs.** Rejected: kept about a day on the free tiers, with no user id to count by. Keeping them longer needs a paid log drain.
- **Sentry spans.** Rejected: web only, no user id, and it would turn the error tracker into a usage-analytics store.
- **Counting only writes** (ADR-0075's `metrics_writers`). Rejected as the WAU definition: it misses everyone who opens Drafto to read.
- **A `last_seen_at` column on `profiles`.** Rejected: one timestamp per user loses the history, so past weeks and retention can't be counted.
- **Recording note opens.** Rejected and out of scope: which notes a user reads is close to their content, and a day is all WAU needs.
- **Letting clients insert into `usage_daily` under an RLS policy.** Rejected: the definer function keeps the limits (31 days, no future days, 30 days back, known tags) in one place, and keeps the table itself out of reach of users.
