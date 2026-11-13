# Product metrics

**Status:** shipped (steps 1 and 2 of 4) **Updated:** 2026-11-13

## What it is

Drafto's own usage numbers (sign-ups, activation, weekly writers, weekly active users, retention, silently emptied notes, depth of use and the Supabase Free plan limits) computed inside Postgres as SQL functions that only the service role can call. `pnpm users:stats` prints them in the terminal. Later steps of the rollout reuse the same functions: the `/admin/stats` page (step 3) and a Monday email (step 4). Every caller reads the same SQL, so no caller re-implements a definition.

The functions work from metadata only: timestamps, character counts, client tags and the days a user opened Drafto. None of them returns note text, titles or notebook names.

## Current state

- Step 1 ([#820](https://github.com/JakubAnderwald/drafto/issues/820)), two migrations: `note_text_chars(jsonb)`, then the exclusion table, three helpers and the six metric functions.
- Step 2 ([#821](https://github.com/JakubAnderwald/drafto/issues/821)), two more migrations. The first adds [activity days](#activity-days-usage_daily) (`usage_daily`, written through `record_activity` and filled in by the [nightly rollup](#nightly-rollup-rollup_usage_daily)), `metrics_active_users`, `metrics_retention` and the per-user helper `metrics_cohort_activation`, and re-creates `metrics_activation` over that helper. The second schedules the rollup with pg_cron. Every client records activity days: web, iOS, Android, macOS and MCP ([ADR-0078](../adr/0078-activity-days-instead-of-event-analytics.md)).
- `scripts/user-stats.mjs` (`pnpm users:stats`) calls the eight metric functions read-only and prints one table per metric, or JSON.
- The `/admin/stats` page ([#822](https://github.com/JakubAnderwald/drafto/issues/822)) hasn't merged yet. It wires in `metrics_active_users` and `metrics_retention` when it does.

## Excluded accounts

Every metric except the platform limits leaves out two groups of users:

- admins (`profiles.is_admin = true`);
- the users listed in `public.metrics_excluded_users (user_id, reason)`.

The migration seeds that table, by email, with the shared test and store-review accounts that exist in the project: `e2e-test@drafto.eu`, `googleplay-test@drafto.eu` and `appreview@drafto.eu`. On prod, the E2E and Play test accounts own 440 of the 453 notebooks, so leaving them in would swamp every total. To exclude another account, insert its id with the service role (SQL editor or PostgREST):

```sql
insert into public.metrics_excluded_users (user_id, reason)
values ('<user id>', '<why>');
```

The rule lives in one place, `metrics_excluded_user_ids()`, and every per-user metric reads it. Deleting a user removes their row (`on delete cascade`).

## Activity days (`usage_daily`)

A row says that the user opened Drafto on that UTC day on that client. Nothing else is recorded: no note, title, screen, action or duration ([ADR-0078](../adr/0078-activity-days-instead-of-event-analytics.md)).

| Column            | Meaning                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `user_id`         | The user. References `auth.users` with `on delete cascade`, so deleting the account deletes the rows.                                                                                                                                                                                                                                                                    |
| `day`             | The UTC date. Indexed.                                                                                                                                                                                                                                                                                                                                                   |
| `client`          | One of the five `x-drafto-client` tags ([ADR-0023](../adr/0023-per-request-client-tagging.md)): `web`, `mobile-ios`, `mobile-android`, `desktop-macos`, `web-mcp`. The check constraint `usage_daily_client_check` mirrors `DRAFTO_CLIENT_TAGS` in `packages/shared/src/constants.ts`, and `packages/shared/__tests__/client-tags-drift.test.ts` fails when they differ. |
| `content_changes` | That day's content changes from that client, filled by the [nightly rollup](#nightly-rollup-rollup_usage_daily). 0 until then.                                                                                                                                                                                                                                           |

The primary key is `(user_id, day, client)`: one row per user, day and client, however often the user opens Drafto.

### Who writes it

| Client                                          | When                                                                                                                                        | How                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web`                                           | When the signed-in app shell mounts, and whenever the tab becomes visible or gets focus again; at most once per browser session per UTC day | `ActivityPing` in `apps/web/src/app/(app)/layout.tsx` (hook: `useActivityPing`) calls `record_activity([today], 'web')` after render, never awaited. The `sessionStorage` key `drafto:activity-day` holds `<user id>:<day>` and is written only after a successful call, so a failed ping is tried again on the next mount or return to the tab. A failure is a Sentry warning, at most once per page load. |
| `mobile-ios`, `mobile-android`, `desktop-macos` | After each successful sync, with every UTC day the app was opened since the last ping                                                       | A queue of days in WatermelonDB's `localStorage`, at most 30, sent through `record_activity` ([offline sync → Activity ping](./offline-sync.md#activity-ping)). A failed ping never fails the sync and is retried by the next one. A device with mobile's fallback tag `mobile` (neither iOS nor Android) never pings.                                                                                      |
| `web-mcp`                                       | Each authenticated MCP call, after the response is sent                                                                                     | The MCP route has no `auth.uid()`: it authenticates by API key and queries as the service role. So `recordMcpActivity` upserts `(user, today, 'web-mcp')` itself, ignoring duplicates ([MCP server → Auth model](./mcp-server.md#auth-model)).                                                                                                                                                              |
| any of the five                                 | The nightly rollup                                                                                                                          | Creates a client's row for a day when the user overwrote a note from it but no ping arrived that day.                                                                                                                                                                                                                                                                                                       |

The clients share the day logic from `packages/shared/src/activity/`: `utcDay()`, the queue helpers (at most `ACTIVITY_QUEUE_MAX_DAYS` = 30 days, newest kept) and `recordActivity()`, which sends at most `RECORD_ACTIVITY_MAX_DAYS` = 31 valid days, makes no call with nothing to send, and never throws.

### Who can read it

Nobody but the service role. RLS is on with no policies, and `anon` and `authenticated` have no privileges on the table, so a user can't read it, not even their own rows, and can't write it directly. `service_role` has `select`, `insert`, `update` and `delete`: the metrics read the table, and the MCP route writes it.

### `record_activity(p_days date[], p_client text)`

The only way in for signed-in clients. `SECURITY DEFINER` with `set search_path = public, pg_catalog`; `execute` is granted to `authenticated` only and revoked from `public`, `anon` and `service_role`. It writes rows only for `auth.uid()`:

- No signed-in user: error `42501`.
- `p_client` null or not one of the five tags: `22023`, `unknown client tag: …`.
- More than 31 elements in `p_days`: `22023`, `at most 31 days per call, got …`.
- Null or empty `p_days`: returns 0 and writes nothing.
- Drops null elements, days after today (UTC), days more than 30 days before today, and duplicates.
- Inserts `on conflict (user_id, day, client) do nothing`, and returns the number of new rows.

## Nightly rollup (`rollup_usage_daily`)

The pg_cron job `rollup-usage-daily` runs `public.rollup_usage_daily()` at 00:30 UTC every day. Without an argument it rolls up the previous UTC day. For that day:

1. It sets `content_changes` to 0 on every row of the day.
2. It counts the day's content overwrites (`note_content_history` rows archived that UTC day) per user and `archived_by`, for the five tags, and sets that client's row to the count. When the client never pinged that day, it creates the row, as long as the user still exists.
3. It counts each user's untagged work that day: overwrites whose `archived_by` is null or another tag, and notes created that day, of any size. It adds the count to the user's row for the day whose client comes first in the order `web`, `mobile-ios`, `mobile-android`, `desktop-macos`, `web-mcp`, including a row step 2 created. A user with no row that day loses it.
4. It deletes every row whose day is more than 13 months before today (UTC).

It returns the number of the day's rows with `content_changes > 0`, and raises `22023` on a null day. It's `SECURITY DEFINER` with the same pinned `search_path`, and only `service_role` may execute it.

Because step 1 resets the day before steps 2 and 3 count it, a rerun gives the same result instead of adding up. To redo a day after a failed run, run it as the service role (SQL editor), on prod only after an explicit yes:

```sql
select public.rollup_usage_daily('2026-11-12');
```

Only redo a day from the last 29 days. The history retention deletes overwrites 30 days after they were archived, and step 1 has already reset the day, so a rerun on an older day counts less than the first run did. To see the last runs:

```sql
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'rollup-usage-daily')
order by start_time desc
limit 5;
```

## Definitions

Shared terms:

- **Text characters**: `note_text_chars(content)`, the summed `char_length` of every string-valued `text` key anywhere in the editor JSON (BlockNote blocks, nested `children`, links, table cells, TipTap nodes). Ids, props, styles, marks and URLs don't count. Null content is 0.
- **A version** of a note: each overwritten version in `note_content_history` (its `content`, saved at `content_updated_at`) and the note's current `content` (saved at `updated_at`).
- **A write**, from `metrics_write_events(p_from, p_to)`:
  - a content overwrite: a `note_content_history` row, at its `archived_at`, by its `archived_by` client tag ([ADR-0023](../adr/0023-per-request-client-tagging.md)). Any size counts.
  - a new note whose first version holds 50 or more characters, at its `created_at`. The first version is the note's oldest history row, or its current content when it was never overwritten. Inserts carry no client tag, so these count as `untagged`, including notes created offline on mobile or desktop and pushed by sync.
- **Untagged**: a write with no `x-drafto-client` tag.
- **An activity day**: a `usage_daily` row, saying the user opened Drafto on that UTC day on that client ([Activity days](#activity-days-usage_daily)).
- **Weeks** are ISO weeks, Monday 00:00 UTC to the next Monday. Days are UTC dates.
- **MB** is 1024 × 1024 bytes and GB is 1024³ bytes.

Writes (`metrics_write_events`, behind writers and depth) never come from `notes.updated_at`: title, trash and notebook changes move it too, and on Oct 31 six notes got a new `updated_at` in the same minute with no content change. Activation is the exception, by its definition: it dates a note's current version by `updated_at` (see Caveats).

| Function                                    | Returns                                                                                                                                                                        | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics_signups(p_weeks)`                  | per week: `week_start`, `iso_week`, `signups`, `by_provider` (jsonb)                                                                                                           | New accounts (`auth.users.created_at`) per week for the last `p_weeks` weeks, this one included, split by `raw_app_meta_data->>'provider'` (`email`, `google`, `apple`, …; `unknown` when missing). Weeks with none show 0.                                                                                                                                                                                                                                                                                                                                                                          |
| `metrics_activation(p_weeks)`               | per sign-up-week cohort: `week_start`, `iso_week`, `signed_up`, `first_value`, `activated`, `window_complete`                                                                  | **First value**: a version of 50+ characters saved within 14 days of sign-up. **Activated** (Drafto's one activation definition, decided Nov 11): such versions saved on 2+ distinct UTC days within those 14 days. `activated` is `null` once the cohort's last window (week start + 21 days) ended more than 30 days ago, beyond the history retention. `window_complete` is false while a member's window is still open, so the counts can still grow.                                                                                                                                            |
| `metrics_writers(p_weeks)`                  | per week: `week_start`, `iso_week`, `writers`, `by_client` (jsonb), `history_complete`                                                                                         | Distinct users with a write in the week, and the same count per client tag (`web`, `mobile-ios`, `mobile-android`, `desktop-macos`, `web-mcp`, `untagged`, and any other tag seen). A user who wrote from two clients counts once in `writers` and once under each client. `history_complete` is false for weeks that started more than 30 days ago.                                                                                                                                                                                                                                                 |
| `metrics_active_users(p_weeks)`             | per week: `week_start`, `iso_week`, `active_users`, `writers`, `by_client` (jsonb), `week_complete`                                                                            | **Weekly active users**: distinct users with an activity day (any client) in the week, for the last `p_weeks` weeks, this one included, oldest first. **Writers**: those of them with `content_changes > 0` on a row that week. `by_client`: distinct active users per client tag (`{}` when none); a user active on two clients counts once in `active_users` and once under each client. `week_complete` is true once the week has ended (week start + 7 days ≤ today, UTC). Weeks with none show 0. Not the same count as `metrics_writers` (see [Caveats](#caveats-active-users-and-retention)). |
| `metrics_retention(p_weeks)`                | per sign-up-week cohort: `week_start`, `iso_week`, `activated`, `active_week1`, `pct_week1`, `active_week4`, `pct_week4`                                                       | `activated` is `metrics_activation`'s count for the cohort, null when that is null. **Week 1**: the cohort's activated users with an activity day (any client) 7 to 13 days after their sign-up day, both ends included. **Week 4**: 28 to 34 days after. The sign-up day is the UTC date of sign-up. `pct_week1` and `pct_week4` are `round(100.0 × active / activated, 1)`. The [null cases](#retention-when-a-value-is-null) are below.                                                                                                                                                           |
| `metrics_emptied_notes(p_since[, p_as_of])` | per note: `note_id`, `user_id`, `emptied_at`, `client`, `chars_before`                                                                                                         | The silent-emptying detector. A note is listed when it isn't trashed, its current text is 0 characters, and its last version with any text held 200+ characters. The save that replaced that version emptied it: `emptied_at` is that history row's `archived_at`, `client` its `archived_by` (`untagged` when null), `chars_before` its size. Every version since has had no text. Listed once that save is at least 24 hours old and happened at or after `p_since`. A refilled or trashed note isn't listed.                                                                                      |
| `metrics_depth()`                           | one row: `writers`, the median and maximum of live notes, notebooks and attachment MB, and `pct_with_attachment`, `pct_with_api_key`, `pct_with_mcp_write`, `pct_multi_client` | Over users with a write in the last 30 days: live (untrashed) notes, notebooks, and attachment MB (`attachments.file_size`), each as median and maximum. Then the percentage of them with any attachment, with an unrevoked API key, with a `web-mcp` overwrite, and with overwrites from 2 or more tagged clients. With no writers, the medians and percentages are null.                                                                                                                                                                                                                           |
| `metrics_platform_limits()`                 | per resource: `resource`, `used_bytes`, `limit_bytes`, `pct`, `level`                                                                                                          | `database`: `pg_database_size(current_database())` against 500 MB. `storage`: the summed `metadata->>'size'` of `storage.objects` in the `attachments` bucket against 1 GB. Levels: `ok` below 70%, `warn` from 70%, `critical` from 85%. The limits are constants in the function, from [Supabase pricing](https://supabase.com/pricing). Project-wide, so nobody is excluded.                                                                                                                                                                                                                      |

Helpers, also service-role only: `note_text_chars(content)`, `metrics_excluded_user_ids()`, `metrics_week_starts(p_weeks)` (rejects `p_weeks` outside 1–520 with `22023`), `metrics_write_events(p_from, p_to)` and `metrics_cohort_activation(p_weeks)`.

`metrics_cohort_activation(p_weeks)` returns one row per non-excluded user who signed up in the last `p_weeks` ISO weeks: `user_id`, `week_start`, `signed_up_at`, and `first_value` and `activated` as booleans, defined as in `metrics_activation`. `metrics_activation` is an aggregate over it, with the same columns and results as in step 1, and `metrics_retention` reads it too, so activation is defined in one place.

`metrics_emptied_notes` takes `p_as_of` (default `now()`) only so a test can move the 24-hour cutoff: history rows come from a trigger at `now()`, so a test can't backdate an emptying save. Callers leave it out. The note's state is always read as of now.

### Retention: when a value is null

`active_week1` or `active_week4` is null, and its `pct_` column with it, when:

- `activated` is null: the cohort is too old for the 30-day history, 51 days after its week start (see `metrics_activation`);
- the window is still open for a member of the cohort: week 1 until 20 days after the week start, week 4 until 41 days after it, because the last member can sign up on the Sunday;
- the window started before tracking did: the week start + 7 days (week 1) or + 28 days (week 4) is before the oldest `usage_daily` day, or the table is empty.

A `pct_` column is also null when `activated` is 0.

So week 4 can be read for only about 10 days per cohort: from 41 days after its week start, when the last window has closed, to 51 days, when `activated` turns null. With the default 8 weeks, that is usually the cohort from six weeks before the current one.

### Caveats

- **History is kept 30 days** (`cleanup_note_content_history`, [ADR-0022](../adr/0022-note-content-history.md)). For older weeks, overwrites are gone: `activated` turns null and `first_value` becomes a lower bound. `writers` can be off in either direction there (`history_complete` marks those weekly rows). A purged overwrite no longer counts, which lowers it. And once a note's first version is purged, its oldest surviving version stands in for it, so a note created with fewer than 50 characters and filled in a later week can count as a new-note write in the week it was created, which raises it. A cohort 30 to 51 days old can still show a lower bound for `activated`, because versions saved early in its window may already be purged. The emptying detector can't see a note whose last version with text was archived more than 30 days ago.
- **Activation dates versions by `updated_at`, which isn't only a content save.** A note's current version is dated by `notes.updated_at`, and a history version by `content_updated_at`, the overwritten row's `updated_at`. A rename, a notebook move, trashing or restoring all move `updated_at`. So such a change on a later day inside the 14 days adds a second activation day (an overcount: a user who wrote on one day can count as activated), and one after the 14 days moves the current version out of the window (an undercount of first value and activation). A bulk touch like Oct 31's would mark every cohort member with a 50+ character note as activated. This follows the issue's definition of a version; dating versions by `archived_at` instead would be a definition change. Writers and depth count on `archived_at` and `created_at` and aren't affected.
- **"Still empty" means now**: a note emptied and later refilled, even after 24 hours, isn't listed.
- **Storage objects without a numeric `metadata.size`** count as 0.

### Caveats: active users and retention

- **Counting starts the day step 2 ships, with no backfill.** Earlier weeks show 0 active users rather than null, and the first week is partial. Retention windows that started before the first row are null.
- **The native apps are counted only once users update.** A build from before step 2 never pings. Its user shows up only on days they save a change to an existing note from it, because the rollup creates a client's row for a tagged overwrite. Web and MCP count from the deploy.
- **The rollup's attribution is a definition choice.** A tagged overwrite counts on that client's row, and creates the row when no ping arrived that day. Untagged work (notes created that day, and overwrites with no tag or another tag such as `web-cron`) is added to the user's row for that day whose client comes first in the order `web`, `mobile-ios`, `mobile-android`, `desktop-macos`, `web-mcp`, and is dropped when the user has no row that day.
- **Work counts on the day the server receives it.** The rollup reads only the previous UTC day, and never adds to an older one. An overwrite is dated by its `archived_at` and a new note by its `created_at`, both set by the server when sync pushes them, so work done offline counts on the day it syncs.
- **Writers lag a day.** Today's `content_changes` are filled at 00:30 UTC tomorrow, so the current week's `writers` doesn't include today yet.
- **`metrics_active_users.writers` isn't `metrics_writers.writers`.** `metrics_writers` counts write events from the 30-day history: any overwrite, and new notes of 50+ characters. `content_changes` counts new notes of any size, drops untagged work of a user with no row that day, and is kept 13 months. Expect the two to differ.
- **Days are UTC days.** In Warsaw in winter, opening Drafto at 00:30 local time counts on the previous day.
- **When a day is marked.** Web pings when the signed-in app shell mounts and when the tab becomes visible or gets focus again, so a tab left in front past midnight UTC counts the new day once it regains focus or is reloaded. The native apps mark a day whenever a sync starts, so an app left open counts the new day at its next sync.
- **The client tag is self-reported.** A user can write only their own rows, but could claim any of the five tags, so `by_client` describes usage rather than proving it ([ADR-0023](../adr/0023-per-request-client-tagging.md)).

## Running `pnpm users:stats`

From an interactive session on a machine with `~/drafto-secrets/supabase service keys.txt` (the `PROD:` / `DEV:` lines `pnpm users:delete` also reads):

```bash
pnpm users:stats -- --project prod             # the last 8 ISO weeks, as tables
pnpm users:stats -- --project prod --weeks 12  # 1 to 104 weeks
pnpm users:stats -- --project dev --json       # one JSON object
pnpm users:stats -- --project prod --keys-txt <file>
```

- **Read-only.** It calls each function with `GET /rest/v1/rpc/<name>`, which PostgREST runs in a read-only transaction, and every metric function is `STABLE`, so the database refuses a write even if one were attempted.
- **The key is never printed.** It travels in request headers only; any error text is masked.
- **Interactive sessions only.** It refuses `DRAFTO_UNATTENDED` (factory, support, nightly, the verification lane) and `node --test` before reading any key file, and the verification lane's guard denies any command naming it.
- It prints a retention table after the activation table, and a weekly active users table before the writers table. In `--json` they are `retention` and `activeUsers`.
- `--weeks` sets the weekly tables' range, the retention cohorts included, and the emptied-notes check looks back as far.
- One failing metric doesn't hide the others. The run prints them and exits 1.
- PostgREST caps every response at the project's `max_rows` (1000 by default), stored procedures included, without saying so. Each call asks for the exact count (`Prefer: count=exact`), and a list shorter than its count fails instead of printing part of it. In practice only the emptied notes can grow that long. Rerun with a smaller `--weeks`.
- Exit codes: 0 when every metric was read, 1 on a failure or refusal, 2 on bad arguments.

## If sign-ups and activation fail with permission denied

`metrics_signups` and `metrics_activation` read `auth.users` as `service_role` (`metrics_activation` and `metrics_retention` through `metrics_cohort_activation`), so the migration grants it `select (id, created_at, raw_app_meta_data)` on that table. Where the migration's role can't make that grant, the migration doesn't fail. It warns `product metrics: service_role cannot read auth.users …` and points here. Those functions then fail with `permission denied` (`42501`), in `pnpm users:stats` and in `pnpm test:live:supabase -- --only metrics`. The other metrics still work.

Check in the project's SQL editor. All four values must be `true`:

```sql
select
  has_schema_privilege('service_role', 'auth', 'usage') as auth_usage,
  has_column_privilege('service_role', 'auth.users', 'id', 'select') as id,
  has_column_privilege('service_role', 'auth.users', 'created_at', 'select') as created_at,
  has_column_privilege('service_role', 'auth.users', 'raw_app_meta_data', 'select') as raw_app_meta_data;
```

To restore access, grant the same three columns, and no others, as a role that holds the grant option on `auth.users`. On prod, run it only after an explicit yes:

```sql
grant usage on schema auth to service_role;
grant select (id, created_at, raw_app_meta_data) on auth.users to service_role;
```

Don't grant `select` on the whole table: the functions read nothing else, and the [invariants](#modifying-safely) keep it that way. Then run the check again, and on dev also the live test. If no role you can use holds the grant option, a grant made by hand can't fix it. Reading `auth.users` another way, for example through a `SECURITY DEFINER` wrapper, is a design change: it needs a new migration and an ADR that supersedes [0075](../adr/0075-product-metrics-as-service-role-sql-functions.md).

## Code paths

| Concern                                                                                                                                                 | Path                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `note_text_chars`                                                                                                                                       | `supabase/migrations/20261112000001_note_text_chars.sql`                                                                                        |
| Exclusion table, helpers, the six metrics, permissions                                                                                                  | `supabase/migrations/20261112000002_product_metrics.sql`                                                                                        |
| `usage_daily`, `record_activity`, the rollup, `metrics_cohort_activation`, `metrics_activation` re-created, `metrics_active_users`, `metrics_retention` | `supabase/migrations/20261113000003_usage_daily.sql`                                                                                            |
| The rollup's pg_cron schedule                                                                                                                           | `supabase/migrations/20261113000004_usage_daily_cron.sql`                                                                                       |
| Client tags, day queue helpers, `recordActivity`                                                                                                        | `packages/shared/src/constants.ts`, `packages/shared/src/activity/{activity-days,record-activity}.ts`                                           |
| Web ping                                                                                                                                                | `apps/web/src/hooks/use-activity-ping.ts`, `apps/web/src/components/layout/activity-ping.tsx`, `apps/web/src/app/(app)/layout.tsx`              |
| MCP ping                                                                                                                                                | `apps/web/src/lib/api/record-mcp-activity.ts`, `apps/web/src/app/api/mcp/route.ts`                                                              |
| Native ping (mirrored)                                                                                                                                  | `apps/{mobile,desktop}/src/db/activity-days.ts`, `apps/{mobile,desktop}/src/db/sync.ts`, the tag in `apps/{mobile,desktop}/src/lib/supabase.ts` |
| CLI (`pnpm users:stats`)                                                                                                                                | `scripts/user-stats.mjs`                                                                                                                        |
| Service-role key reader shared with `users:delete`                                                                                                      | `scripts/lib/service-keys-txt.mjs`                                                                                                              |
| Operator-only guard for the verification lane                                                                                                           | `scripts/lib/verify-guard.mjs`                                                                                                                  |
| Unit: `note_text_chars` in PGlite                                                                                                                       | `scripts/__tests__/note-text-chars.test.mjs`                                                                                                    |
| Unit: every metric in PGlite, with backdated data                                                                                                       | `scripts/__tests__/product-metrics.test.mjs`                                                                                                    |
| Unit: `usage_daily`, `record_activity`, the rollup and the two new metrics in PGlite                                                                    | `scripts/__tests__/usage-daily.test.mjs`                                                                                                        |
| Unit: the CLI, with a faked fetch                                                                                                                       | `scripts/__tests__/user-stats.test.mjs`                                                                                                         |
| Unit: shared day logic, and the tag list against the check constraint                                                                                   | `packages/shared/__tests__/{activity-days,record-activity,client-tags-drift}.test.ts`                                                           |
| Unit: web and MCP pings                                                                                                                                 | `apps/web/__tests__/unit/{use-activity-ping,record-mcp-activity,mcp-route}.test.ts`                                                             |
| Integration: `<ActivityPing />` under StrictMode                                                                                                        | `apps/web/__tests__/integration/activity-ping.test.tsx`                                                                                         |
| Unit: native queue and sync wiring                                                                                                                      | `apps/{mobile,desktop}/__tests__/db/{activity-days,sync}.test.ts`                                                                               |
| E2E: opening the web app records today's `web` row                                                                                                      | `apps/web/e2e/usage-daily.spec.ts`                                                                                                              |
| Dev live test (`--only metrics`)                                                                                                                        | `scripts/__tests__/product-metrics.live.test.mjs`                                                                                               |
| Dev live test (`--only usage-daily`): `record_activity`'s limits and RLS                                                                                | `scripts/__tests__/usage-daily.live.test.mjs`                                                                                                   |

## Related ADRs

- [0075 — Product Metrics as Service-Role SQL Functions](../adr/0075-product-metrics-as-service-role-sql-functions.md)
- [0078 — Activity Days Instead of Event Analytics](../adr/0078-activity-days-instead-of-event-analytics.md)
- [0022 — Note Content History](../adr/0022-note-content-history.md) (the source of writes, and its 30-day retention)
- [0023 — Per-Request Client Tagging](../adr/0023-per-request-client-tagging.md) (the `archived_by` client tags)
- [0052 — Explicit Data API Grants](../adr/0052-explicit-data-api-grants.md)

## Cross-platform notes

The metrics read the server tables every platform writes to. They see a native client's write once sync pushes it: an overwrite is tagged `mobile-ios`, `mobile-android` or `desktop-macos`, and a note created offline arrives as an insert, counted as `untagged`.

Activity days come from every platform: web from the app shell, iOS, Android and macOS from the sync code, and MCP from the route ([Who writes it](#who-writes-it)). The native ping lives in `apps/mobile/src/db/` and `apps/desktop/src/db/`, which must stay in step like the rest of the sync code.

## Modifying safely

- Invariants:
  - Every metric function and helper is `SECURITY INVOKER`, `set search_path = public, pg_catalog`, `STABLE` (`note_text_chars` is `IMMUTABLE`), and revokes `execute` from `public`, `anon` and `authenticated`, granting it to `service_role` only. A new one does the same, in the migration that creates it. `scripts/__tests__/product-metrics.test.mjs` fails on any public function it doesn't list.
  - The two activity-day writers are the exceptions, and stay `SECURITY DEFINER` with the same pinned `search_path`: `record_activity`, executable by `authenticated` only, writes rows for `auth.uid()` and nobody else; `rollup_usage_daily`, executable by `service_role` only, sets counts and never adds to them, so a rerun is safe.
  - `usage_daily` stays out of reach of `anon` and `authenticated`: no policies and no grants. Signed-in clients write it only through `record_activity`.
  - `usage_daily` records days only. A note id, title, screen, action or duration would be a privacy-policy change and needs a new ADR.
  - Every per-user metric excludes through `metrics_excluded_user_ids()`. Don't re-state the rule.
  - The metric functions read `auth.users` through three columns only (`id`, `created_at`, `raw_app_meta_data`), the ones the migration grants to `service_role`. Reading another column (`email`) fails with permission denied where `service_role` has no table-wide grant. When the migration couldn't grant these columns, see [If sign-ups and activation fail with permission denied](#if-sign-ups-and-activation-fail-with-permission-denied).
  - No function returns note text, titles or notebook names.
- Files that must change together:
  - A new editor content shape → `note_text_chars` (a new migration) and its PGlite test, alongside `extract_text_from_jsonb` and `packages/shared/src/editor/extract-text.ts`.
  - A new client tag (ADR-0023) → `ACTIVE_CLIENT_COLUMNS` in `scripts/user-stats.mjs`, which the writers table's `CLIENT_COLUMNS` extends with `untagged` (unknown tags still print, after the known ones). If it should count as an activity day too: `DRAFTO_CLIENT_TAGS`, then a new migration for the `usage_daily_client_check` constraint, `record_activity`'s tag check and the rollup's tag order, and the privacy policy's list of device kinds.
  - What `usage_daily` records, or its 13-month retention → `apps/web/src/app/privacy/page.tsx` and `apps/web/__tests__/integration/legal-pages.test.tsx` ([privacy policy](./privacy-policy.md)), and ADR-0078.
  - A changed definition → the function (in a new migration), this doc's table, the PGlite test and the live test.
- A new or changed function reaches dev only once the migration is pushed there, so run the live test after `pnpm supabase:push`.

## Verify

```bash
(cd scripts && node --test __tests__/note-text-chars.test.mjs __tests__/product-metrics.test.mjs __tests__/usage-daily.test.mjs __tests__/user-stats.test.mjs)
pnpm --filter=@drafto/shared test
pnpm migration:check

# Operator, interactive session, after the migrations reach dev:
pnpm test:live:supabase -- --only metrics
pnpm test:live:supabase -- --only usage-daily
pnpm users:stats -- --project dev
```
