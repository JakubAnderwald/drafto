# Product metrics

**Status:** shipped (step 1 of 4) **Updated:** 2026-11-12

## What it is

Drafto's own usage numbers (sign-ups, activation, weekly writers, silently emptied notes, depth of use and the Supabase Free plan limits) computed inside Postgres as SQL functions that only the service role can call. `pnpm users:stats` prints them in the terminal. Later steps of the rollout reuse the same functions: the `/admin/stats` page (step 3) and a Monday email (step 4). Every caller reads the same SQL, so no caller re-implements a definition.

The functions work from metadata only: timestamps, character counts and client tags. None of them returns note text, titles or notebook names.

## Current state

- Two migrations: `note_text_chars(jsonb)`, then the exclusion table, three helpers and the six metric functions.
- `scripts/user-stats.mjs` (`pnpm users:stats`) calls the six metric functions read-only and prints one table per metric, or JSON.
- Weekly active users and retention are not here yet. They need the `usage_daily` table from step 2.

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

## Definitions

Shared terms:

- **Text characters**: `note_text_chars(content)`, the summed `char_length` of every string-valued `text` key anywhere in the editor JSON (BlockNote blocks, nested `children`, links, table cells, TipTap nodes). Ids, props, styles, marks and URLs don't count. Null content is 0.
- **A version** of a note: each overwritten version in `note_content_history` (its `content`, saved at `content_updated_at`) and the note's current `content` (saved at `updated_at`).
- **A write**, from `metrics_write_events(p_from, p_to)`:
  - a content overwrite: a `note_content_history` row, at its `archived_at`, by its `archived_by` client tag ([ADR-0023](../adr/0023-per-request-client-tagging.md)). Any size counts.
  - a new note whose first version holds 50 or more characters, at its `created_at`. The first version is the note's oldest history row, or its current content when it was never overwritten. Inserts carry no client tag, so these count as `untagged`, including notes created offline on mobile or desktop and pushed by sync.
- **Untagged**: a write with no `x-drafto-client` tag.
- **Weeks** are ISO weeks, Monday 00:00 UTC to the next Monday. Days are UTC dates.
- **MB** is 1024 × 1024 bytes and GB is 1024³ bytes.

Writes (`metrics_write_events`, behind writers and depth) never come from `notes.updated_at`: title, trash and notebook changes move it too, and on Oct 31 six notes got a new `updated_at` in the same minute with no content change. Activation is the exception, by its definition: it dates a note's current version by `updated_at` (see Caveats).

| Function                                    | Returns                                                                                                                                                                        | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics_signups(p_weeks)`                  | per week: `week_start`, `iso_week`, `signups`, `by_provider` (jsonb)                                                                                                           | New accounts (`auth.users.created_at`) per week for the last `p_weeks` weeks, this one included, split by `raw_app_meta_data->>'provider'` (`email`, `google`, `apple`, …; `unknown` when missing). Weeks with none show 0.                                                                                                                                                                                                                                                                                     |
| `metrics_activation(p_weeks)`               | per sign-up-week cohort: `week_start`, `iso_week`, `signed_up`, `first_value`, `activated`, `window_complete`                                                                  | **First value**: a version of 50+ characters saved within 14 days of sign-up. **Activated** (Drafto's one activation definition, decided Nov 11): such versions saved on 2+ distinct UTC days within those 14 days. `activated` is `null` once the cohort's last window (week start + 21 days) ended more than 30 days ago, beyond the history retention. `window_complete` is false while a member's window is still open, so the counts can still grow.                                                       |
| `metrics_writers(p_weeks)`                  | per week: `week_start`, `iso_week`, `writers`, `by_client` (jsonb), `history_complete`                                                                                         | Distinct users with a write in the week, and the same count per client tag (`web`, `mobile-ios`, `mobile-android`, `desktop-macos`, `web-mcp`, `untagged`, and any other tag seen). A user who wrote from two clients counts once in `writers` and once under each client. `history_complete` is false for weeks that started more than 30 days ago.                                                                                                                                                            |
| `metrics_emptied_notes(p_since[, p_as_of])` | per note: `note_id`, `user_id`, `emptied_at`, `client`, `chars_before`                                                                                                         | The silent-emptying detector. A note is listed when it isn't trashed, its current text is 0 characters, and its last version with any text held 200+ characters. The save that replaced that version emptied it: `emptied_at` is that history row's `archived_at`, `client` its `archived_by` (`untagged` when null), `chars_before` its size. Every version since has had no text. Listed once that save is at least 24 hours old and happened at or after `p_since`. A refilled or trashed note isn't listed. |
| `metrics_depth()`                           | one row: `writers`, the median and maximum of live notes, notebooks and attachment MB, and `pct_with_attachment`, `pct_with_api_key`, `pct_with_mcp_write`, `pct_multi_client` | Over users with a write in the last 30 days: live (untrashed) notes, notebooks, and attachment MB (`attachments.file_size`), each as median and maximum. Then the percentage of them with any attachment, with an unrevoked API key, with a `web-mcp` overwrite, and with overwrites from 2 or more tagged clients. With no writers, the medians and percentages are null.                                                                                                                                      |
| `metrics_platform_limits()`                 | per resource: `resource`, `used_bytes`, `limit_bytes`, `pct`, `level`                                                                                                          | `database`: `pg_database_size(current_database())` against 500 MB. `storage`: the summed `metadata->>'size'` of `storage.objects` in the `attachments` bucket against 1 GB. Levels: `ok` below 70%, `warn` from 70%, `critical` from 85%. The limits are constants in the function, from [Supabase pricing](https://supabase.com/pricing). Project-wide, so nobody is excluded.                                                                                                                                 |

Helpers, also service-role only: `note_text_chars(content)`, `metrics_excluded_user_ids()`, `metrics_week_starts(p_weeks)` (rejects `p_weeks` outside 1–520 with `22023`) and `metrics_write_events(p_from, p_to)`.

`metrics_emptied_notes` takes `p_as_of` (default `now()`) only so a test can move the 24-hour cutoff: history rows come from a trigger at `now()`, so a test can't backdate an emptying save. Callers leave it out. The note's state is always read as of now.

### Caveats

- **History is kept 30 days** (`cleanup_note_content_history`, [ADR-0022](../adr/0022-note-content-history.md)). For older weeks, overwrites are gone: `activated` turns null, and `writers` and `first_value` become lower bounds (`history_complete` marks the weekly rows). A cohort 30 to 51 days old can still show a lower bound for `activated`, because versions saved early in its window may already be purged. The emptying detector can't see a note whose last version with text was archived more than 30 days ago.
- **Activation dates versions by `updated_at`, which isn't only a content save.** A note's current version is dated by `notes.updated_at`, and a history version by `content_updated_at`, the overwritten row's `updated_at`. A rename, a notebook move, trashing or restoring all move `updated_at`. So such a change on a later day inside the 14 days adds a second activation day (an overcount: a user who wrote on one day can count as activated), and one after the 14 days moves the current version out of the window (an undercount of first value and activation). A bulk touch like Oct 31's would mark every cohort member with a 50+ character note as activated. This follows the issue's definition of a version; dating versions by `archived_at` instead would be a definition change. Writers and depth count on `archived_at` and `created_at` and aren't affected.
- **"Still empty" means now**: a note emptied and later refilled, even after 24 hours, isn't listed.
- **Storage objects without a numeric `metadata.size`** count as 0.

## Running `pnpm users:stats`

From an interactive session on a machine with `~/drafto-secrets/supabase service keys.txt` (the `PROD:` / `DEV:` lines `pnpm users:delete` also reads):

```bash
pnpm users:stats -- --project prod             # the last 8 ISO weeks, as tables
pnpm users:stats -- --project prod --weeks 12  # 1 to 104 weeks
pnpm users:stats -- --project dev --json       # one JSON object
pnpm users:stats -- --project prod --keys-txt <file>
```

- **Read-only.** It calls each function with `GET /rest/v1/rpc/<name>`, which PostgREST runs in a read-only transaction, and every function is `STABLE`, so the database refuses a write even if one were attempted.
- **The key is never printed.** It travels in request headers only; any error text is masked.
- **Interactive sessions only.** It refuses `DRAFTO_UNATTENDED` (factory, support, nightly, the verification lane) and `node --test` before reading any key file, and the verification lane's guard denies any command naming it.
- `--weeks` sets the weekly tables' range, and the emptied-notes check looks back as far.
- One failing metric doesn't hide the others. The run prints them and exits 1.
- PostgREST caps every response at the project's `max_rows` (1000 by default), stored procedures included, without saying so. Each call asks for the exact count (`Prefer: count=exact`), and a list shorter than its count fails instead of printing part of it. In practice only the emptied notes can grow that long. Rerun with a smaller `--weeks`.
- Exit codes: 0 when every metric was read, 1 on a failure or refusal, 2 on bad arguments.

## If sign-ups and activation fail with permission denied

`metrics_signups` and `metrics_activation` read `auth.users` as `service_role`, so the migration grants it `select (id, created_at, raw_app_meta_data)` on that table. Where the migration's role can't make that grant, the migration doesn't fail. It warns `product metrics: service_role cannot read auth.users …` and points here. Those two functions then fail with `permission denied` (`42501`), in `pnpm users:stats` and in `pnpm test:live:supabase -- --only metrics`. The other four metrics still work.

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

| Concern                                                | Path                                                     |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `note_text_chars`                                      | `supabase/migrations/20261111000001_note_text_chars.sql` |
| Exclusion table, helpers, the six metrics, permissions | `supabase/migrations/20261111000002_product_metrics.sql` |
| CLI (`pnpm users:stats`)                               | `scripts/user-stats.mjs`                                 |
| Service-role key reader shared with `users:delete`     | `scripts/lib/service-keys-txt.mjs`                       |
| Operator-only guard for the verification lane          | `scripts/lib/verify-guard.mjs`                           |
| Unit: `note_text_chars` in PGlite                      | `scripts/__tests__/note-text-chars.test.mjs`             |
| Unit: every metric in PGlite, with backdated data      | `scripts/__tests__/product-metrics.test.mjs`             |
| Unit: the CLI, with a faked fetch                      | `scripts/__tests__/user-stats.test.mjs`                  |
| Dev live test (`--only metrics`)                       | `scripts/__tests__/product-metrics.live.test.mjs`        |

## Related ADRs

- [0075 — Product Metrics as Service-Role SQL Functions](../adr/0075-product-metrics-as-service-role-sql-functions.md)
- [0022 — Note Content History](../adr/0022-note-content-history.md) (the source of writes, and its 30-day retention)
- [0023 — Per-Request Client Tagging](../adr/0023-per-request-client-tagging.md) (the `archived_by` client tags)
- [0052 — Explicit Data API Grants](../adr/0052-explicit-data-api-grants.md)

## Cross-platform notes

None. The metrics read the server tables every platform writes to. They see a native client's write once sync pushes it: an overwrite is tagged `mobile-ios`, `mobile-android` or `desktop-macos`, and a note created offline arrives as an insert, counted as `untagged`.

## Modifying safely

- Invariants:
  - Every function is `SECURITY INVOKER`, `set search_path = public, pg_catalog`, `STABLE` (`note_text_chars` is `IMMUTABLE`), and revokes `execute` from `public`, `anon` and `authenticated`, granting it to `service_role` only. A new function does the same, in the migration that creates it. `scripts/__tests__/product-metrics.test.mjs` fails on any public function it doesn't list.
  - Every per-user metric excludes through `metrics_excluded_user_ids()`. Don't re-state the rule.
  - The functions read `auth.users` through three columns only (`id`, `created_at`, `raw_app_meta_data`), the ones the migration grants to `service_role`. Reading another column (`email`) fails with permission denied where `service_role` has no table-wide grant. When the migration couldn't grant these columns, see [If sign-ups and activation fail with permission denied](#if-sign-ups-and-activation-fail-with-permission-denied).
  - No function returns note text, titles or notebook names.
- Files that must change together:
  - A new editor content shape → `note_text_chars` (a new migration) and its PGlite test, alongside `extract_text_from_jsonb` and `packages/shared/src/editor/extract-text.ts`.
  - A new client tag (ADR-0023) → `CLIENT_COLUMNS` in `scripts/user-stats.mjs` (unknown tags still print, after the known ones).
  - A changed definition → the function (in a new migration), this doc's table, the PGlite test and the live test.
- A new or changed function reaches dev only once the migration is pushed there, so run the live test after `pnpm supabase:push`.

## Verify

```bash
(cd scripts && node --test __tests__/note-text-chars.test.mjs __tests__/product-metrics.test.mjs __tests__/user-stats.test.mjs)
pnpm migration:check

# Operator, interactive session, after the migrations reach dev:
pnpm test:live:supabase -- --only metrics
pnpm users:stats -- --project dev
```
