# 0048 — Local Writes Trigger a Debounced Sync

Screens no longer own sync scheduling.

- **Status**: Accepted
- **Date**: 2026-10-12
- **Authors**: Jakub Anderwald, Claude

## Context

[ADR-0010](./0010-offline-sync-strategy.md) lists "after local writes (debounced) when online" as a sync trigger, but neither native app implemented it. The `DatabaseProvider` on mobile and desktop synced on login, foreground, network reconnect, a network-error retry, and a 30 s timer when changes were pending. Everything else was left to the screens: a mobile screen called `sync()` after its own writes, and desktop screens called it from almost nowhere, so desktop edits waited for the 30 s timer.

The App Review screen recording of iOS 1.4.4 (build 47) showed what that leads to:

- **"3 pending changes" never cleared while online.** The direct cause was an attachment push that failed on every sync. `uploadSingleAttachment()` inserts the attachment row, and the push then upserted the same id again. `public.attachments` has no UPDATE RLS policy (attachments are immutable), so the upsert's `ON CONFLICT DO UPDATE` was rejected. Every later sync threw after the notes had been sent, and nothing was ever marked synced. Three things in the scheduling hid it:
  - `sync()` called while a sync was running returned at once and did nothing, so a screen's "sync after my write" was dropped whenever another sync was in flight.
  - Sync errors only went to `console.error`.
  - The Settings status never re-rendered, so "Last synced" did not move.
- **A false "A note was updated from another device" toast.** The toast counted every `conflictResolver` call. WatermelonDB calls it for every pulled record that differs from its local copy, including the echo of the device's own push: the server stamps a new `updated_at` and returns `content` as jsonb with its keys re-sorted.
- **"Saved" on a new note before any typing.** TenTap answers the initial load with a content-update, and mobile's autosave wrote it back. Desktop had fixed this in #654 but still showed "Saved" for the skipped save.

## Decision

1. **The `DatabaseProvider` owns sync scheduling.** It subscribes to `database.withChangesForTables(["notebooks", "notes", "attachments"])`. A local edit is a change to a record that is not `synced`, except an attachment update, which is the upload queue rewriting `upload_status` and is never pushed (`hasLocalEdit` in `packages/shared/src/sync/local-edit.ts`). It restarts a 1.5 s debounce. When the debounce fires, the provider refreshes the pending count, then syncs if anything is unsynced, the device is online, and the identity guard has cleared (and, on desktop, the user is approved).
   - A sync's own writes leave records `synced`, so they never schedule another sync. A clean sync leaves nothing pending, so the trigger cannot loop.
   - A local edit committed while a sync is running does not start a timer. Instead, the running sync makes another pass if that edit is still unpushed afterwards, up to three extra passes. An edit the run could not cover (it landed after the pass checked, or past the cap) restarts the debounce once the run succeeds.
   - A failed pass reschedules nothing. After a partly failed push, the notes it already pushed come back in every pull and look like local edits, so rescheduling would loop.
2. **`sync()` joins a running sync instead of dropping the call.** It returns the running promise, and the run makes another pass only if something is still unpushed after the current one, so the caller's write is covered without a back-to-back sync for nothing. A failed pass ends the run: the network retry timer, or the next trigger, tries again. `sync()` never rejects. The failure is exposed as `lastSyncError`, and the sync status shows "Sync failed" and re-renders every 10 s.
   - A run belongs to the session (signed-in user, and on desktop their approval) that started it. When the user changes, the provider forgets it: the next user's `sync()` starts its own run, and the old one settles without reporting into the new session. `resetSyncState()` already does this for `syncDatabase()`'s module-level latch.
   - Desktop uploads attachments after `synchronize()`, so an upload leaves its attachment dirty. A pass that uploaded something makes one more pass so the pending count clears.
3. **Screens no longer need to schedule syncs.** New code writes to WatermelonDB and lets the provider push it. Mobile's existing screen-level `sync()` calls after writes stay in place: they now join a running sync instead of being dropped, and only run when something was written. Pull to refresh and the manual sync button call `sync()` because a user asked for it.
4. **The attachment push inserts with `ON CONFLICT DO NOTHING`** (`upsert(rows, { onConflict: "id", ignoreDuplicates: true })`), both in the sync push and in `uploadSingleAttachment()`. That needs only the existing INSERT policy, so there is no migration.
5. **The toast counts visible remote changes, not resolver calls.** `isVisibleRemoteChange` in `packages/shared/src/sync/remote-change.ts` counts a pulled record only when the resolved record differs from the local one in a column the user sees:
   - notebooks: `name`
   - notes: `title`, `content` (compared with the key-order-insensitive `sameStoredContent`), `notebook_id`, `is_trashed`
   - attachments: never

   The result is renamed from `conflictCount` to `remoteChangeCount`.

6. **Autosave reports skipped saves.** The note-content guard from #654 (`content-save-guard.ts`) moves to `packages/shared/src/editor/` and mobile now uses it too. A save handler resolves `false` when it wrote nothing, and `useAutoSave` then shows `"idle"` rather than `"saved"`. Mobile only calls `sync()` after a write that happened.

## Consequences

- **Positive**:
  - Every mobile user who attached a photo had a sync that failed every time until they signed out. That is fixed without a database migration.
  - Desktop edits reach the server within about 1.5 s instead of up to 30 s.
  - The "updated from another device" toast and the "Saved" label now mean what they say.
  - A failing sync is visible in Settings instead of only in a console.
  - Scheduling has one owner, so new screens cannot forget to sync, and they cannot double-sync either.
- **Negative**:
  - A real conflict, where both devices edited the same column, no longer raises the toast. WatermelonDB keeps the local value of every column the device changed since its last push, so the resolved record matches the local one, and the next push overwrites the other device's edit. The old counter flagged that, but it also flagged every echo of the device's own push, so the signal was noise. Detecting true conflicts needs the server's previous `updated_at`, which the local schema does not keep.
  - The provider is more involved: a debounce timer, a join-and-rerun loop and a follow-up cap. All of it is covered by `__tests__/providers/database-provider.test.tsx` on both platforms.
- **Neutral**:
  - The 30 s periodic sync, the foreground and reconnect triggers and the network-error backoff are unchanged. They remain the safety net when the local-edit trigger is skipped, for example offline or after a failed sync.

## Alternatives Considered

- **Add an UPDATE policy on `public.attachments`.** That would let the duplicate upsert succeed, but it would make immutable rows mutable by their owner and needs a production migration behind the migration gate. `ON CONFLICT DO NOTHING` says what is meant: the row already exists, so leave it.
- **Keep scheduling in the screens and fix the dropped calls only.** Desktop would still wait up to 30 s, and every new screen would have to remember to call `sync()`.
- **Trigger on every database change.** A sync's own pull and mark-as-synced writes would then schedule the next sync. After a partially failed push, re-pulling the already-pushed notes produced a change on every pass, which is an endless loop.
- **Count only resolver calls for locally dirty records.** A dirty record and the echo of its previous push look exactly like a real conflict to the resolver, so this would keep the false toast for the most common case: editing again shortly after a save.
