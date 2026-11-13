# 0079 — The Factory Allocates Migration Versions Clear of Open PRs

- **Status**: Accepted
- **Date**: 2026-11-13
- **Authors**: Jakub Anderwald, with Claude Code

## Context

The implement prompt named a new migration `<today UTC>000001_<name>.sql`, or the version after main's newest when main already had one dated today or later. So two cards implemented on the same day took the same version: PRs #802 (issue #794) and #829 (issue #820) both added `20261111000001`.

[ADR 0077](./0077-factory-renumbers-migrations-mechanically.md) fixes such a clash at merge time. Once one PR merges, the factory renames the other's migrations in a commit a check proves is only that rename. That still costs a CI run on the second PR and a comment. And while both PRs are open, nothing sees the clash:

- `pnpm migration:check` compares a branch only with main ([ADR 0057](./0057-new-migrations-sort-after-base.md)), so both PRs pass.
- Dev keeps one row per version. If someone pushes one PR's migration to dev, the other's is skipped there without an error.

ADR 0077's alternative 4 ("allocate versions centrally when the migration is written") was planned as the next step. This ADR is that step.

## Decision

1. **The implement bundle carries the version to use.** When the issue's spec says schema changes (`spec.schemaChanges`, the form's "Schema changes?" answer), `build_implement_bundle` runs `node scripts/lib/migration-renumber.mjs next-version`. It fetches main and lists every open PR's migration files with `claimedVersions()`, the same lookup the merge-time renumber uses. Then it prints `{mainNewest, nextVersion, claimed, skipped}`.
   - `nextVersion` comes from the new pure `nextMigrationVersion({mainNames, claimed, today})` in `check-migration-order.mjs`. It is the later of `<today>000001` and main's newest + 1 (`suggestVersion`), skipping every claimed version.
   - The card's own open PR is not excluded, so a revision never gives a new migration the version of one the PR already has.
   - The bundle field is `migrations: {mainNewest, nextVersion, claimed: [{pr, file, version}]}`. `factory-bundle.mjs` keeps only claims whose file name has the strict `<14 digits>_<word chars>.sql` shape and caps the list at 200, because other PRs' file names reach the model and anyone can open a PR. The field is `null` for a card without schema changes, or when the lookup fails; a failure logs a warning and never fails the implement.
2. **The prompt uses it.** With `bundle.migrations` set, the implementer names its first new migration `<nextVersion>_<name>.sql` and any further ones with the versions after it, skipping every claimed version. With `null`, the old date rule applies.
3. **The implement post-check moves the newer PR.** A PR opened while the implementer ran can still take the same version. So after a successful implement, right after the parity post-check, `implement_migration_claim_check` runs ADR 0077's `migration_renumber_gate` on the new PR in a `claimed` mode:
   - `precheck` and `apply` get `--move-off-claimed 1`. The planner then also moves any migration this PR adds whose version an open PR **with a lower number** also adds (finding reason `claimed`), to a version clear of main, of this PR's other files and of every claimed version. Migrations that sort after it move too, so their order holds.
   - Only the newer PR moves: the older PR's own post-check found no clash, and `--watch` and `--release` never pass the mode, so an older PR is never moved off a newer one's version. A test pins that only this call site passes it.
   - Implement runs one card at a time under the loop lock, so two cards can't move at once.
   - The rename is the same proven-mechanical commit R, pushed the same way. It counts toward `migrationRenumbers`. The comment says the version was already used by open PR #<n>, instead of "after main moved". Update-branch usually doesn't apply, because the PR isn't behind main, and that's fine.
   - It never blocks the implement. A plan that needs a person, a spent cap or an error is logged and the card goes on to In Review. In this mode the gate posts no manual or cap comment: those describe the red-CI fallback, and nothing is red yet. ADR 0077's merge-time gate catches the clash once the older PR merges.
4. **`pnpm migration:check` warns locally.** On a developer's machine it also runs `migration-renumber.mjs claimed-check`. That prints a `WARN`, never an error, for each migration the branch adds whose version another open PR also adds. The branch's own PR, from `gh pr view`, is left out. The check runs only when:
   - `CI` is unset, so CI's output stays byte-identical;
   - `origin` is the drafto repo on GitHub;
   - `gh auth status` succeeds;
   - the branch adds a migration at all.

   gh calls are capped at 10 seconds each and 30 seconds in total. Any gh failure skips the check with a dim note.

## Consequences

- **Positive**:
  - Two factory cards implemented on the same day no longer pick the same version. When one slips through, the newer PR is renamed before review, not after the older one merges.
  - The rename reuses ADR 0077's verified commit, so it carries the same guarantee: only file names and the PR's own references change.
  - A developer writing a migration by hand sees the clash before pushing to dev.
- **Negative**:
  - An implement run for a schema card costs a `git fetch` and one gh call per open PR to build the bundle, and the same again in the post-check.
  - A renumber at implement time spends one of the card's `FACTORY_MAX_MIGRATION_RENUMBERS`.
  - The warning makes `pnpm migration:check` slower on a branch that adds migrations, by a few gh calls.
- **Neutral**:
  - A PR written by hand still isn't moved by the factory. Only the warning tells its author, and ADR 0077 covers factory PRs at merge time.
  - A claim from a PR whose files can't be listed is skipped, as in ADR 0077, so its versions aren't avoided that time.

## Alternatives Considered

1. **A shared counter (a file on main, or a GitHub variable) handed out per migration.** Rejected. It needs a write per allocation and a lock across machines, and a hand-written PR would still bypass it. The open PRs' own files already are the record of what's taken.
2. **Reserve versions in factory state.** Rejected. Only the Mac mini would see the reservations, and an abandoned card would hold its versions until someone cleared them.
3. **Move the older PR when a newer one collides.** Rejected. Moving whichever PR has the higher number means each PR moves at most once, and never after it was reviewed because of a newer card.
4. **Fail `pnpm migration:check` in CI on a claimed version.** Rejected. CI would go red on a PR because of another PR it can't change, and a hand-written PR would block a factory one. A local warning is enough, and the factory renames its own PRs.

## Related

- [ADR 0057: New Migrations Must Sort After the Base Branch](./0057-new-migrations-sort-after-base.md)
- [ADR 0077: The Factory Renumbers Stale Migrations Mechanically](./0077-factory-renumbers-migrations-mechanically.md)
- [ADR 0026: Dark Factory Pipeline](./0026-dark-factory-pipeline.md)
