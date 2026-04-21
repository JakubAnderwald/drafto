# Offline Sync

**Status:** shipped  **Updated:** 2026-04-21

## What it is

Mobile and desktop clients store notebooks, notes, and attachments in a local
SQLite database and reconcile with Supabase on an opportunistic schedule so the
app remains fully functional without a network connection.

## Current state

Shipped on iOS, Android, and macOS. The web app is not part of this sync loop —
it reads and writes Supabase directly. Mobile and desktop share the same
WatermelonDB schema (version 2), the same row mappers, and the same
`synchronize()` driver, so sync behavior is identical on all three native
platforms. Sync is triggered on login, app-foreground, network reconnect, and
every 30 s when there are pending changes; attachment uploads are processed
before metadata is pushed.

## Code paths

| Concern                              | Path                                                         |
| ------------------------------------ | ------------------------------------------------------------ |
| Mobile schema (version 2)            | `apps/mobile/src/db/schema.ts`                               |
| Mobile migrations                    | `apps/mobile/src/db/migrations.ts`                           |
| Mobile WatermelonDB instance         | `apps/mobile/src/db/index.ts`                                |
| Mobile models                        | `apps/mobile/src/db/models/{notebook,note,attachment}.ts`    |
| Mobile sync driver (pull / push)     | `apps/mobile/src/db/sync.ts`                                 |
| Mobile sync orchestration + triggers | `apps/mobile/src/providers/database-provider.tsx`            |
| Mobile attachment upload queue       | `apps/mobile/src/lib/data/attachment-queue.ts`               |
| Desktop schema (must match mobile)   | `apps/desktop/src/db/schema.ts`                              |
| Desktop migrations                   | `apps/desktop/src/db/migrations.ts`                          |
| Desktop WatermelonDB instance        | `apps/desktop/src/db/index.ts`                               |
| Desktop models                       | `apps/desktop/src/db/models/{notebook,note,attachment}.ts`   |
| Desktop sync driver                  | `apps/desktop/src/db/sync.ts`                                |
| Desktop sync orchestration           | `apps/desktop/src/providers/database-provider.tsx`           |
| Desktop attachment upload queue      | `apps/desktop/src/lib/data/attachment-queue.ts`              |
| Supabase tables (source of truth)    | `supabase/migrations/*notebooks*`, `*notes*`, `*attachments*` |
| Server timestamp RPC                 | `get_server_time` Supabase function                          |
| Sync driver tests                    | `apps/desktop/__tests__/db/sync.test.ts`, `sync-mappers.test.ts` |
| Schema / migration tests             | `apps/desktop/__tests__/db/{schema,migrations,models}.test.ts` |
| Sync UI + perf tests                 | `apps/mobile/__tests__/components/sync-status.test.tsx`, `apps/mobile/__tests__/performance/sync-perf.test.ts` |

## Related ADRs

- [0009 — Mobile App Technology Choices](../adr/0009-mobile-app-technology-choices.md)
- [0010 — Offline Sync Strategy with WatermelonDB](../adr/0010-offline-sync-strategy.md)
- [0015 — Desktop App Technology Choice](../adr/0015-desktop-app-technology-choice.md)

## Cross-platform notes

There is no true shared package for the sync layer — `apps/mobile/src/db/` and
`apps/desktop/src/db/` are parallel copies that must stay byte-for-byte
equivalent. Per `CLAUDE.md`, any change to schema, models, or sync on one side
must be mirrored on the other in the same PR. Web is out of scope: Next.js talks
to Supabase directly through `apps/web/src/lib/supabase/`, so the only
server-side sync contract is Postgres itself (no dedicated `/api/sync` route
exists).

Shared type source is `@drafto/shared` (`packages/shared/src/types/supabase.ts`)
— both sync drivers import `Database["public"]["Tables"]["<table>"]["Row"]` from
it, so regenerating the Supabase types automatically propagates to both clients.

## Modifying safely

**Sync contract invariants:**

- Pull uses `updated_at > lastPulledAt` for notebooks and notes, and
  `created_at > lastPulledAt` for attachments (attachments are immutable — no
  update path).
- The pull timestamp comes from Supabase (`get_server_time` RPC); never use
  client `Date.now()` unless the RPC fails (then fall back to `Date.now() - 5s`).
- First sync (no `lastPulledAt`) sends every row as `created`; subsequent syncs
  send every row as `updated` — WatermelonDB auto-creates missing locals.
- Push order: notebooks -> notes -> attachments (notes depend on notebooks;
  attachments on notes).
- Attachments only push when `upload_status === "uploaded"`; pending blobs stay
  queued until `processPendingUploads()` finishes.
- Note `content` is a JSON column on Supabase and a stringified JSON column in
  WatermelonDB — round-trip with `JSON.parse` / `JSON.stringify` on every hop.

**Conflict resolution (server-wins, per ADR 0010):**

- The `conflictResolver` callback in `syncDatabase()` returns the `resolved`
  record WatermelonDB hands it (which already prefers the remote fields) and
  increments `conflictCount`.
- `conflictCount > 0` surfaces a toast ("A note was updated from another
  device") — do not silently discard this counter.
- Soft-delete only: trashing a note flips `is_trashed` / `trashed_at`; hard
  delete via `DELETE FROM notes` is reserved for attachments and purged notes.

**Schema-migration rules:**

- Bump `schema.version` in **both** `apps/mobile/src/db/schema.ts` and
  `apps/desktop/src/db/schema.ts` in lockstep.
- Add a matching step block to **both** `migrations.ts` files with the same
  `toVersion`.
- Add or update the corresponding Supabase migration under `supabase/migrations/`
  so the server row shape still matches what the mappers expect.
- Never remove a column in a single release — downlevel clients will crash when
  they receive an unknown field. Add in one release, stop reading in the next,
  drop one after.

**Tests that catch regressions:**

- `apps/desktop/__tests__/db/sync.test.ts` — pull + push round-trip, conflict
  counter, first-sync vs. incremental.
- `apps/desktop/__tests__/db/sync-mappers.test.ts` — column mapping drift.
- `apps/desktop/__tests__/db/{schema,migrations,models}.test.ts` — structural
  checks; these fail fast when the two schemas drift.
- `apps/mobile/__tests__/performance/sync-perf.test.ts` — guards sync runtime
  on large datasets.
- `apps/mobile/__tests__/components/sync-status.test.tsx` and the matching
  desktop file — guard the UI affordances (pending badge, last-synced, toast).

**Files that must change together:**

- `apps/mobile/src/db/{schema,migrations,sync}.ts`
- `apps/desktop/src/db/{schema,migrations,sync}.ts`
- `supabase/migrations/*` (when columns change)
- `packages/shared/src/types/supabase.ts` (regenerated types)

## Verify

```bash
cd apps/mobile && pnpm test
cd apps/desktop && pnpm test
cd packages/shared && pnpm test
pnpm migration:check
pnpm typecheck
```

For a live round-trip: run the mobile dev client against the dev Supabase
project, create a note offline (airplane mode), re-enable network, and confirm
the note appears on the web app at the same timestamp.
