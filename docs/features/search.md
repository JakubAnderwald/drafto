# Search

**Status:** shipped  **Updated:** 2026-04-21

## What it is

Cross-notebook search over the user's notes by title, body text, and notebook name. A keyboard-triggered overlay on web and desktop, a dedicated tab on mobile. Results include trashed notes, with title matches ranked first.

## Current state

Shipped on all four platforms (web, iOS, Android, macOS).

- **Web**: `GET /api/notes/search?q=...` calls the `search_notes` Postgres RPC. The search overlay debounces input at 300 ms and cancels in-flight requests via `AbortController`.
- **Mobile and desktop**: search runs entirely against the local WatermelonDB using `Q.like` across `notes.title`, `notes.content`, and joined `notebooks.name`. No network round-trip, so it works fully offline.
- **Server implementation** (web): `extract_text_from_jsonb` recursively pulls `$.**.text` from the BlockNote/TipTap JSONB and `search_notes` ILIKEs against title, extracted text, and notebook name. Results are `auth.uid()`-scoped via `security invoker`, capped at 50, ordered title-match → notebook-match → content-match → `updated_at desc`.
- **Not** `tsvector`/GIN. Plain `ILIKE` with no index — see ADR 0012 for the rationale and revisit conditions.
- Snippets: the server returns a ~100-char substring centered on the first content hit.

## Code paths

| Concern                                         | Path                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Search RPC + JSONB text extraction              | `supabase/migrations/20260314000001_search_function.sql`                       |
| Extend search to notebook titles                | `supabase/migrations/20260320000001_search_notebook_titles.sql`                |
| Web API route                                   | `apps/web/src/app/api/notes/search/route.ts`                                   |
| Web search overlay UI (debounced, cancelable)   | `apps/web/src/components/search/search-overlay.tsx`                            |
| Web overlay invocation + notebook list          | `apps/web/src/components/layout/app-shell.tsx`                                 |
| Mobile search tab screen                        | `apps/mobile/app/search.tsx`                                                   |
| Mobile search hook (WatermelonDB `Q.like`)      | `apps/mobile/src/hooks/use-search.ts`                                          |
| Desktop search overlay                          | `apps/desktop/src/components/search/search-overlay.tsx`                        |
| Desktop search hook                             | `apps/desktop/src/hooks/use-search.ts`                                         |
| Shared text extractor (parity with server RPC)  | `packages/shared/src/editor/extract-text.ts`                                   |
| Web unit test (API + validation)                | `apps/web/__tests__/unit/notes-search.test.ts`                                 |
| Web integration test (overlay)                  | `apps/web/__tests__/integration/search-overlay.test.tsx`                       |
| Web E2E                                         | `apps/web/e2e/search.spec.ts`                                                  |
| Mobile unit test                                | `apps/mobile/__tests__/hooks/use-search.test.ts`                               |
| Mobile E2E                                      | `apps/mobile/e2e/search.yaml`                                                  |
| Desktop tests                                   | `apps/desktop/__tests__/hooks/use-search.test.ts`, `__tests__/components/search-overlay.test.tsx` |

## Related ADRs

- [0012 — Search Implementation](../adr/0012-search-implementation.md)

## Cross-platform notes

- **Two implementations, one UX**: web uses a server RPC, mobile/desktop use WatermelonDB queries. Keeping result ranking visually consistent is manual — the ordering rules live in two places.
- **Offline coverage**: mobile and desktop search works offline against the local DB. Web does not — the overlay simply returns no results without network.
- **Content extraction**: the server uses `jsonb_path_query(content, 'strict $.**.text')`, mobile/desktop match against the raw JSON string with `Q.like`. A user searching for a word that only appears inside a JSON key (not a `text` value) will match on mobile/desktop but not web. This asymmetry is intentional; the canonical behavior is the server extractor.
- **Trash**: all three implementations include trashed notes in results; the UI is responsible for marking them visually.
- **Query limits**: the web API enforces `q.length <= 200`. Mobile/desktop have no length cap; empty/whitespace queries return zero results everywhere.

## Modifying safely

- Invariants:
  - `search_notes` is `security invoker` — it relies on RLS and `auth.uid()` scoping. Do not change to `security definer` without re-adding an explicit user filter.
  - Result cap: 50 rows (web). Changing this requires reviewing overlay rendering and test fixtures.
  - Rank order (titles → notebook names → content → `updated_at desc`) is user-observable and tested.
  - `extract_text_from_jsonb` must stay `immutable` to remain inlineable; breaking this will regress search latency further.
  - Mobile/desktop `sanitizeLikeString` usage prevents user input from being interpreted as `Q.like` wildcards — keep it.
- Tests that catch regressions:
  - `apps/web/__tests__/unit/notes-search.test.ts` — auth, query validation, RPC shape.
  - `apps/web/__tests__/integration/search-overlay.test.tsx` — debounce, abort, keyboard nav.
  - `apps/web/e2e/search.spec.ts`, `apps/mobile/e2e/search.yaml`.
  - `apps/mobile/__tests__/hooks/use-search.test.ts`, `apps/desktop/__tests__/hooks/use-search.test.ts`.
- Files that must change together:
  - Changing the JSONB content shape (see Editor brief) → update `extract_text_from_jsonb` in a new migration and the shared `extractTextFromContent`.
  - Adding a new searchable field (e.g., tags) → new migration for `search_notes`, new column in WatermelonDB schema, updated `use-search.ts` on mobile + desktop, updated API route response typing.
  - Switching to `tsvector`/GIN (per ADR 0012's revisit conditions) → new migration, updated RPC, update ADR with a superseding entry.

## Verify

```bash
# Apply search migrations locally (dev project)
pnpm supabase:link:dev && pnpm supabase:push

# Web unit + integration + E2E
cd apps/web && pnpm test -- notes-search search-overlay
set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e -- search.spec.ts

# Mobile (unit + Maestro)
cd apps/mobile && pnpm test -- use-search
maestro test apps/mobile/e2e/search.yaml --platform android

# Desktop
cd apps/desktop && pnpm test -- use-search search-overlay
```
