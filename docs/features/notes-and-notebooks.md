# Notes and Notebooks

**Status:** shipped  **Updated:** 2026-04-21

## What it is

Drafto organizes user content as notes inside a flat list of notebooks. Users create, rename, and delete notebooks; create, edit, move, soft-delete, restore, and permanently delete notes. Every user owns a default "Notes" notebook auto-provisioned on first visit.

## Current state

Shipped on all four platforms: web, iOS, Android, macOS.

- Notebooks are a single flat level (no nesting). Each note belongs to exactly one notebook.
- Soft delete: `DELETE /api/notes/:id` sets `is_trashed = true` and stamps `trashed_at`. Trashed notes live in a dedicated trash view and are permanently purged after 30 days by a `pg_cron` job.
- Permanent delete is available from trash via `DELETE /api/notes/:id/permanent`.
- Deleting a notebook is blocked if it contains non-trashed notes (409 with message to move or delete notes first).
- The default notebook is provisioned server-side in the App Router layout if the user has zero notebooks.
- Mobile and desktop hold a full local copy in WatermelonDB and sync via pull/push against Supabase; web reads/writes directly through the API.

## Code paths

| Concern                                  | Path                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| Initial schema (tables, RLS, triggers)   | `supabase/migrations/20260224000001_initial_schema.sql`                                      |
| Fix RLS recursion                        | `supabase/migrations/20260225000001_fix_rls_recursion.sql`                                   |
| Trash auto-cleanup cron (30 days)        | `supabase/migrations/20260302000001_trash_auto_cleanup.sql`                                  |
| Composite perf index                     | `supabase/migrations/20260416000001_perf_composite_index.sql`                                |
| Notebooks list + create                  | `apps/web/src/app/api/notebooks/route.ts`                                                    |
| Notebook rename + delete                 | `apps/web/src/app/api/notebooks/[id]/route.ts`                                               |
| Notes list + create (scoped to notebook) | `apps/web/src/app/api/notebooks/[id]/notes/route.ts`                                         |
| Note read / update / soft-delete         | `apps/web/src/app/api/notes/[id]/route.ts`                                                   |
| Trash list                               | `apps/web/src/app/api/notes/trash/route.ts`                                                  |
| Permanent delete                         | `apps/web/src/app/api/notes/[id]/permanent/route.ts`                                         |
| Default notebook provisioning            | `apps/web/src/app/(app)/layout.tsx`                                                          |
| Web sidebar + note list + trash list     | `apps/web/src/components/notebooks/notebooks-sidebar.tsx`, `apps/web/src/components/notes/`  |
| Shared types (rows, inserts, updates)    | `packages/shared/src/types/api.ts`, `packages/shared/src/index.ts`                           |
| Shared constants (title/name limits)     | `packages/shared/src/constants.ts`                                                           |
| Mobile WatermelonDB schema + models      | `apps/mobile/src/db/schema.ts`, `apps/mobile/src/db/models/note.ts`, `models/notebook.ts`    |
| Desktop WatermelonDB schema + models     | `apps/desktop/src/db/schema.ts`, `apps/desktop/src/db/models/`                               |
| Mobile/desktop sync layer                | `apps/mobile/src/db/sync.ts`, `apps/desktop/src/db/sync.ts`                                  |
| Mobile routes (notebook + note screens)  | `apps/mobile/app/notebooks/[id].tsx`, `apps/mobile/app/notes/[id].tsx`, `app/(tabs)/trash.tsx` |
| Desktop screens                          | `apps/desktop/src/screens/main.tsx`, `apps/desktop/src/components/notes/`, `components/sidebar/` |
| API unit tests                           | `apps/web/__tests__/unit/notebooks-api.test.ts`, `notebooks-id-api.test.ts`, `notes-api.test.ts`, `trash-api.test.ts`, `trash-cleanup.test.ts` |
| Web E2E                                  | `apps/web/e2e/notebooks.spec.ts`, `apps/web/e2e/notes.spec.ts`, `apps/web/e2e/cross-platform-sync.spec.ts` |
| Mobile E2E                               | `apps/mobile/e2e/02-create-notebook.yaml`, `03-create-edit-note.yaml`, `04-trash-restore.yaml` |

## Related ADRs

- [0001 — Data Model and RLS Strategy](../adr/0001-data-model-and-rls-strategy.md)
- [0002 — API Route Conventions](../adr/0002-api-route-conventions.md)
- [0010 — Offline Sync Strategy](../adr/0010-offline-sync-strategy.md)

## Cross-platform notes

- **Shared contract**: `packages/shared` owns `Database`, `NotebookRow`, `NoteRow`, and their `Insert`/`Update` variants. Every platform imports these; schema drift between Supabase and the WatermelonDB schemas is the top source of sync bugs.
- **Web** talks to Next.js route handlers which use the authenticated Supabase client. No local cache beyond a module-level `Map` in `note-editor-panel.tsx` / `note-list.tsx` fed by `use()`.
- **Mobile and desktop** share identical DB code: schema, models, and sync. The desktop `apps/desktop/src/db/` directory mirrors `apps/mobile/src/db/` — keep them in sync when touching one.
- **Trash UX** is consistent across platforms, but the 30-day purge runs only server-side; local WatermelonDB records are removed via the next sync pull.
- **Default notebook** is created only by the web layout today. Mobile and desktop assume at least one notebook exists after the user's first web visit; if a user signs up and opens mobile first, sync will still surface the default notebook once web has run (or once they create one locally).

## Modifying safely

- Invariants:
  - RLS requires `profiles.is_approved = true` for all reads/writes on notebooks, notes, attachments — unapproved users see nothing.
  - `notes.user_id` and `notes.notebook_id → notebooks.user_id` must match the authenticated user; enforced in RLS `WITH CHECK`.
  - Soft delete is the default for `DELETE /api/notes/:id`. Hard delete only goes through `/api/notes/:id/permanent`.
  - `notebooks` delete rejects non-trashed children with 409.
  - `updated_at` is maintained by the `handle_updated_at` trigger; do not set it manually.
- Tests that catch regressions:
  - `apps/web/__tests__/unit/notebooks-api.test.ts`, `notes-api.test.ts`, `trash-api.test.ts`, `trash-cleanup.test.ts`.
  - `apps/web/e2e/notebooks.spec.ts`, `notes.spec.ts`, `cross-platform-sync.spec.ts`.
  - `apps/mobile/__tests__/screens/notebooks.test.tsx`, `notes.test.tsx`.
- Files that must change together when altering the schema:
  - `supabase/migrations/` (new migration file)
  - `packages/shared/src/types/database.ts` (regenerate from Supabase)
  - `packages/shared/src/types/api.ts` (re-export types)
  - `apps/mobile/src/db/schema.ts` and `apps/desktop/src/db/schema.ts` (bump version + migration)
  - `apps/mobile/src/db/sync.ts` and `apps/desktop/src/db/sync.ts` (map new columns)
  - The matching API route(s) under `apps/web/src/app/api/`
  - MCP tool handlers in `apps/web/src/app/api/mcp/route.ts` if the change affects note or notebook shape

## Verify

```bash
# Migration safety
pnpm migration:check

# API + component tests
cd apps/web && pnpm test

# E2E (requires E2E_TEST_EMAIL / E2E_TEST_PASSWORD)
set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e -- notebooks.spec.ts notes.spec.ts

# Shared types
cd packages/shared && pnpm test

# Mobile and desktop
cd apps/mobile && pnpm test
cd apps/desktop && pnpm test
```
