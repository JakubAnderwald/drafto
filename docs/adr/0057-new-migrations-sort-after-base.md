# 0057 — New Migrations Must Sort After the Base Branch

- **Status**: Accepted
- **Date**: 2026-10-25
- **Authors**: Jakub Anderwald, with Claude Code

## Context

A Supabase migration's version is the timestamp at the front of its file name. `supabase db push` compares the local versions with the remote migration history. It refuses a local migration that sorts before the newest version the database has already applied ("Found local migration files to be inserted before the last migration on remote database"), unless it is forced with `--include-all`.

PR #646, the fix for the profile self-escalation hole in issue #457, added `20260922000001_guard_profile_privilege_columns.sql` on 2026-09-22. It stayed open for a month, and meanwhile main gained `20261020000001_explicit_data_api_grants.sql` ([ADR 0052](./0052-explicit-data-api-grants.md)). After the rebase the PR's version was older than the newest applied one, so the push needed `--include-all`. Renaming the file to a newer version wasn't cheap either, because dev had already applied the old version, and the rename would have had to be recorded in dev's migration history by hand. The PR merged on 2026-10-24, and main's history now holds that pair out of order.

Nothing caught this before a database refused it:

- `scripts/check-migration-safety.sh` (`pnpm migration:check`, [ADR 0008](./0008-production-data-safety-guardrails.md)) only looks inside files.
- CI checks out the PR at depth 1, so it has no base to compare against.
- The dark factory writes migrations unattended. Its `--release` step merges main into a PR that is behind, which is exactly when a PR's migration can fall behind main's newest. Its fix loop could not rename a file: `git mv` was not on its allow-list.

## Decision

1. **A migration a branch adds must have a version newer than every migration on its base branch.** New files are named `YYYYMMDD000001_<name>.sql` with today's date, or one past the newest when main already has a file dated today or later. This has to hold when the PR merges, not only when it was written.
2. **`pnpm migration:check` enforces it.** [`scripts/lib/check-migration-order.mjs`](../../scripts/lib/check-migration-order.mjs) runs from [`scripts/check-migration-safety.sh`](../../scripts/check-migration-safety.sh) when no file arguments are given.
   - It lists the `supabase/migrations/*.sql` files present locally but absent from the base commit's tree (`git ls-tree`). That covers committed, staged and untracked files, and CI's merge checkout, in the same way.
   - Each such file whose version is `<=` the base's newest version is an error. The error comes with a `git mv` to a free version: today's first slot or one past the base's newest, whichever is later, skipping versions already in use.
   - It judges only added files and never the order of the whole folder, so main's existing out-of-order pair, and edits to existing migrations, pass.
3. **The base is explicit in CI and `origin/main` locally.**
   - On pull requests, the `Lint & Typecheck` job checks out at depth 2. It passes `MIGRATION_BASE_REF` set to the first parent of GitHub's test merge commit, which is the exact main commit the checked tree was merged onto. The event's `pull_request.base.sha` is only logged: it is a snapshot of the payload and need not match that merge.
   - Locally, and when `MIGRATION_BASE_REF` is empty, the base is `origin/main`. With no base, or outside a git work tree, the rule is skipped with a note.
   - A `MIGRATION_BASE_REF` that doesn't resolve is an error, so CI can't skip the rule silently.
   - Branch protection requires PRs to be up to date, so CI on the final head always judges against current main.
4. **The factory can repair it.**
   - The implement prompt states the naming rule.
   - The watch fix loop may run `git fetch origin main` and `git mv supabase/migrations/<old>.sql supabase/migrations/<new>.sql`, and nothing else with `git mv`. When the check reports the order error, it renames the PR's migration to the suggested version, updates references and pushes. It then leaves a PR note for the operator about the dev repair. It never runs `supabase` itself.
5. **The repair for a rename after dev applied the old version** is documented in [`docs/operations/migrations.md`](../operations/migrations.md#renaming-a-migration-dev-already-applied): `supabase migration repair --status reverted <old>` and then `--status applied <new>`. Both only edit the migration history table, so no SQL runs again.

## Consequences

- **Positive**:
  - A stale migration version fails CI's required check with a ready-made `git mv`, instead of surfacing as a refused `supabase db push` after the PR merged.
  - Developers see the same error locally before their first push to dev, which is the last cheap moment to rename.
  - The factory's fix loop can recover from it on its own after `--release` brings main into a PR.
- **Negative**:
  - The rule only knows the base it is given. A stale local `origin/main` can miss a newer migration on GitHub, or flag a file merged from a newer main. The error's hint says to fetch.
  - Two open PRs can each pass with versions that collide or interleave. The second to merge fails once branch protection makes it update from main, which is the intended outcome but costs a rename.
  - A rename after dev has applied the old version still needs a manual `supabase migration repair`. The check makes that rare but can't remove it.
- **Neutral**:
  - Main's history keeps the one out-of-order pair from #646. Nothing rewrites applied migrations.
  - CI's `Lint & Typecheck` checkout is now at depth 2, so the job fetches one more commit.
  - The check still skips a plain push to main, where `origin/main` is the pushed commit itself and nothing counts as added.

## Alternatives Considered

1. **Require the whole folder to be in order.** Rejected: main already holds the #646 pair out of order, and renaming applied migrations is the costly step this ADR exists to avoid. Judging only added files gives the same protection for new work.
2. **Compare against `github.event.pull_request.base.sha`.** Rejected as the source of truth: it is a snapshot in the event payload, while the checked-out tree is GitHub's merge onto the base it used at that moment. The merge commit's first parent is that base by construction. The payload value is still logged for diagnosis.
3. **Rely on `supabase db push --include-all`.** Rejected: it hides the problem rather than fixing it. It applies the stale migration out of order on every database, so dev and prod can end up applying migrations in different orders, and each operator has to remember the flag.
4. **Generate versions from a central counter, or rename at merge time with a bot.** Rejected: more moving parts than a check, and a rename at merge time still leaves dev holding the old version.
5. **Rely on docs and review only.** Rejected: the factory writes and updates migrations unattended, and the failure only shows up when a database refuses the push, after the PR has merged.

## Related

- [ADR 0008: Production Data Safety Guardrails](./0008-production-data-safety-guardrails.md)
- [ADR 0026: Dark Factory Pipeline](./0026-dark-factory-pipeline.md)
- [ADR 0052: Explicit Data API Grants in Migrations](./0052-explicit-data-api-grants.md)
