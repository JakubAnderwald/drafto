# 0097 — Notebook Names Are Unique per User, Enforced in the Apps and API

- **Status**: Accepted
- **Date**: 2026-11-23
- **Authors**: Jakub Anderwald, Claude

## Context

PrimeTestLab's QA report N° 11035 (Android 1.5.0) found that a user can create two notebooks with the same name (M-01). Nothing stopped it on any platform: the web API, the web sidebar, the mobile and desktop apps and the MCP tools all inserted whatever name they were given. Two notebooks called "Project Ideas" look the same in every list, the note "Move to" pickers and the search results, so the user can't tell where a note went.

The obvious fix is a unique index on `notebooks (user_id, lower(name))`. It would break several things:

- **Imports.** The Evernote and TickTick imports create a notebook per import and name it after the source. A second import of the same export would fail at its first insert.
- **The default notebook.** `ensureDefaultNotebook` creates "Notes" when a user has no notebooks. It is idempotent today, but a race between two first requests could now fail a page load instead of leaving a harmless duplicate.
- **Offline sync.** Mobile and desktop create notebooks in WatermelonDB, offline included, and push them later. Two devices can each create "Ideas" while offline. With a constraint, the second push would throw, and WatermelonDB retries the whole push on the next sync, so the device would stop syncing every change, not only that notebook, until someone renamed it by hand. The sync layer has no conflict-resolution path for a refused notebook row.
- **Existing data.** Accounts may already hold duplicates. A unique index can't be created over them without renaming user data in a migration.

## Decision

Notebook names are unique per user, ignoring case and spacing, and the apps and the API enforce it. There is no database constraint.

- **One rule.** `packages/shared/src/notebooks/notebook-name.ts` defines it once: `normalizeNotebookName` (Unicode NFC, trim, collapse inner whitespace, lower-case), `findDuplicateNotebook(name, notebooks, excludeId?)` and the message `A notebook named "<name>" already exists. Choose a different name.` Every platform uses these.
- **Renames.** A notebook never clashes with itself: on a rename the caller passes the notebook's id, so changing only the case of a name works, and a notebook may keep the name it already has even if an older duplicate exists.
- **Mobile and desktop** check the local WatermelonDB notebook list before writing. A refused name keeps the field open with the message under it.
- **Web** checks its sidebar list before sending, and `POST /api/notebooks` and `PATCH /api/notebooks/:id` read the user's notebook names and answer `409` with the message (`apps/web/src/lib/api/notebook-name-conflict.ts`). The sidebar shows the 409, and any other create or rename failure, under the field.
- **MCP** `create_notebook` and `rename_notebook` use the same server check and return the message as a tool error.
- **Unchanged paths.** Imports, `ensureDefaultNotebook` and sync pushes don't check, so they keep working exactly as before.

## Consequences

- **Positive**: The reported bug is fixed on all four platforms and the MCP server, with one definition of "same name" shared by all of them. Imports, the default-notebook bootstrap and offline sync can't fail because of a name. No migration and no change to existing users' data.
- **Negative**: The rule isn't airtight. Two creates racing each other on web, two devices creating the same name offline, a repeat import and accounts that already had duplicates can all still produce same-named notebooks. The apps tolerate them: lists, pickers and deletes all work by id. Every new create or rename path has to remember to call the check; nothing in the database will catch one that doesn't. Each web create and rename reads the user's notebook names first, one extra small query.
- **Neutral**: Code that reads notebooks must not assume names are unique.

## Alternatives Considered

- **A unique index on `(user_id, lower(name))`.** Airtight, but it breaks repeat imports and offline sync as described above, and can't be added over existing duplicates without renaming user data. Rejected.
- **A unique index plus automatic renaming ("Ideas (2)") on conflict**, in the imports and in a sync-push conflict handler. It keeps sync moving, but renames a user's notebook without asking, needs a new conflict path in both sync layers and still needs a data migration for existing duplicates. Too much risk for a minor finding. Rejected for now; it can be revisited if duplicates turn out to matter in practice.
- **Client-only checks, without the API.** Simpler, but the API and MCP tools would still accept duplicates, and web would trust a sidebar list that may be stale. Rejected.
- **Warning instead of refusing.** The report asks for duplicates to be prevented, and a warning that can be ignored doesn't fix the confusion it describes. Rejected.
