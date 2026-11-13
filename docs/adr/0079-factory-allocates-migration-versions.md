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

1. **The implement bundle carries the versions to use.** When the issue's spec says schema changes (`spec.schemaChanges`, the form's "Schema changes?" answer), `build_implement_bundle` runs `node scripts/lib/migration-renumber.mjs next-version`. On a revision it adds `--own-pr <n>`, the card's PR. It fetches main and lists every open PR's migration files with `claimedVersions()`, the same lookup the merge-time renumber uses. Then it prints `{mainNewest, ownNewest, versions, claimed, skipped}`.
   - A PR claims a version only with a file it adds or renames to: the files API's `added` and `renamed` statuses (a rename by its new name), directly under `supabase/migrations/` as `<version>_<name>.sql`. A PR that edits or deletes one of main's migrations claims nothing.
   - `versions` are five versions in order, from the new pure `allocateMigrationVersions({mainNames, ownNames, claimed, today, count})` in `check-migration-order.mjs`. They are strictly increasing. Each is after main's newest, after the newest migration the card's own PR adds (`ownNewest`), and after `<today>000000`, and none is a version another open PR claims. Code works them out, so the implementer never does.
   - The own PR's files aren't claims. Its newest raises the floor instead, so a revision's new migration never reuses or sorts before one the PR already has. If the own PR's files can't be listed, `next-version` fails, because the floor would be unknown. It also fails once the whole sweep passes a 60-second budget (each call is capped at 20 seconds and at what's left), because it runs inside the factory's loop lock; the bundle field is then null and the implementer falls back to the date rule.
   - `claimed` leaves out claims at or below main's newest: no new version can take them.
   - The bundle field is `migrations: {mainNewest, ownNewest, versions, claimed: [{pr, file, version}]}`. `factory-bundle.mjs` keeps only claims whose file name has the strict `<14 digits>_<word chars>.sql` shape, because other PRs' file names reach the model and anyone can open a PR. It drops claims at or below main's newest, then caps the list at 200, so old claims can't crowd out live ones. The field is `null` for a card without schema changes, when `versions` isn't a non-empty, strictly increasing list of 14-digit versions, or when the lookup fails. A failure logs a warning and never fails the implement. If the bundle can't be rebuilt with the field, the first bundle (field `null`) is used, with a warning.
2. **The prompt uses them.** With `bundle.migrations` set, the implementer names its new migrations with `versions` in order: the first new migration gets `versions[0]`, the second `versions[1]`, and so on. It never works a version out itself. If it needs more than the list has, it continues from the last one + 1 and leaves any clash to the post-check. With `null`, the old date rule applies.
3. **The implement post-check moves the PR off other PRs' versions.** An implementer can still ignore the versions or run past the list. So after a successful implement, right after the parity post-check, `implement_migration_claim_check` runs ADR 0077's `migration_renumber_gate` on the PR in a `claimed` mode. `precheck` and `apply` get `--move-off-claimed 1`, and the planner moves (finding reason `claimed`):
   - any migration the PR adds whose version an open PR **with a lower number** also adds;
   - any migration **this run added** whose version **any** open PR adds. `--new-since <sha>` names the PR head before the run (`PRE_HEAD_OID`), and the run's migrations are the ones `git diff --diff-filter=A <sha> <head>` adds. A brand-new PR passes `--new-since all`: every migration it adds is the run's.

   Each moves to a version clear of main, of this PR's other files and of every claimed version. Migrations that sort after it move too, so their order holds.
   - A migration that was already on the PR moves only off an older PR's version. A migration the run just added moves off a newer PR's too, because nobody has reviewed it yet. `--watch` and `--release` pass neither flag, so they never move a PR off another open PR's version. A test pins that only this call site passes them.
   - The post-check reuses what bash already has. On a revision it renames on `POST_HEAD_OID`, the head read to check the run pushed; a fresh PR's head is read once. It passes the bundle's claims as `--claimed-json`, so the open PRs aren't listed again, but only when the bundle says it kept all of them (`claimedComplete`). The bundle shapes the list for the model, and drops a claim with an odd name, a version that isn't 14 digits, or one past the 200 cap; then, or without claims in the bundle, precheck sweeps them.
   - Implement runs one card at a time under the loop lock, so two cards can't move at once.
   - The rename is the same proven-mechanical commit R, pushed the same way. The comment says which open PR already used the version, instead of "after main moved". Update-branch usually doesn't apply, because the PR isn't behind main, and that's fine.
   - It doesn't read or spend `migrationRenumbers`. One post-check per implement run bounds it, and the merge-time renumbers keep their whole `FACTORY_MAX_MIGRATION_RENUMBERS` budget.
   - It never blocks the implement. A plan that needs a person or an error is logged and the card goes on to In Review. In this mode the gate posts no manual comment: that comment describes the red-CI fallback, and nothing is red yet. ADR 0077's merge-time gate catches the clash once the other PR merges.

4. **`pnpm migration:check` warns locally.** On a developer's machine it also runs `migration-renumber.mjs claimed-check`. That prints a `WARN`, never an error, for each migration the branch adds whose version another open PR also adds. It lists the open PRs once (`gh pr list --json number,headRefName,headRefOid`) and leaves out the checkout's own PR: the one whose head branch is the current branch, or whose head commit is `HEAD`, so a detached `HEAD` still finds it. The check runs only when:
   - `CI` is unset, so CI's output stays byte-identical;
   - `DRAFTO_UNATTENDED` is unset. The factory, support and nightly scripts export it, and their claude runs inherit it. The factory checks its PRs after each implement run, so the sweep would only repeat that;
   - `origin` is the drafto repo on GitHub;
   - `gh auth status` succeeds;
   - the branch adds a migration at all.

   Each gh call gets 10 seconds, and the whole lookup 30. Once the 30 are spent it reads no more PRs and prints one note: `gave up after 30s; checked <k> of <n> open PRs`. Any other gh failure skips the check with a dim note.

## Consequences

- **Positive**:
  - Two factory cards implemented on the same day no longer pick the same version. When one slips through, the PR is renamed before review, not after the other one merges.
  - A revision's new migration sorts after the PR's own, with no arithmetic in the prompt.
  - The rename reuses ADR 0077's verified commit, so it carries the same guarantee: only file names and the PR's own references change.
  - A developer writing a migration by hand sees the clash before pushing to dev.
- **Negative**:
  - An implement run for a schema card costs a `git fetch` and one gh call per open PR to build the bundle, and another fetch in the post-check.
  - The post-check plans with the claims the bundle had. A PR opened by hand while the implementer ran isn't seen until ADR 0077's merge-time gate.
  - The warning makes `pnpm migration:check` slower on a branch that adds migrations, by a few gh calls.
- **Neutral**:
  - A PR written by hand still isn't moved by the factory. Only the warning tells its author, and ADR 0077 covers factory PRs at merge time.
  - A claim from a PR whose files can't be listed is skipped, as in ADR 0077, so its versions aren't avoided that time.

## Alternatives Considered

1. **A shared counter (a file on main, or a GitHub variable) handed out per migration.** Rejected. It needs a write per allocation and a lock across machines, and a hand-written PR would still bypass it. The open PRs' own files already are the record of what's taken.
2. **Reserve versions in factory state.** Rejected. Only the Mac mini would see the reservations, and an abandoned card would hold its versions until someone cleared them.
3. **Move the older PR when a newer one collides.** Rejected for migrations a PR already had. Moving whichever PR has the higher number means each such migration moves at most once, and never after it was reviewed because of a newer card. A migration the implement run just added is the exception: nobody has reviewed it, so it moves off any open PR's version.
4. **Fail `pnpm migration:check` in CI on a claimed version.** Rejected. CI would go red on a PR because of another PR it can't change, and a hand-written PR would block a factory one. A local warning is enough, and the factory renames its own PRs.
5. **Count implement-time renames toward `migrationRenumbers`.** Rejected. The budget is for merge-time renumbers, which can repeat each time main moves. The post-check runs once per implement run, so it is bounded already, and spending the budget there would leave a card fewer merge-time renames.

## Related

- [ADR 0057: New Migrations Must Sort After the Base Branch](./0057-new-migrations-sort-after-base.md)
- [ADR 0077: The Factory Renumbers Stale Migrations Mechanically](./0077-factory-renumbers-migrations-mechanically.md)
- [ADR 0026: Dark Factory Pipeline](./0026-dark-factory-pipeline.md)
