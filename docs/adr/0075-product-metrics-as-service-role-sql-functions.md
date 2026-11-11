# 0075 — Product Metrics as Service-Role SQL Functions

- **Status**: Accepted
- **Date**: 2026-11-12
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

Until now, the only way to know how Drafto is used was a one-off script against the database. A check on Nov 11 found two traps that any metric has to avoid:

- **Test accounts swamp the totals.** On prod, `e2e-test@drafto.eu` and `googleplay-test@drafto.eu` own 440 of the 453 notebooks.
- **`notes.updated_at` is not a write signal.** Title, trash and notebook changes move it too. On Oct 31, six notes got a new `updated_at` in the same minute with no content change. The per-overwrite log `note_content_history` ([ADR-0022](./0022-note-content-history.md)), with its `archived_at` and `archived_by` client tag ([ADR-0023](./0023-per-request-client-tagging.md)), is the reliable record of writes.

The product-metrics rollout has four steps, and three of them read the same numbers: a terminal command (this step), an `/admin/stats` page (step 3) and a Monday email (step 4). If each computed its own, the definitions would drift, and each would have to relearn both traps.

## Decision

Compute every product metric inside Postgres, as SQL functions, and have every caller read them.

- **Six metric functions and four helpers** in `public`: `metrics_signups`, `metrics_activation`, `metrics_writers`, `metrics_emptied_notes`, `metrics_depth`, `metrics_platform_limits`; `note_text_chars`, `metrics_excluded_user_ids`, `metrics_week_starts`, `metrics_write_events`. Definitions: [`docs/features/product-metrics.md`](../features/product-metrics.md).
- **Service role only.** Each function revokes `execute` from `public`, `anon` and `authenticated` and grants it to `service_role`. They are `SECURITY INVOKER` with a pinned `search_path`: `service_role` already bypasses RLS, so `SECURITY DEFINER` would add privilege for nothing.
- **Exclusion via `is_admin` plus a table.** Every per-user metric leaves out admins (`profiles.is_admin`) and the users in a new table `public.metrics_excluded_users`, seeded by email with the shared test and store-review accounts. The rule lives once, in `metrics_excluded_user_ids()`. The table has RLS on, no policies, and grants to `service_role` only.
- **`auth.users` through three columns.** The sign-up metrics read `auth.users` as `service_role`, so the migration grants `select (id, created_at, raw_app_meta_data)` to it. Where the migration role can't grant that, the migration warns instead of failing, and the dev live test reports the gap.
- **Writes come from `note_content_history`**, plus new notes whose first version holds 50 or more characters. Text length comes from `note_text_chars`, the summed length of every string `text` key in the editor JSON.
- **Metadata only.** No function returns note text, titles or notebook names.
- **`pnpm users:stats`** (`scripts/user-stats.mjs`) is a thin read-only client. It calls each function with `GET /rest/v1/rpc/<name>`, which PostgREST runs in a read-only transaction, using the service-role key from the keys file `pnpm users:delete` reads, through a shared helper. Like `users:delete`, it is for interactive sessions only.

## Consequences

- **Positive**:
  - One definition per metric, in SQL, versioned with the schema. The admin page and the email call the same functions.
  - Test accounts and admins are out of every number by default, and an operator can exclude another account with one row.
  - The database enforces both the read-only use (`STABLE` functions over read-only GET requests) and who may call them.
  - The SQL runs in CI: PGlite executes both migrations verbatim, over stand-in tables with backdated data. A dev live test (`pnpm test:live:supabase -- --only metrics`) checks the real project, including the permissions.
- **Negative**:
  - The metrics inherit the history's 30-day retention. Older weeks become lower bounds (`activated` turns null), and a note's first version can only be known while its oldest overwrite is kept.
  - Inserts carry no client tag, so writers known only from new notes, including notes created offline on mobile or desktop, count as `untagged`.
  - Activation dates a note's versions by `updated_at` (the current one) and `content_updated_at` (the overwritten ones), as its definition says. Both also move on renames, notebook moves and trash changes, so a later non-content change can add a second activation day or push a version out of the 14-day window. Writers and depth don't depend on `updated_at`.
  - The functions read every note and history row on each call (`note_text_chars` per version). That's bounded by the retention and today's data size, and the callers are on-demand or weekly; a materialised table would be the next step if it gets slow.
  - `@electric-sql/pglite` becomes a root dev dependency, for the SQL unit tests only.
- **Neutral**:
  - Ten more functions in the exposed `public` schema. PostgREST lists them, but only `service_role` can execute them.
  - `metrics_emptied_notes` takes an optional `p_as_of`, so a test can move the 24-hour cutoff without backdating a save.

## Alternatives Considered

- **Compute in each caller (script, API route, email job).** Rejected: three copies of every definition and of both traps, drifting apart.
- **`SECURITY DEFINER` functions callable by admins' sessions.** Rejected: the callers already hold the service-role key, and a definer function that admins' JWTs can reach is a larger surface than an invoker function only the service role can run.
- **A view per metric.** Views can't take the time window as a parameter, and a view in `public` needs `security_invoker` and grants of its own ([ADR-0052](./0052-explicit-data-api-grants.md)); functions express the windows directly.
- **Excluding by email pattern (`@drafto.eu`) instead of a table.** Rejected: the operator's own and family accounts aren't test accounts, and the repo is public, so personal addresses can't go in a migration. A table seeded with the shared test accounts and extended by user id avoids both.
- **Counting writes from `notes.updated_at`.** Rejected: it moves on title, trash and notebook changes (the Oct 31 trap).
