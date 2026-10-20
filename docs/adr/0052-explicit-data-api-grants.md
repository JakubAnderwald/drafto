# 0052 — Explicit Data API Grants in Migrations

- **Status**: Accepted
- **Date**: 2026-10-20
- **Authors**: Jakub Anderwald, with Claude Code

## Context

Supabase changes its Data API defaults for existing projects on **2026-10-30** ([discussion #45329](https://github.com/orgs/supabase/discussions/45329)). Until then, every new table in `public` is automatically granted to `anon`, `authenticated` and `service_role` through `ALTER DEFAULT PRIVILEGES`. After the cutover those default privileges are revoked, so a new table gets no grants, and supabase-js, PostgREST and Realtime return `permission denied` until a migration grants them explicitly. Tables that already exist keep the grants they got when they were created.

For Drafto that means:

- **Live prod and dev don't break.** All six tables (`profiles`, `notebooks`, `notes`, `attachments`, `api_keys`, `note_content_history`) predate the cutover and hold `ALL` for all three roles. Keys are `uuid`, so there are no sequences, and there are no views. RPCs keep working because `EXECUTE` for `PUBLIC` is a Postgres default that Supabase isn't changing.
- **Every future table would ship broken.** No migration, doc, agent prompt or check mentioned grants. The dark factory writes migrations unattended, so it is the most likely author of a table that no client can reach.
- **A replay of the migrations would produce an unreachable app.** None of the 16 migrations had a `GRANT`. Replaying them into a fresh database (`supabase db reset --linked` on dev, the documented dev recovery path; a new project; disaster recovery) would re-create all six tables without grants. Prod is on the Free tier with no backups or PITR, so a migration replay is the realistic way to rebuild it.

Today's access model (from the call sites): `authenticated` uses the web session clients, mobile/desktop sync and Realtime on `notes`. `service_role` uses `createAdminClient`, the MCP route and `scripts/migration-stats.mjs`. `anon` never touches a table directly; signed out, the only call is the `SECURITY DEFINER` RPC `cleanup_trashed_notes`.

## Decision

1. **Grants live in the migration that creates the table or view**, next to its RLS, and grant only what the table needs. The common case is `select, insert, update, delete` to `authenticated, service_role`. A table written only by `SECURITY DEFINER` code gets `select`. `anon` gets a grant only when there is a real signed-out read path. RLS stays the row-level guard; a grant only lets the Data API reach the table. Views must also be `security_invoker = true`, because a default view runs as its owner and would bypass RLS. Materialized views stay off the API.
2. **A catch-up migration, [`20261020000001_explicit_data_api_grants.sql`](../../supabase/migrations/20261020000001_explicit_data_api_grants.sql), grants the six existing tables explicitly.** It only grants and revokes nothing, so it changes nothing on prod and dev, which already hold `ALL`. It makes a replayed database hold what the app needs. `profiles` gets `select, update` for `authenticated`: rows come from the `handle_new_user` definer trigger, and no policy lets a user insert or delete one. `UPDATE` stays table-wide because admins approve users through their own session. Stopping users from setting their own `is_admin` / `is_approved` is a separate fix, a guard trigger (#457), which needs exactly this table-level `UPDATE`.
3. **`pnpm migration:check` enforces the rule.** [`scripts/lib/check-migration-grants.awk`](../../scripts/lib/check-migration-grants.awk), called from [`scripts/check-migration-safety.sh`](../../scripts/check-migration-safety.sh), replays the checked migrations in file-name (apply) order. It lexes out comments, strings and dollar-quoted bodies, and tracks per object which API roles hold a grant. It reports:
   - a `public` table or view that ends with no `GRANT` to `authenticated` or `service_role`. A grant counts only after the `create`; `revoke all` and `drop` take access away again; `create or replace` and `if not exists` keep it.
   - a view without `security_invoker`
   - a `serial` column, whose sequence would need a grant of its own

   `-- safety:ignore` in a `create` statement marks a table deliberately kept off the Data API. CI already runs the check, and so does the factory for schema changes.

The convention lives in [`docs/operations/migrations.md`](../operations/migrations.md#new-tables-need-explicit-grants), CLAUDE.md and the factory's implement and revision prompts.

## Consequences

- **Positive**: New tables can't silently ship unreachable, because CI and the factory catch a missing grant before merge. A replay of the migrations yields a working app, so the dev reset and disaster-recovery paths stay viable. Every table's privileges are written down in the migration that creates it. The view rule closes the easy mistake of fixing a missing grant by exposing a view that bypasses RLS.
- **Negative**: Every table migration needs a few more lines. The check matches patterns and doesn't run SQL (see ADR 0008), so DDL issued from a `DO $$ … $$` block or through dynamic SQL goes unseen. Partial revokes (`revoke update …`) are not tracked.
- **Neutral**: Prod and dev keep the broader privileges Supabase granted before the cutover (`anon`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, and `insert` / `delete` on `profiles`), so a replayed database is stricter than prod. Tightening prod to match would be a separate, deliberate change.

## Alternatives Considered

1. **Restore the old defaults** with `alter default privileges … grant … on tables to anon, authenticated, service_role` in a migration. One line, and nothing else changes. Rejected: it exposes every future table to `anon` again, which is the posture Supabase is moving away from. It also hides each table's access model instead of documenting it.
2. **Add grants by editing the original migrations.** Rejected: those migrations are already applied to prod and dev, and rewriting applied history makes the files disagree with what ran.
3. **Replay the migrations in CI** (a Supabase or Postgres service container with the Supabase roles) and assert `has_table_privilege` for every relation in `public`. This checks the real outcome rather than patterns, and it would catch the `DO`-block blind spot. Not adopted for now: it adds a Docker-based job to every PR, and the default privileges must first match the post-cutover platform (the CLI's `auto_expose_new_tables` switch is itself being removed at the cutover). It is the natural next step if the pattern check proves leaky.
4. **Rely on review and docs only, without a check.** Rejected: the factory authors migrations unattended, and a missing grant only surfaces at runtime as `permission denied`, on every platform at once.
5. **Set `auto_expose_new_tables = false` in `supabase/config.toml`** to mirror the change locally. Rejected: it requires a newer CLI (≥ 2.102), Supabase is removing the key at the cutover, and nothing in Drafto runs the local Supabase stack.

## Related

- [ADR 0001: Data Model and RLS Strategy](./0001-data-model-and-rls-strategy.md)
- [ADR 0008: Production Data Safety Guardrails](./0008-production-data-safety-guardrails.md)
