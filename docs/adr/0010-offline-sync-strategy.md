# 0010 — Offline Sync Strategy with WatermelonDB

- **Status**: Accepted
- **Date**: 2026-03-07
- **Authors**: Jakub

## Context

The Drafto mobile app needs offline-first capability: users must be able to read and write notes without an internet connection, with changes syncing to Supabase when connectivity returns. The app uses WatermelonDB (chosen in ADR-0009) as its local SQLite database. This ADR documents the sync strategy — how local and remote data stay in sync, how conflicts are resolved, and how the sync adapter bridges WatermelonDB with Supabase.

Key constraints:

- Supabase is the source of truth (web app reads/writes directly to it)
- Multiple devices may edit the same data (web + mobile, or multiple mobile devices)
- The sync mechanism must handle creates, updates, and deletes for notebooks, notes, and attachments
- Notes use soft-delete (`is_trashed` flag) rather than hard delete
- Attachments are immutable once created (no update path)

## Decision

### Sync Protocol

We use WatermelonDB's built-in `synchronize()` protocol, which operates in two phases:

1. **Pull** — fetch remote changes since `lastPulledAt` and apply them locally
2. **Push** — send locally dirty records to Supabase

A custom sync adapter (`apps/mobile/src/db/sync.ts`) implements `pullChanges` and `pushChanges` callbacks against Supabase's REST API.

### Pull Strategy

- Query each Supabase table for rows where `updated_at > lastPulledAt` (or `created_at` for immutable attachments)
- On first sync (`lastPulledAt` is undefined), fetch all rows and treat them as `created`
- On incremental sync, all returned rows are treated as `updated` — WatermelonDB automatically creates records that don't exist locally when receiving "updated" records
- The pull timestamp is captured as `Date.now()` at the start of the pull to avoid missing records modified during the sync window

### Push Strategy

- Push in dependency order: notebooks first (notes depend on them), then notes, then attachments
- Created records are upserted to Supabase (handles the case where a pull already created the server record)
- Updated records are patched individually with a fresh `updated_at` timestamp
- Deleted records are hard-deleted from Supabase via `DELETE ... WHERE id IN (...)`
- Attachments are immutable — only create and delete are supported (no update path)

### Conflict Resolution: Server Wins (Last-Write-Wins)

We adopt a **server-wins** strategy:

- During pull, if the server has a newer `updated_at` than the local record, the server version overwrites the local one
- This is WatermelonDB's default behavior — pulled changes always overwrite local state
- If local changes were pushed before the pull, they are already on the server and will round-trip back
- If a conflict occurs (both local and remote modified the same record since last sync), the server version wins during pull, and the local dirty record is discarded
- A toast notification informs the user: "Note updated from another device"

This strategy is simple, predictable, and sufficient for a single-user note-taking app where conflicts are rare (typically the same user on different devices, not concurrent collaborative editing).

### Sync Triggers

Sync runs on:

- App foreground (returning from background)
- Pull-to-refresh gesture on list screens
- After local writes (debounced) when online
- Periodic background timer

### Local Schema

The WatermelonDB schema mirrors Supabase tables with these adaptations:

- All timestamps stored as epoch milliseconds (`number` type) instead of ISO strings
- `content` stored as JSON-serialized string (WatermelonDB doesn't support JSON columns)
- `remote_id` field maps the local WatermelonDB ID to the Supabase UUID
- `notebook_id` and `note_id` are indexed for efficient queries

### Data Flow

```
[User Action] -> [WatermelonDB Write (local SQLite)]
                      |
                      v
              [Record marked dirty]
                      |
                      v (when online)
              [pushChanges -> Supabase]
                      |
                      v
              [pullChanges <- Supabase]
                      |
                      v
              [Local DB updated, UI reacts via observables]
```

UI components observe WatermelonDB queries reactively — any local or synced change triggers an automatic re-render without manual refresh.

## Consequences

- **Positive**: Users can read and write offline with zero latency — all reads/writes hit local SQLite
- **Positive**: Reactive UI via WatermelonDB observables — no manual data refetching needed
- **Positive**: Simple conflict model (server-wins) avoids complex merge logic
- **Positive**: WatermelonDB handles sync state tracking (dirty flags, `lastPulledAt`) automatically
- **Positive**: Push ordering (notebooks -> notes -> attachments) respects foreign key dependencies
- **Negative**: Server-wins conflict resolution can silently discard local edits if two devices edit the same note simultaneously. Mitigated by toast notification and the fact that Drafto is single-user (conflicts are rare)
- **Negative**: No delta/field-level merge — the entire record is overwritten on conflict. Acceptable for note content (which is a single JSON blob) but means a title change can overwrite a concurrent content change
- **Negative**: Pull queries use `updated_at > lastPulledAt` which requires accurate client clocks. Mitigated by using server-relative timestamps where possible
- **Neutral**: Attachments are sync'd as metadata only — the actual file blobs are stored in Supabase Storage and downloaded on demand, not cached locally (offline attachment caching is a separate concern in Phase 6)

## Alternatives Considered

### Supabase Realtime (websocket subscriptions)

Rejected because realtime subscriptions don't work offline. WatermelonDB's pull-based sync naturally handles the offline->online transition. Realtime could supplement sync for live updates but adds complexity without replacing the need for a full sync adapter.

### CRDTs (e.g., Yjs, Automerge)

Rejected as over-engineered for a single-user app. CRDTs solve concurrent multi-user editing, which Drafto doesn't need. The added complexity (CRDT document format, storage overhead, merge semantics) isn't justified when server-wins LWW is sufficient.

### Client-wins conflict resolution

Rejected because the web app writes directly to Supabase — if the mobile client always wins, web changes could be silently lost. Server-wins ensures the most recently synced version is canonical, which aligns with the web app's behavior.

### Custom sync from scratch (without WatermelonDB sync protocol)

Rejected because WatermelonDB's `synchronize()` handles dirty tracking, batch application of changes, and error recovery. Reimplementing these would duplicate well-tested logic with no benefit.
