# 0032 — Web Real-Time Sync for Externally Modified Notes

- **Status**: Accepted
- **Date**: 2026-09-06
- **Authors**: Dark factory (issue [#262](https://github.com/JakubAnderwald/drafto/issues/262))

## Context

Mobile, desktop and web all write to the same `public.notes` table, but only mobile and
desktop are offline-first: they run WatermelonDB with a sync loop that pulls remote
changes continuously. The web app had no equivalent. It read a note once, on mount, via
`GET /api/notes/[id]` behind a React `use()` + Suspense boundary, and then never
re-read it. A note edited on a phone — or in a second browser tab — kept showing stale
content in the open web editor until the user did a full page reload.

Three forces shaped the design:

1. **Two different staleness windows.** A note can go stale while the tab is in the
   foreground (user is looking at it) or while it is backgrounded (user is on their
   phone). These need different triggers: a server push for the first, a re-check on
   wake-up for the second.
2. **The editor cannot be re-suspended.** The note list and the open editor share one
   `refreshTrigger`. Bumping it re-runs the `use()` promise, which commits the Suspense
   fallback, unmounts BlockNote, and throws away caret, selection and scroll position.
   Any refresh mechanism therefore had to live _outside_ the Suspense cache key.
3. **Unsaved local edits must not be clobbered.** Autosave is debounced at 500 ms, so
   there is always a window in which the browser holds writes the server has not seen.
   Silently replacing the editor's content in that window is data loss.

## Decision

Add a client-side watcher, `useNoteSync`, that multiplexes two signals into a single
reconciliation handler owned by `note-editor-panel.tsx`.

**Signals**

- A Supabase Realtime `postgres_changes` subscription on `public.notes`, filtered to
  `id=eq.<open-note-id>`, listening for `*` (UPDATE covers edits _and_ soft-trash;
  DELETE covers permanent deletion). This requires registering the table with the
  `supabase_realtime` publication — migration
  `20260906000001_enable_notes_realtime.sql`.
- `visibilitychange` / `focus` listeners that re-check when the tab wakes up.

**Realtime is a signal, never a source of truth.** The payload is not read for content:
an unchanged TOASTed `content` column is omitted from the WAL record entirely, and
oversized records are stripped. Every signal triggers the same authoritative
`GET /api/notes/[id]`. The useful consequence is that the feature _degrades_ rather than
breaks — with the publication unavailable, the wake-up path still satisfies three of the
four acceptance criteria.

**Echo suppression by watermark.** The panel's own autosave PATCH bumps `updated_at` and
so round-trips as a Realtime UPDATE. The hook keeps a monotonic `updated_at` watermark —
seeded from the rendered snapshot and the last save's response — and drops anything at or
behind it. This also absorbs duplicate and out-of-order delivery. Because PostgREST
serialises `timestamptz` as ISO-8601 (`...T12:00:00.000+00:00`) while Realtime forwards
the raw Postgres text form (`... 12:00:00+00`), the watermark compares **epoch
milliseconds**, never strings — `src/lib/timestamps.ts` exists solely for this. Compared
lexically, a space sorts before `T`, so a genuinely newer Realtime timestamp looks
_older_ than an ISO watermark and the change would be silently swallowed.

**Dirty-aware reconciliation.** `useAutoSave` now exposes `hasPendingChanges` and
`cancelPendingSave`. When the editor is clean, an external change is applied by
refetching and remounting BlockNote via a `contentEpoch` in its `key`. When the editor is
dirty, the change is _not_ applied; an inline `NoteSyncBanner` offers "Discard mine" /
"Keep mine". Discarding calls `cancelPendingSave()` first, so the queued PATCH cannot
land after the reload and re-clobber the content just pulled in.

**Lifecycle.** An external soft-trash keeps the editor mounted and autosave running —
`PATCH` has no `is_trashed` guard, so in-flight edits still land in the trashed row and
are recoverable by restoring it; cancelling there would be the data loss. A hard delete
cancels pending saves and removes the editor. `GET /api/notes/[id]` now returns
`is_trashed` so the panel can tell the two apart.

## Consequences

- **Positive**: all four acceptance criteria met without a page reload; cross-tab is
  covered by the same server-backed path as cross-device, so no separate
  `BroadcastChannel` is needed; the feature degrades to focus-refresh if Realtime is
  unavailable; no new infrastructure cost — Supabase Realtime is included in the free
  tier already in use.
- **Negative**: enabling Realtime is a migration, so the change trips the factory's
  `migration-approved` gate despite the issue declaring "schema changes: no" (true of
  columns, not of publications). Applying an external change remounts the editor, which
  resets caret and scroll — acceptable only because it is gated on the dirty check. The
  no-clobber criterion required a small UI affordance, which is a mild tension with the
  issue's "no new UI surface".
- **Neutral**: one open note means one Realtime channel per tab. `REPLICA IDENTITY` is
  deliberately left at the default (primary key) rather than `FULL` — see below.

## Alternatives Considered

- **`REPLICA IDENTITY FULL` on `notes`.** Would put the whole old row in the WAL on every
  UPDATE — i.e. on every autosave — and `notes.content` is jsonb that TOASTs past ~2 KB.
  That is a large, permanent write-amplification cost on free-tier Postgres, and it buys
  nothing: `id` is the primary key and therefore already the default replica identity, so
  `filter: id=eq.<uuid>` matches DELETE events regardless.
- **Polling `GET /api/notes/[id]` on an interval.** Simple and migration-free, but either
  wastes requests when nothing changes or lags visibly when something does. Kept as the
  documented fallback if the publication is ever unavailable.
- **`BroadcastChannel` between tabs.** Solves only the same-browser case, and the
  server-backed Realtime path already covers it. Rejected as redundant.
- **Reading content straight from the Realtime payload.** Would avoid the extra GET, but
  is unreliable by design: TOASTed unchanged columns are absent from the WAL record and
  oversized records are dropped, so the payload cannot be trusted as the note's content.
- **Full CRDT / operational transform.** Would merge concurrent edits instead of asking
  the user to choose. Explicitly out of scope for this issue, and a much larger change to
  the storage model; the watermark + prompt approach meets the stated criterion that a
  local edit is never overwritten _without the user being aware_.
