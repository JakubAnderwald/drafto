# 0023 — Per-Request Client Tagging

- **Status**: Accepted
- **Date**: 2026-04-27
- **Authors**: Jakub Anderwald

## Context

The 2026-04-24 incident (PR #323) and a recurrence on 2026-04-27 both produced the same byte signature in `notes.content` — the empty BlockNote document `[{"type":"paragraph","content":[],"children":[]}]` (~50 bytes) overwriting real user content. The recovery infrastructure from ADR 0022 (`note_content_history` + `scripts/recover-from-wal.py`) is doing its job — both incidents were recovered — but `note_content_history.archived_by` was `NULL` on every row in both cases, so there was no record of which client emitted the bad write.

ADR 0022 anticipated this: `archived_by` is filled from `current_setting('app.client', true)` and is "best-effort … clients aren't required to set it." Until clients do set it, every recovery starts from "we know a client did this, but we don't know which one."

This ADR closes that gap. It defines the tagging mechanism, the canonical tag values, and the deployment expectation: **all** Supabase-writing clients tag themselves. Half-coverage is worse than no coverage — a `NULL` becomes ambiguous (uncovered client vs. tagged client that misfired the SET) and rules nothing in.

## Decision

Adopt per-request tagging via PostgREST's `db_pre_request` hook, driven by a custom HTTP header that every Supabase client sets in its factory config.

### Mechanism

1. **HTTP header** — every `createClient(...)` call passes `global: { headers: { 'x-drafto-client': '<tag>' } }`. The header rides every request the client makes (REST + RPC + Realtime). For WatermelonDB-driven syncs, the same client instance is reused, so sync writes get tagged automatically.
2. **`pre_request` plpgsql function** (`public.set_request_app_client`) — reads `request.headers->>'x-drafto-client'` and copies it into the transaction-local GUC `app.client` via `set_config(..., true)`. Returns void.
3. **Authenticator role config** — `ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.set_request_app_client'` plus `NOTIFY pgrst, 'reload config'` ships in the same migration so PostgREST picks it up without a dashboard step.
4. **Existing trigger reads it as before** — `archive_note_content()` (from ADR 0022) already calls `nullif(current_setting('app.client', true), '')`. No trigger change required.

### Canonical tag values

| Tag               | Source                                                             |
| ----------------- | ------------------------------------------------------------------ |
| `web`             | Browser/server clients in `apps/web` (user-driven)                 |
| `web-cron`        | Vercel cron routes (`/api/cron/*`)                                 |
| `web-mcp`         | MCP server in `apps/web/src/lib/api/mcp-auth.ts`                   |
| `web-admin`       | Service-role admin client in `apps/web/src/lib/supabase/admin.ts`  |
| `desktop-macos`   | `apps/desktop/src/lib/supabase.ts`                                 |
| `mobile-ios`      | `apps/mobile/src/lib/supabase.ts` when `Platform.OS === 'ios'`     |
| `mobile-android`  | `apps/mobile/src/lib/supabase.ts` when `Platform.OS === 'android'` |
| `script-backfill` | `scripts/backfill-inline-attachments.ts`                           |

Values are deliberately stable strings — the next incident will be `grep`-driven, not parsed. Sub-distinctions (e.g. `desktop-macos-beta-26`) are out of scope; build version is already in Sentry/PostHog when needed.

### Migration scope

One migration adds the `pre_request` function and configures the role. No existing data is touched. The only behavioral change visible outside this ADR is that `note_content_history.archived_by` will now contain a value on every new row.

## Consequences

**Positive**

- Every future content overwrite is attributable to a specific client class. The next "the desktop app erased my note again" report starts with `select archived_by from note_content_history where note_id = ...` rather than a code audit across 4 platforms.
- Distinguishing user-driven writes (`web`) from automated writes (`web-cron`, `web-mcp`, `web-admin`, `script-*`) makes a service-role-key bug visually distinct from a UI bug in `archived_by`.
- Implementation is one migration plus six client-factory edits — no schema changes, no app-code refactoring, no client-side state to manage.

**Negative**

- Adds one plpgsql function call per PostgREST request. The function is a single `set_config` call; cost is negligible, but it does run on every API hit (including reads).
- A client that fails to set the header silently emits `NULL` rather than an error. We accept this — emitting an error would block legitimate writes for an observability nicety, which is the wrong trade. The `NULL` itself becomes a signal ("untagged client") once full coverage ships.
- `pgrst.db_pre_request` is a singleton — if a future feature wants its own pre-request hook, it has to compose with `set_request_app_client` rather than replace it. Acceptable for now; revisit if and when that constraint binds.

**Neutral**

- The header `x-drafto-client` is visible to anyone inspecting network traffic from a user's browser/device. It carries no secret information; it is purely descriptive. Spoofing it would let a malicious client tag itself as `web-cron`, but that doesn't grant any privilege — RLS and service-role auth are still the actual security boundary.
- Service-role keys keep working unchanged; the header rides alongside the existing `Authorization: Bearer <key>`.

## Alternatives Considered

- **JWT claim instead of header.** Would require minting custom JWTs from each client, conflicts with Supabase's auth flow, and doesn't cover service-role calls (which use a flat key, not a JWT). Rejected.
- **RPC-only writes.** Wrap every `notes` UPDATE in an RPC that takes a `client_tag` argument. Forces a refactor of every write site, including WatermelonDB sync. Rejected as disproportionate to the goal.
- **Sentry / PostHog as the source of truth.** Both already attribute events to clients, but only when the client is online and the SDK fired. The trigger captures every overwrite, including ones from offline-then-sync paths and from server-side jobs that don't run a frontend SDK. Database-level attribution is the right layer.
- **Tag per-build (e.g. `desktop-macos-0.3.1-26`).** Useful, but build version is already correlated via Sentry release + commit timestamps when an incident is being investigated. Adding it to `archived_by` increases churn (every release flips the tag, complicating `grep`) without adding investigative power. Rejected for now; the table is one migration away from supporting it later.
- **Stricter `NOT NULL` on `archived_by` once coverage lands.** Would surface untagged clients loudly. Rejected because the `archive_note_content()` trigger is `SECURITY DEFINER` and runs from contexts (manual SQL editor, future migrations, support scripts) where setting the header isn't always feasible. Soft `NULL` semantics are more honest.

## Related

- [ADR 0022 — Note Content History Table](./0022-note-content-history.md) — defines `archived_by`, anticipated this ADR
- [`supabase/migrations/20260425000001_note_content_history.sql`](../../supabase/migrations/20260425000001_note_content_history.sql) — trigger that reads `app.client`
- PostgREST `db_pre_request` configuration: https://postgrest.org/en/stable/references/configuration.html#db-pre-request
